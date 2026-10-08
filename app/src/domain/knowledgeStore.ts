import { randomUUID } from 'node:crypto';
import { redis } from '../queue/connection';
import { REDIS_KEYS } from '../config/constants';

export interface KnowledgeDoc {
  id: string;
  name: string;
  content: string;
  createdAt: number;
}

export interface KnowledgeSummary {
  id: string;
  name: string;
  size: number;
  createdAt: number;
  snippet: string;
}

export async function addKnowledge(name: string, content: string): Promise<KnowledgeDoc> {
  const doc: KnowledgeDoc = { id: randomUUID(), name, content, createdAt: Date.now() };
  await redis
    .multi()
    .sadd(REDIS_KEYS.knowledgeIndex(), doc.id)
    .set(REDIS_KEYS.knowledgeDoc(doc.id), JSON.stringify(doc))
    .exec();
  return doc;
}

export async function listKnowledge(): Promise<KnowledgeSummary[]> {
  const ids = await redis.smembers(REDIS_KEYS.knowledgeIndex());
  const docs = await Promise.all(
    ids.map(async (id) => {
      const raw = await redis.get(REDIS_KEYS.knowledgeDoc(id));
      if (!raw) return null;
      try {
        const d = JSON.parse(raw) as KnowledgeDoc;
        return { id: d.id, name: d.name, size: d.content.length, createdAt: d.createdAt, snippet: d.content.slice(0, 160).replace(/\s+/g, ' ').trim() };
      } catch {
        return null;
      }
    })
  );
  return docs.filter((d): d is KnowledgeSummary => d !== null);
}

export async function getAllKnowledge(): Promise<KnowledgeDoc[]> {
  const ids = await redis.smembers(REDIS_KEYS.knowledgeIndex());
  const docs = await Promise.all(
    ids.map(async (id) => {
      const raw = await redis.get(REDIS_KEYS.knowledgeDoc(id));
      if (!raw) return null;
      try {
        return JSON.parse(raw) as KnowledgeDoc;
      } catch {
        return null;
      }
    })
  );
  return docs.filter((d): d is KnowledgeDoc => d !== null);
}

export async function deleteKnowledge(id: string): Promise<void> {
  await redis
    .multi()
    .srem(REDIS_KEYS.knowledgeIndex(), id)
    .del(REDIS_KEYS.knowledgeDoc(id))
    .exec();
}
