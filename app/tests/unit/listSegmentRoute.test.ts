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
vi.mock('../../src/domain/listSegmentQueue', () => ({
  enqueueListSegmentation: vi.fn(),
  cancelListSegmentation: vi.fn(),
  deleteListSegmentation: vi.fn(),
  getListSegmentStatus: vi.fn(),
  getListSegmentStatuses: vi.fn(),
}));
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
import { getList, saveListResult, createList, listLists } from '../../src/domain/listStore';
import { getAiSettings } from '../../src/domain/aiSettings';
import { getAllKnowledge } from '../../src/domain/knowledgeStore';
import { retrieveContext } from '../../src/domain/retrieval';
import {
  cancelListSegmentation,
  enqueueListSegmentation,
  getListSegmentStatus,
  getListSegmentStatuses,
} from '../../src/domain/listSegmentQueue';
import { AiJsonError, generateJson } from '../../src/lib/ai';

const getListMock = getList as unknown as ReturnType<typeof vi.fn>;
const listListsMock = listLists as unknown as ReturnType<typeof vi.fn>;
const saveListResultMock = saveListResult as unknown as ReturnType<typeof vi.fn>;
const createListMock = createList as unknown as ReturnType<typeof vi.fn>;
const getAiSettingsMock = getAiSettings as unknown as ReturnType<typeof vi.fn>;
const getAllKnowledgeMock = getAllKnowledge as unknown as ReturnType<typeof vi.fn>;
const retrieveContextMock = retrieveContext as unknown as ReturnType<typeof vi.fn>;
const enqueueMock = enqueueListSegmentation as unknown as ReturnType<typeof vi.fn>;
const cancelMock = cancelListSegmentation as unknown as ReturnType<typeof vi.fn>;
const getStatusMock = getListSegmentStatus as unknown as ReturnType<typeof vi.fn>;
const getStatusesMock = getListSegmentStatuses as unknown as ReturnType<typeof vi.fn>;
const generateJsonMock = generateJson as unknown as ReturnType<typeof vi.fn>;

const list = {
  id: 'list1',
  name: 'Webinar list',
  content: 'Email,Name\nada@example.com,Ada\ngrace@example.com,Grace',
  criteria: 'Seniority',
  rowCount: 2,
  createdAt: 1,
  updatedAt: 1,
};

async function build(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 25 * 1024 * 1024 });
  await app.register(listRoutes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  getListMock.mockResolvedValue(list);
  listListsMock.mockResolvedValue([]);
  createListMock.mockResolvedValue(list);
  saveListResultMock.mockResolvedValue(undefined);
  getStatusMock.mockResolvedValue(null);
  getStatusesMock.mockResolvedValue({});
  cancelMock.mockResolvedValue(null);
  enqueueMock.mockResolvedValue({
    status: 'queued',
    runId: 'run1',
    totalRows: 2001,
    processedRows: 0,
    totalBatches: 5,
    processedBatches: 0,
    createdAt: 1,
  });
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

  it('queues lists above the inline threshold instead of calling the provider', async () => {
    const content = Array.from({ length: 2001 }, (_, i) => `person${i}@example.com`).join('\n');
    getListMock.mockResolvedValue({ ...list, content, rowCount: 2001 });
    const app = await build();

    const res = await app.inject({ method: 'POST', url: '/api/lists/list1/segment' });

    expect(res.statusCode).toBe(202);
    expect(res.json().segmentation.status).toBe('queued');
    expect(enqueueMock).toHaveBeenCalledWith('list1', 2001);
    expect(generateJsonMock).not.toHaveBeenCalled();
    expect(saveListResultMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects a list above the 50k upload limit before queueing', async () => {
    const content = Array.from({ length: 50_001 }, (_, i) => `person${i}@example.com`).join('\n');
    getListMock.mockResolvedValue({ ...list, content, rowCount: 50_001 });
    const app = await build();

    const res = await app.inject({ method: 'POST', url: '/api/lists/list1/segment' });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('50000');
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(generateJsonMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('keeps the provider error available when the request itself fails', async () => {
    generateJsonMock.mockRejectedValue(new Error('401 unauthorized'));
    const app = await build();

    const res = await app.inject({ method: 'POST', url: '/api/lists/list1/segment' });

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain('401 unauthorized');
    expect(saveListResultMock).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('GET /api/lists/:id', () => {
  it('returns counts and a preview without the raw content or full result', async () => {
    getListMock.mockResolvedValue({
      ...list,
      rowCount: 3,
      result: {
        segments: [
          { name: 'Hot', reason: 'Senior', rows: ['ada', 'grace', 'alan'] },
          { name: 'Warm', reason: 'Nurture', rows: ['lin'] },
        ],
      },
    });
    const app = await build();

    const res = await app.inject({ method: 'GET', url: '/api/lists/list1' });

    expect(res.statusCode).toBe(200);
    expect(res.json().list.content).toBeUndefined();
    expect(res.json().list.result.segments[0].count).toBe(3);
    expect(res.json().list.result.segments[0].rows).toHaveLength(3);
    expect(res.json().list.rowCount).toBe(3);
    await app.close();
  });

  it('adds background progress to list summaries', async () => {
    listListsMock.mockResolvedValue([
      { id: 'list1', name: 'Webinar list', criteria: 'Seniority', hasResult: false, rowCount: 50000, createdAt: 1, updatedAt: 2 },
    ]);
    getStatusesMock.mockResolvedValue({
      list1: {
        status: 'running',
        runId: 'run1',
        totalRows: 50000,
        processedRows: 25000,
        totalBatches: 100,
        processedBatches: 50,
        createdAt: 1,
        startedAt: 2,
      },
    });
    const app = await build();

    const res = await app.inject({ method: 'GET', url: '/api/lists' });

    expect(res.statusCode).toBe(200);
    expect(res.json().lists[0].rowCount).toBe(50000);
    expect(res.json().lists[0].segmentation.processedRows).toBe(25000);
    await app.close();
  });

  it('returns the background sort status', async () => {
    getStatusMock.mockResolvedValue({
      status: 'running',
      runId: 'run1',
      totalRows: 50000,
      processedRows: 12500,
      totalBatches: 100,
      processedBatches: 25,
      createdAt: 1,
      startedAt: 2,
    });
    const app = await build();

    const res = await app.inject({ method: 'GET', url: '/api/lists/list1/segment/status' });

    expect(res.statusCode).toBe(200);
    expect(res.json().segmentation.processedRows).toBe(12500);
    await app.close();
  });

  it('cancels a background sort', async () => {
    cancelMock.mockResolvedValue({
      status: 'cancelled',
      runId: 'run1',
      totalRows: 50000,
      processedRows: 0,
      totalBatches: 100,
      processedBatches: 0,
      createdAt: 1,
      cancelRequested: true,
    });
    const app = await build();

    const res = await app.inject({ method: 'POST', url: '/api/lists/list1/segment/cancel' });

    expect(res.statusCode).toBe(200);
    expect(cancelMock).toHaveBeenCalledWith('list1');
    expect(res.json().segmentation.status).toBe('cancelled');
    await app.close();
  });
});

describe('POST /api/lists', () => {
  it('accepts a 50,000-row upload and returns a summary', async () => {
    const content = Array.from({ length: 50_000 }, (_, i) => `person${i}@example.com`).join('\n');
    createListMock.mockResolvedValue({ ...list, content, rowCount: 50_000 });
    const app = await build();

    const res = await app.inject({
      method: 'POST',
      url: '/api/lists',
      payload: { name: 'Large', criteria: 'Intent', content },
    });

    expect(res.statusCode).toBe(200);
    expect(createListMock).toHaveBeenCalledWith('Large', content, 'Intent', 50_000);
    expect(res.json().list.content).toBeUndefined();
    expect(res.json().list.rowCount).toBe(50_000);
    await app.close();
  });

  it('rejects an upload above 50,000 rows', async () => {
    const content = Array.from({ length: 50_001 }, (_, i) => `person${i}@example.com`).join('\n');
    const app = await build();

    const res = await app.inject({
      method: 'POST',
      url: '/api/lists',
      payload: { name: 'Too large', content },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('50000');
    expect(createListMock).not.toHaveBeenCalled();
    await app.close();
  });
});
