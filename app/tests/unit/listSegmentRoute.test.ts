import { describe, expect, it, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

vi.mock('../../src/domain/listStore', () => ({
  createList: vi.fn(),
  listLists: vi.fn(),
  getList: vi.fn(),
  saveListResult: vi.fn(),
  deleteList: vi.fn(),
}));
vi.mock('../../src/domain/aiSettings', () => ({ getAiSettings: vi.fn() }));
vi.mock('../../src/domain/knowledgeStore', () => ({ getAllKnowledge: vi.fn() }));
vi.mock('../../src/domain/retrieval', () => ({ retrieveContext: vi.fn() }));
vi.mock('../../src/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../src/lib/ai', () => ({
  generateJson: vi.fn(),
  AiJsonError: class AiJsonError extends Error {
    constructor(message = 'The AI returned incomplete or malformed JSON.') {
      super(message);
      this.name = 'AiJsonError';
    }
  },
}));

import { listRoutes } from '../../src/api/routes/lists';
import { getList, saveListResult } from '../../src/domain/listStore';
import { getAiSettings } from '../../src/domain/aiSettings';
import { getAllKnowledge } from '../../src/domain/knowledgeStore';
import { retrieveContext } from '../../src/domain/retrieval';
import { AiJsonError, generateJson } from '../../src/lib/ai';

const getListMock = getList as unknown as ReturnType<typeof vi.fn>;
const saveListResultMock = saveListResult as unknown as ReturnType<typeof vi.fn>;
const getAiSettingsMock = getAiSettings as unknown as ReturnType<typeof vi.fn>;
const getAllKnowledgeMock = getAllKnowledge as unknown as ReturnType<typeof vi.fn>;
const retrieveContextMock = retrieveContext as unknown as ReturnType<typeof vi.fn>;
const generateJsonMock = generateJson as unknown as ReturnType<typeof vi.fn>;

const list = {
  id: 'list1',
  name: 'Webinar list',
  content: 'Email,Name\nada@example.com,Ada\ngrace@example.com,Grace',
  criteria: 'Seniority',
  createdAt: 1,
  updatedAt: 1,
};

async function build(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(listRoutes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  getListMock.mockResolvedValue(list);
  saveListResultMock.mockResolvedValue(undefined);
  getAiSettingsMock.mockResolvedValue({ provider: 'openai', apiKey: 'key', model: 'gpt-4o-mini' });
  getAllKnowledgeMock.mockResolvedValue([]);
  retrieveContextMock.mockReturnValue('');
  generateJsonMock.mockResolvedValue({
    segments: [
      { name: 'Hot', reason: 'Senior', rowIndexes: [0] },
      { name: 'Warm', reason: 'Everyone else', rowIndexes: [1] },
    ],
  });
});

describe('POST /api/lists/:id/segment', () => {
  it('sends numbered rows and saves the reconstructed segments', async () => {
    const app = await build();

    const res = await app.inject({ method: 'POST', url: '/api/lists/list1/segment' });

    expect(res.statusCode).toBe(200);
    expect(res.json().result).toEqual({
      segments: [
        { name: 'Hot', reason: 'Senior', rows: ['ada@example.com,Ada'] },
        { name: 'Warm', reason: 'Everyone else', rows: ['grace@example.com,Grace'] },
      ],
    });
    expect(saveListResultMock).toHaveBeenCalledWith('list1', res.json().result);

    const [, system, prompt, options] = generateJsonMock.mock.calls[0];
    expect(system).toContain('rowIndexes');
    expect(prompt).toContain('0: "ada@example.com,Ada"');
    expect(prompt).not.toContain('Email,Name');
    expect(options).toEqual({ maxTokens: 8192, jsonMode: true });
    await app.close();
  });

  it('returns a clear message when the AI response is not valid JSON', async () => {
    generateJsonMock.mockRejectedValue(new AiJsonError());
    const app = await build();

    const res = await app.inject({ method: 'POST', url: '/api/lists/list1/segment' });

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain('incomplete segmentation');
    expect(res.json().error).not.toContain('Expected');
    expect(saveListResultMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns a clear message when the AI returns no usable indexes', async () => {
    generateJsonMock.mockResolvedValue({ segments: [] });
    const app = await build();

    const res = await app.inject({ method: 'POST', url: '/api/lists/list1/segment' });

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain('incomplete segmentation');
    expect(saveListResultMock).not.toHaveBeenCalled();
  });

  it('rejects a list above the AI row limit before calling the provider', async () => {
    const content = Array.from({ length: 2001 }, (_, i) => `person${i}@example.com`).join('\n');
    getListMock.mockResolvedValue({ ...list, content });
    const app = await build();

    const res = await app.inject({ method: 'POST', url: '/api/lists/list1/segment' });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('2000');
    expect(generateJsonMock).not.toHaveBeenCalled();
    expect(saveListResultMock).not.toHaveBeenCalled();
  });

  it('keeps the provider error available when the request itself fails', async () => {
    generateJsonMock.mockRejectedValue(new Error('401 unauthorized'));
    const app = await build();

    const res = await app.inject({ method: 'POST', url: '/api/lists/list1/segment' });

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain('401 unauthorized');
    expect(saveListResultMock).not.toHaveBeenCalled();
  });
});
