import type { FastifyInstance } from 'fastify';
import {
  getAiSettings,
  saveAiSettings,
  maskKey,
  AI_DEFAULTS,
  type AiProvider,
  type AiSettings,
} from '../../domain/aiSettings';
import { generateText } from '../../lib/ai';

interface SaveBody {
  provider: AiProvider;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

export async function aiRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/ai/settings', async () => {
    const s = await getAiSettings();
    if (!s) return { configured: false, defaults: AI_DEFAULTS };
    return {
      configured: true,
      provider: s.provider,
      model: s.model,
      baseUrl: s.baseUrl,
      apiKeyMasked: maskKey(s.apiKey),
      defaults: AI_DEFAULTS,
    };
  });

  app.put('/api/ai/settings', async (req, reply) => {
    const b = req.body as SaveBody;
    if (!b.provider) {
      reply.code(400).send({ error: 'provider is required' });
      return;
    }

    const existing = await getAiSettings();
    const apiKey = b.apiKey ? b.apiKey : existing?.apiKey ?? '';
    if (!apiKey) {
      reply.code(400).send({ error: 'apiKey is required' });
      return;
    }

    const settings: AiSettings = {
      provider: b.provider,
      apiKey,
      model: b.model || AI_DEFAULTS[b.provider].model,
      baseUrl: b.baseUrl || AI_DEFAULTS[b.provider].baseUrl,
    };
    await saveAiSettings(settings);
    return { ok: true, apiKeyMasked: maskKey(apiKey) };
  });

  app.post('/api/ai/test', async (req, reply) => {
    const s = await getAiSettings();
    if (!s || !s.apiKey) {
      reply.code(400).send({ error: 'AI settings not configured. Set it in Settings → AI.' });
      return;
    }
    try {
      const out = await generateText(s, 'You are a test assistant.', 'Reply with exactly: OK');
      return { ok: true, reply: (out || '').slice(0, 200) };
    } catch (err) {
      reply.code(502).send({ error: (err as Error).message });
    }
  });
}
