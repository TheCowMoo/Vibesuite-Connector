import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Campaign } from '../../src/domain/campaign';

vi.mock('../../src/domain/campaignStore', () => ({
  acquireCampaignTestCopyLock: vi.fn(),
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

vi.mock('../../src/api/middleware/requireAuth', () => ({
  getAuthUser: vi.fn(() => ({ name: 'Nate', email: 'nate@example.com' })),
  requireRole: vi.fn(() => async () => {}),
}));

import { campaignRoutes } from '../../src/api/routes/campaigns';
import { getCampaign } from '../../src/domain/campaignStore';
import { collectCampaignCrm } from '../../src/domain/campaignCrmCollect';
import { deleteCampaignCrmNote, saveCampaignCrmNote } from '../../src/domain/campaignNotesStore';

const getCampaignMock = getCampaign as unknown as ReturnType<typeof vi.fn>;
const collectMock = collectCampaignCrm as unknown as ReturnType<typeof vi.fn>;
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
  getCampaignMock.mockResolvedValue(campaign);
  collectMock.mockResolvedValue(crmResponse());
  saveNoteMock.mockResolvedValue({ followUp: 'todo', note: 'Call her', updatedAt: 1, updatedBy: 'Nate' });
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
