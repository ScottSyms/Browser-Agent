import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ENC_PREFIX } from '../shared/crypto';
import type { ConversationSummary } from '../shared/types';
import {
  deleteConversation,
  getConversation,
  getConversationIndex,
  saveConversation,
  type StoredConversation,
} from './storage';
import { lockVault, setupVault, unlockVault } from './vault';

// Shared in-memory chrome.storage.local + session; `store` is inspectable so a
// test can assert what actually landed on disk (ciphertext vs plaintext).
let local: Record<string, unknown>;
let session: Record<string, unknown>;

function area(store: Record<string, unknown>) {
  return {
    async get(keys: string | string[]) {
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of list) if (k in store) out[k] = store[k];
      return out;
    },
    async set(obj: Record<string, unknown>) {
      Object.assign(store, obj);
    },
    async remove(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
    },
  };
}

beforeEach(() => {
  local = {};
  session = {};
  vi.stubGlobal('chrome', { storage: { local: area(local), session: area(session) } });
});

function convo(id: string, title: string, body: string): StoredConversation {
  return {
    id,
    title,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    messages: [{ role: 'user', text: body, timestamp: '2026-01-01T00:00:00Z' }],
    conversation: [{ role: 'user', content: body }],
  };
}

const summaryOf = (title: string, preview: string): Omit<ConversationSummary, 'id' | 'createdAt'> => ({
  title,
  updatedAt: '2026-01-02T00:00:00Z',
  messageCount: 1,
  preview,
});

describe('conversation encryption at rest', () => {
  it('no vault: stores and returns plaintext (unchanged behavior)', async () => {
    await saveConversation(convo('c1', 'Budget plan', 'secret text'), summaryOf('Budget plan', 'secret text'));
    expect(JSON.stringify(local['ba_conv_c1'])).toContain('secret text'); // plaintext on disk
    const back = await getConversation('c1');
    expect(back?.messages[0].text).toBe('secret text');
    const index = await getConversationIndex();
    expect(index[0].title).toBe('Budget plan');
  });

  it('unlocked vault: body + index are ciphertext at rest but decrypt on read', async () => {
    await setupVault('correct horse battery staple');
    await saveConversation(convo('c1', 'Layoff memo', 'confidential body'), summaryOf('Layoff memo', 'confidential body'));

    // On disk: no plaintext leaks.
    const rawBody = JSON.stringify(local['ba_conv_c1']);
    expect(rawBody).not.toContain('confidential body');
    expect(rawBody).toContain('__enc');
    const rawIndex = local['ba_conv_index'] as ConversationSummary[];
    expect(rawIndex[0].title.startsWith(ENC_PREFIX)).toBe(true);
    expect(rawIndex[0].id).toBe('c1'); // structural fields stay plaintext

    // On read: transparently decrypted.
    expect((await getConversation('c1'))?.messages[0].text).toBe('confidential body');
    const index = await getConversationIndex();
    expect(index[0].title).toBe('Layoff memo');
    expect(index[0].preview).toBe('confidential body');
  });

  it('locked vault: body is null and index shows a placeholder title', async () => {
    await setupVault('pw');
    await saveConversation(convo('c1', 'Secret', 'body'), summaryOf('Secret', 'body'));
    await lockVault();

    expect(await getConversation('c1')).toBeNull();
    const index = await getConversationIndex();
    expect(index[0].title).toBe('🔒 Locked');
    expect(index[0].id).toBe('c1'); // still listable

    await unlockVault('pw');
    expect((await getConversation('c1'))?.messages[0].text).toBe('body');
    expect((await getConversationIndex())[0].title).toBe('Secret');
  });

  it('deleting one conversation while locked does not clobber another\'s encrypted title', async () => {
    await setupVault('pw');
    await saveConversation(convo('c1', 'Keep me', 'k'), summaryOf('Keep me', 'k'));
    await saveConversation(convo('c2', 'Delete me', 'd'), summaryOf('Delete me', 'd'));
    const titleBefore = (local['ba_conv_index'] as ConversationSummary[]).find((e) => e.id === 'c1')!.title;

    await lockVault();
    await deleteConversation('c2'); // mutating while locked must not touch c1's ciphertext

    const rawIndex = local['ba_conv_index'] as ConversationSummary[];
    expect(rawIndex.some((e) => e.id === 'c2')).toBe(false);
    const titleAfter = rawIndex.find((e) => e.id === 'c1')!.title;
    expect(titleAfter).toBe(titleBefore); // unchanged ciphertext, not a placeholder

    await unlockVault('pw');
    expect((await getConversationIndex()).find((e) => e.id === 'c1')!.title).toBe('Keep me');
  });
});
