import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Campaign } from '../../src/domain/campaign';
import type { CampaignStats } from '../../src/domain/campaignStats';

vi.mock('../../src/domain/campaignStore', () => ({
  acquireCampaignCopySuggestionLock: vi.fn(),
  acquireCampaignTestCopyLock: vi.fn(),
  releaseCampaignCopySuggestionLock: vi.fn(),
  countRecipients: vi.fn(),
  createCampaign: vi.fn(),
  deleteCampaign: vi.fn(),
  getCampaign: vi.fn(),
  getCampaignSender: vi.fn(),
  getRecipients: vi.fn(),
  listCampaigns: vi.fn(),
  queueLength: vi.fn(),
  saveCampaign: vi.fn(),
}));

vi.mock('../../src/domain/campaignCrmCollect', () => ({
  collectCampaignCrm: vi.fn(),
}));

vi.mock('../../src/domain/campaignNotesStore', () => ({
  deleteCampaignCrmNote: vi.fn(),
  saveCampaignCrmNote: vi.fn(),
}));

vi.mock('../../src/domain/campaignZoom', () => ({ applyCampaignZoomHost: vi.fn() }));
vi.mock('../../src/domain/zoomStore', () => ({ getZoomAccount: vi.fn() }));
vi.mock('../../src/domain/campaignDispatch', () => ({
  sendCampaignBatch: vi.fn(),
  sendCampaignTestCopy: vi.fn(),
  startCampaign: vi.fn(),
  endCampaign: vi.fn(),
}));
vi.mock('../../src/domain/senderStore', () => ({ getSenderProfile: vi.fn() }));
vi.mock('../../src/domain/listStore', () => ({ getList: vi.fn() }));
vi.mock('../../src/domain/inviteStore', () => ({ getInvitedEmails: vi.fn() }));
vi.mock('../../src/domain/audience', () => ({ buildAudience: vi.fn() }));
vi.mock('../../src/domain/campaignStatsCollect', () => ({ collectCampaignStats: vi.fn() }));
vi.mock('../../src/domain/copyPatternsCollect', () => ({ collectCopyPatterns: vi.fn() }));
vi.mock('../../src/domain/copyWebResearch', () => ({ researchCopyBestPractices: vi.fn() }));
vi.mock('../../src/domain/aiSettings', () => ({ getAiSettings: vi.fn() }));
vi.mock('../../src/domain/knowledgeStore', () => ({ getAllKnowledge: vi.fn() }));
vi.mock('../../src/domain/retrieval', () => ({ retrieveContext: vi.fn() }));
vi.mock('../../src/lib/ai', () => ({
  generateJson: vi.fn(),
  AiJsonError: class AiJsonError extends Error {},
}));

vi.mock('../../src/api/middleware/requireAuth', () => ({
  getAuthUser: vi.fn(() => ({ name: 'Nate', email: 'nate@example.com' })),
  requireRole: vi.fn(() => async () => {}),
}));

import { campaignRoutes } from '../../src/api/routes/campaigns';
import {
  acquireCampaignCopySuggestionLock,
  getCampaign,
  saveCampaign,
} from '../../src/domain/campaignStore';
import { collectCampaignCrm } from '../../src/domain/campaignCrmCollect';
import { deleteCampaignCrmNote, saveCampaignCrmNote } from '../../src/domain/campaignNotesStore';
import { collectCampaignStats } from '../../src/domain/campaignStatsCollect';
import { collectCopyPatterns } from '../../src/domain/copyPatternsCollect';
import { researchCopyBestPractices } from '../../src/domain/copyWebResearch';
import { getList } from '../../src/domain/listStore';
import { getAiSettings } from '../../src/domain/aiSettings';
import { getAllKnowledge } from '../../src/domain/knowledgeStore';
import { retrieveContext } from '../../src/domain/retrieval';
import { generateJson } from '../../src/lib/ai';

const getCampaignMock = getCampaign as unknown as ReturnType<typeof vi.fn>;
const saveCampaignMock = saveCampaign as unknown as ReturnType<typeof vi.fn>;
const collectMock = collectCampaignCrm as unknown as ReturnType<typeof vi.fn>;
const collectStatsMock = collectCampaignStats as unknown as ReturnType<typeof vi.fn>;
const collectPatternsMock = collectCopyPatterns as unknown as ReturnType<typeof vi.fn>;
const researchWebMock = researchCopyBestPractices as unknown as ReturnType<typeof vi.fn>;
const getListMock = getList as unknown as ReturnType<typeof vi.fn>;
const getAiSettingsMock = getAiSettings as unknown as ReturnType<typeof vi.fn>;
const getAllKnowledgeMock = getAllKnowledge as unknown as ReturnType<typeof vi.fn>;
const retrieveContextMock = retrieveContext as unknown as ReturnType<typeof vi.fn>;
const generateJsonMock = generateJson as unknown as ReturnType<typeof vi.fn>;
const acquireLockMock = acquireCampaignCopySuggestionLock as unknown as ReturnType<typeof vi.fn>;
const saveNoteMock = saveCampaignCrmNote as unknown as ReturnType<typeof vi.fn>;
const deleteNoteMock = deleteCampaignCrmNote as unknown as ReturnType<typeof vi.fn>;

const campaign: Campaign = {
  id: 'camp1',
  name: 'November webinar',
  status: 'active',
  listId: 'l1',
  segments: [],
  event: { summary: 'Webinar', start: '2026-11-12T10:00:00Z', end: '2026-11-12T11:00:00Z', timeZone: 'UTC' },
  senders: [{ connectionId: 'c1', enabled: true, priority: 5 }],
  distribution: { mode: 'even' },
  includeAlreadyInvited: false,
  createdAt: 1,
};

function statsFixture(): CampaignStats {
  const funnel = (overrides: Record<string, number> = {}) => ({
    invited: 0,
    queued: 0,
    sent: 0,
    failed: 0,
    accepted: 0,
    declined: 0,
    tentative: 0,
    noResponse: 0,
    attended: 0,
    noShow: 0,
    failedRate: 0,
    rsvpRate: 0,
    acceptanceRate: 0,
    responseRate: 0,
    attendanceRate: 0,
    ...overrides,
  });
  return {
    funnel: funnel({ invited: 60, sent: 60, accepted: 16, tentative: 5, declined: 4, noResponse: 35 }),
    perSender: [],
    variants: [
      {
        variant: 'A',
        ...funnel({ invited: 30, sent: 30, accepted: 9, tentative: 2, declined: 2, noResponse: 17, attended: 5, noShow: 6 }),
      },
      {
        variant: 'B',
        ...funnel({ invited: 30, sent: 30, accepted: 7, tentative: 3, declined: 2, noResponse: 18, attended: 4, noShow: 6 }),
      },
    ],
    hasAttendance: true,
  };
}

const row = {
  key: 'ada@example.com',
  email: 'ada@example.com',
  name: 'Ada Lovelace',
  walkIn: false,
  senderName: 'Ada sender',
  variant: 'A',
  sendStatus: 'sent',
  sentAt: 100,
  eventId: 'e1',
  rsvp: 'accepted',
  rsvpHistory: [{ status: 'accepted', at: 90, initial: true }],
  zoom: 'attended',
  note: { followUp: 'todo', note: 'Call her' },
};

function crmResponse() {
  return {
    campaign: {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      listId: campaign.listId,
      includeAlreadyInvited: false,
      event: campaign.event,
      senders: [],
    },
    session: null,
    summary: {
      people: 1,
      sent: 1,
      pending: 0,
      failed: 0,
      rsvp: { accepted: 1, declined: 0, tentative: 0, noReply: 0, none: 0 },
      zoom: { attended: 1, partial: 0, didntJoin: 0, walkIns: 0, notTracked: 0, notInvited: 0 },
      yesButDidntJoin: 0,
      followUp: { none: 0, todo: 1, contacted: 0, done: 0, open: 1 },
    },
    filters: { senders: [], variants: ['A'] },
    rows: [row],
    total: 1,
    offset: 0,
    limit: 50,
    warnings: [],
    hasAttendance: true,
    attendanceGeneratedAt: 80,
  };
}

async function build(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(campaignRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  getCampaignMock.mockReset();
  collectMock.mockReset();
  saveNoteMock.mockReset();
  deleteNoteMock.mockReset();
  saveCampaignMock.mockReset();
  collectStatsMock.mockReset();
  collectPatternsMock.mockReset();
  researchWebMock.mockReset();
  getListMock.mockReset();
  getAiSettingsMock.mockReset();
  getAllKnowledgeMock.mockReset();
  retrieveContextMock.mockReset();
  generateJsonMock.mockReset();
  acquireLockMock.mockReset();
  getCampaignMock.mockResolvedValue(campaign);
  collectMock.mockResolvedValue(crmResponse());
  saveNoteMock.mockResolvedValue({ followUp: 'todo', note: 'Call her', updatedAt: 1, updatedBy: 'Nate' });
  collectStatsMock.mockResolvedValue(statsFixture());
  collectPatternsMock.mockResolvedValue({
    generatedAt: 1,
    campaigns: 2,
    variants: 4,
    patterns: [],
    note: 'Observational',
  });
  researchWebMock.mockResolvedValue({
    enabled: false,
    available: false,
    sources: [],
    error: 'Web research is disabled.',
  });
  getListMock.mockResolvedValue({
    id: 'l1',
    name: 'Senior leaders',
    criteria: 'Seniority',
    content: '',
    rowCount: 1,
    createdAt: 1,
    updatedAt: 1,
  });
  getAiSettingsMock.mockResolvedValue({ provider: 'openai', apiKey: 'key', model: 'gpt-4o-mini' });
  getAllKnowledgeMock.mockResolvedValue([]);
  retrieveContextMock.mockReturnValue('Brand notes');
  acquireLockMock.mockResolvedValue(true);
  generateJsonMock.mockResolvedValue({
    suggestions: [
      {
        mode: 'rewrite',
        summary: 'A clearer webinar invitation',
        description: 'A short description for the people who should attend.',
        rationale: 'Variant A has a 30% acceptance rate in the supplied evidence.',
        evidence: ['Variant A: 30 sent, 9 accepted (30%)'],
        tradeoffs: ['The sample is still directional.'],
        confidence: 'medium',
      },
    ],
  });
});

describe('GET /api/campaigns/:id/crm', () => {
  it('passes validated filters, sort and pagination to the collector', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'GET',
      url: '/api/campaigns/camp1/crm?q=ada&rsvp=accepted&zoom=bogus&sender=c1&sort=rsvp&limit=10&offset=20',
    });
    expect(res.statusCode).toBe(200);
    expect(collectMock).toHaveBeenCalledWith(
      campaign,
      expect.objectContaining({
        q: 'ada',
        rsvp: 'accepted',
        sender: 'c1',
        sort: 'rsvp',
        limit: 10,
        offset: 20,
      }),
    );
    expect(collectMock.mock.calls[0][1].zoom).toBeUndefined();
    expect(JSON.parse(res.body).rows[0].name).toBe('Ada Lovelace');
    await app.close();
  });

  it('returns 404 when the campaign does not exist', async () => {
    getCampaignMock.mockResolvedValueOnce(null);
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/campaigns/missing/crm' });
    expect(res.statusCode).toBe(404);
    expect(collectMock).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('GET /api/campaigns/:id/crm/export', () => {
  it('exports every filtered row as a dated CSV attachment', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'GET',
      url: '/api/campaigns/camp1/crm/export?rsvp=accepted&zoom=attended',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="vibesuite-campaign-people-november-webinar-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(res.body.startsWith('\uFEFF')).toBe(true);
    expect(res.body).toContain('Campaign,Name,Email');
    expect(res.body).toContain('November webinar');
    expect(res.body).toContain('Ada Lovelace');
    expect(collectMock).toHaveBeenCalledWith(
      campaign,
      expect.objectContaining({ rsvp: 'accepted', zoom: 'attended' }),
      { paginate: false },
    );
    await app.close();
  });
});

describe('PATCH /api/campaigns/:id/crm/notes', () => {
  it('saves a campaign-scoped note with the signed-in user', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/campaigns/camp1/crm/notes',
      payload: { personKey: 'ada@example.com', followUp: 'todo', note: '  Call her  ' },
    });
    expect(res.statusCode).toBe(200);
    expect(saveNoteMock).toHaveBeenCalledWith('camp1', 'ada@example.com', {
      followUp: 'todo',
      note: 'Call her',
      updatedBy: 'Nate',
    });
    await app.close();
  });

  it('rejects an unknown follow-up state and an overlong note', async () => {
    const app = await build();
    const badState = await app.inject({
      method: 'PATCH',
      url: '/api/campaigns/camp1/crm/notes',
      payload: { personKey: 'ada@example.com', followUp: 'later', note: '' },
    });
    expect(badState.statusCode).toBe(400);
    expect(saveNoteMock).not.toHaveBeenCalled();

    const tooLong = await app.inject({
      method: 'PATCH',
      url: '/api/campaigns/camp1/crm/notes',
      payload: { personKey: 'ada@example.com', followUp: 'todo', note: 'x'.repeat(2001) },
    });
    expect(tooLong.statusCode).toBe(400);
    await app.close();
  });

  it('deletes the note when it becomes empty and clears follow-up', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/campaigns/camp1/crm/notes',
      payload: { personKey: 'ada@example.com', followUp: 'none', note: '' },
    });
    expect(res.statusCode).toBe(200);
    expect(deleteNoteMock).toHaveBeenCalledWith('camp1', 'ada@example.com');
    expect(saveNoteMock).not.toHaveBeenCalled();
    expect(JSON.parse(res.body).note).toEqual({ followUp: 'none', note: '' });
    await app.close();
  });

  it('returns 404 when the campaign does not exist', async () => {
    getCampaignMock.mockResolvedValueOnce(null);
    const app = await build();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/campaigns/missing/crm/notes',
      payload: { personKey: 'ada@example.com', followUp: 'todo', note: 'Call' },
    });
    expect(res.statusCode).toBe(404);
    expect(saveNoteMock).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('POST /api/campaigns/:id/copy-suggestions', () => {
  const copyCampaign: Campaign = {
    ...campaign,
    status: 'draft',
    copyVariants: [
      { id: 'A', summary: 'Join the November webinar', description: 'A practical session.' },
      { id: 'B', summary: 'A working session for senior leaders', description: 'Bring your questions.' },
    ],
  };

  it('returns evidence-backed suggestions without saving the campaign', async () => {
    getCampaignMock.mockResolvedValueOnce(copyCampaign);
    const app = await build();

    const res = await app.inject({
      method: 'POST',
      url: '/api/campaigns/camp1/copy-suggestions',
      payload: { mode: 'improve', objective: 'balanced', count: 2 },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.suggestions).toHaveLength(1);
    expect(body.suggestions[0]).toMatchObject({
      mode: 'rewrite',
      summary: 'A clearer webinar invitation',
      subjectChars: 28,
    });
    expect(body.evidence.variants).toHaveLength(2);
    expect(body.evidence.hasAttendance).toBe(true);
    expect(body.research).toMatchObject({ curated: true, historical: false, web: false });
    expect(body.patterns).toMatchObject({ campaigns: 2, variants: 4 });
    expect(saveCampaignMock).not.toHaveBeenCalled();

    const prompt = generateJsonMock.mock.calls[0][2] as string;
    expect(prompt).toContain('acceptanceRate');
    expect(prompt).toContain('showUpRate');
    expect(prompt).toContain('Current campaign evidence outranks general guidance');
    expect(prompt).not.toContain('ada@example.com');
    await app.close();
  });

  it('refuses to change copy after sending has started', async () => {
    getCampaignMock.mockResolvedValueOnce({ ...copyCampaign, status: 'active', startedAt: 1 });
    const app = await build();

    const res = await app.inject({
      method: 'POST',
      url: '/api/campaigns/camp1/copy-suggestions',
      payload: { mode: 'improve' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('frozen');
    expect(generateJsonMock).not.toHaveBeenCalled();
    expect(saveCampaignMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects a second request while one is running', async () => {
    getCampaignMock.mockResolvedValueOnce(copyCampaign);
    acquireLockMock.mockResolvedValueOnce(false);
    const app = await build();

    const res = await app.inject({
      method: 'POST',
      url: '/api/campaigns/camp1/copy-suggestions',
      payload: { mode: 'challenger' },
    });

    expect(res.statusCode).toBe(429);
    expect(generateJsonMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('can include cited web research when explicitly requested', async () => {
    getCampaignMock.mockResolvedValueOnce(copyCampaign);
    researchWebMock.mockResolvedValueOnce({
      enabled: true,
      available: true,
      sources: [{ id: 'web1', title: 'Copy guide', url: 'https://example.com/guide', snippet: 'Keep it clear.' }],
    });
    generateJsonMock.mockResolvedValueOnce({
      suggestions: [
        {
          mode: 'rewrite',
          summary: 'A clearer webinar invitation',
          description: 'A short description for the right people.',
          rationale: 'The source supports clarity.',
          evidence: ['Variant A: 30 sent, 9 accepted'],
          tradeoffs: [],
          confidence: 'medium',
          sourceIds: ['web1', 'not-supplied'],
        },
      ],
    });
    const app = await build();

    const res = await app.inject({
      method: 'POST',
      url: '/api/campaigns/camp1/copy-suggestions',
      payload: { mode: 'improve', researchWeb: true },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.research.web).toBe(true);
    expect(body.webResearch.sources[0].id).toBe('web1');
    expect(body.suggestions[0].sourceIds).toEqual(['web1']);
    const prompt = generateJsonMock.mock.calls[0][2] as string;
    expect(prompt).toContain('[web1] Copy guide');
    await app.close();
  });

  it('requires an AI provider', async () => {
    getCampaignMock.mockResolvedValueOnce(copyCampaign);
    getAiSettingsMock.mockResolvedValueOnce(null);
    const app = await build();

    const res = await app.inject({
      method: 'POST',
      url: '/api/campaigns/camp1/copy-suggestions',
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('AI not configured');
    await app.close();
  });
});
