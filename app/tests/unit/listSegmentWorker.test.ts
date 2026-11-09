import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../src/config/env', () => ({
  env: {
    LIST_SEGMENT_BATCH_SIZE: 2,
    LIST_SEGMENT_TAXONOMY_SAMPLE: 2,
    LIST_SEGMENT_AI_CONCURRENCY: 1,
  },
}));
vi.mock('../../src/lib/ai', () => ({ generateJson: vi.fn() }));
vi.mock('../../src/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }));
vi.mock('../../src/domain/aiSettings', () => ({ getAiSettings: vi.fn() }));
vi.mock('../../src/domain/knowledgeStore', () => ({ getAllKnowledge: vi.fn() }));
vi.mock('../../src/domain/retrieval', () => ({ retrieveContext: vi.fn() }));
vi.mock('../../src/domain/listStore', () => ({ getList: vi.fn(), saveListResult: vi.fn() }));
vi.mock('../../src/domain/listSegmentStore', () => ({
  getListSegmentStatus: vi.fn(),
  updateListSegmentStatus: vi.fn(),
  saveListSegmentStatus: vi.fn(),
  getListSegmentBatches: vi.fn(),
  saveListSegmentBatch: vi.fn(),
  deleteListSegmentBatches: vi.fn(),
}));

import { processListSegmentation } from '../../src/workers/listSegment';
import { generateJson } from '../../src/lib/ai';
import { getAiSettings } from '../../src/domain/aiSettings';
import { getAllKnowledge } from '../../src/domain/knowledgeStore';
import { retrieveContext } from '../../src/domain/retrieval';
import { getList, saveListResult } from '../../src/domain/listStore';
import {
  deleteListSegmentBatches,
  getListSegmentBatches,
  getListSegmentStatus,
  saveListSegmentBatch,
  saveListSegmentStatus,
  updateListSegmentStatus,
  type ListSegmentationStatus,
} from '../../src/domain/listSegmentStore';

const generateJsonMock = generateJson as unknown as ReturnType<typeof vi.fn>;
const getAiSettingsMock = getAiSettings as unknown as ReturnType<typeof vi.fn>;
const getAllKnowledgeMock = getAllKnowledge as unknown as ReturnType<typeof vi.fn>;
const retrieveContextMock = retrieveContext as unknown as ReturnType<typeof vi.fn>;
const getListMock = getList as unknown as ReturnType<typeof vi.fn>;
const saveListResultMock = saveListResult as unknown as ReturnType<typeof vi.fn>;
const getStatusMock = getListSegmentStatus as unknown as ReturnType<typeof vi.fn>;
const updateStatusMock = updateListSegmentStatus as unknown as ReturnType<typeof vi.fn>;
const saveStatusMock = saveListSegmentStatus as unknown as ReturnType<typeof vi.fn>;
const getBatchesMock = getListSegmentBatches as unknown as ReturnType<typeof vi.fn>;
const saveBatchMock = saveListSegmentBatch as unknown as ReturnType<typeof vi.fn>;
const deleteBatchesMock = deleteListSegmentBatches as unknown as ReturnType<typeof vi.fn>;

let status: ListSegmentationStatus;

beforeEach(() => {
  vi.clearAllMocks();
  status = {
    status: 'queued',
    runId: 'run1',
    totalRows: 3,
    processedRows: 0,
    totalBatches: 2,
    processedBatches: 0,
    createdAt: 1,
  };
  getStatusMock.mockImplementation(async () => status);
  updateStatusMock.mockImplementation(async (_id: string, patch: Partial<ListSegmentationStatus>) => {
    status = { ...status, ...patch };
    return status;
  });
  saveStatusMock.mockImplementation(async (_id: string, next: ListSegmentationStatus) => {
    status = next;
  });
  getBatchesMock.mockResolvedValue([]);
  saveBatchMock.mockResolvedValue(undefined);
  deleteBatchesMock.mockResolvedValue(undefined);

  getListMock.mockResolvedValue({
    id: 'list1',
    name: 'Large list',
    criteria: 'Seniority',
    content: 'ada@example.com\ngrace@example.com\nalan@example.com',
    rowCount: 3,
    createdAt: 1,
    updatedAt: 1,
  });
  saveListResultMock.mockResolvedValue(undefined);
  getAiSettingsMock.mockResolvedValue({ provider: 'openai', apiKey: 'key', model: 'gpt-4o-mini' });
  getAllKnowledgeMock.mockResolvedValue([]);
  retrieveContextMock.mockReturnValue('');
});

describe('processListSegmentation', () => {
  it('builds a taxonomy, assigns batches, and saves a complete result', async () => {
    const responses = [
      { segments: [{ name: 'Hot', reason: 'Senior' }, { name: 'Warm', reason: 'Nurture' }] },
      { segments: [{ index: 0, rowIndexes: [0] }, { index: 1, rowIndexes: [1] }] },
      { segments: [{ index: 0, rowIndexes: [0] }] },
    ];
    generateJsonMock.mockImplementation(async () => responses.shift());

    await processListSegmentation('list1', 'run1');

    expect(generateJsonMock).toHaveBeenCalledTimes(3);
    expect(saveBatchMock).toHaveBeenCalledTimes(2);
    expect(saveListResultMock).toHaveBeenCalledTimes(1);
    expect(saveListResultMock.mock.calls[0][1]).toEqual({
      segments: [
        { name: 'Hot', reason: 'Senior', rows: ['ada@example.com', 'alan@example.com'] },
        { name: 'Warm', reason: 'Nurture', rows: ['grace@example.com'] },
      ],
    });
    expect(status.status).toBe('done');
    expect(status.processedRows).toBe(3);
    expect(deleteBatchesMock).toHaveBeenCalledWith('list1', 'run1');
  });

  it('resumes completed batches instead of calling the AI again', async () => {
    status.taxonomy = [{ name: 'Hot', reason: 'Senior' }];
    status.processedRows = 2;
    status.processedBatches = 1;
    getBatchesMock.mockResolvedValue([
      {
        index: 0,
        offset: 0,
        rowCount: 2,
        assignments: [{ index: 0, rowIndexes: [0, 1] }],
        warnings: [],
      },
    ]);
    generateJsonMock.mockResolvedValue({ segments: [{ index: 0, rowIndexes: [0] }] });

    await processListSegmentation('list1', 'run1');

    expect(generateJsonMock).toHaveBeenCalledTimes(1);
    expect(saveBatchMock).toHaveBeenCalledTimes(1);
    expect(saveListResultMock.mock.calls[0][1].segments[0].rows).toEqual([
      'ada@example.com',
      'grace@example.com',
      'alan@example.com',
    ]);
    expect(status.status).toBe('done');
  });
});
