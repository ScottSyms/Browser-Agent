import { describe, expect, it } from 'vitest';
import {
  addLeads,
  frontierKey,
  isExhausted,
  markProcessed,
  seedFrontier,
  takeBatch,
  withinLimits,
  type FrontierState,
  type JobLimits,
  type JobRecord,
} from './jobs';

const LIMITS: JobLimits = { maxSources: 5, maxDepth: 2, maxConcurrency: 2, perItemMaxSteps: 4, elapsedCapMs: 1000 };

describe('frontierKey', () => {
  it('strips hash + trailing slash from urls and lowercases queries', () => {
    expect(frontierKey({ url: 'https://x.com/a/#top' })).toBe('https://x.com/a');
    expect(frontierKey({ url: 'https://x.com/a/' })).toBe('https://x.com/a');
    expect(frontierKey({ query: '  Foo   Bar ' })).toBe('q:foo bar');
  });
});

describe('seed + takeBatch', () => {
  it('seeds queries at depth 0 and batches them', () => {
    const f = seedFrontier(['a', 'b', 'c']);
    expect(f.pending).toHaveLength(3);
    expect(f.pending.every((p) => p.depth === 0)).toBe(true);
    const { batch, rest } = takeBatch(f, 2);
    expect(batch).toHaveLength(2);
    expect(rest.pending).toHaveLength(1);
  });
});

describe('addLeads', () => {
  it('dedups by normalized url key (trailing slash / hash ignored)', () => {
    let f: FrontierState = { pending: [], seen: [], processedCount: 0 };
    f = addLeads(f, [{ url: 'https://a.com' }, { url: 'https://b.com' }], -1, LIMITS); // depth 0
    f = addLeads(f, [{ url: 'https://a.com/' }, { url: 'https://c.com' }], 0, LIMITS); // a.com dup
    expect(f.pending.map((p) => p.url)).toEqual(['https://a.com', 'https://b.com', 'https://c.com']);
  });

  it('enforces maxDepth (leads past the cap are dropped)', () => {
    let f = seedFrontier(['seed']); // depth 0
    f = addLeads(f, [{ url: 'https://d1' }], 0, LIMITS); // depth 1 ok
    f = addLeads(f, [{ url: 'https://d2' }], 1, LIMITS); // depth 2 ok (maxDepth 2)
    f = addLeads(f, [{ url: 'https://d3' }], 2, LIMITS); // depth 3 dropped
    expect(f.pending.some((p) => p.url === 'https://d2')).toBe(true);
    expect(f.pending.some((p) => p.url === 'https://d3')).toBe(false);
  });

  it('enforces maxSources (stops adding once seen hits the cap)', () => {
    let f = seedFrontier(['s']);
    f = addLeads(f, [1, 2, 3, 4, 5, 6, 7].map((n) => ({ url: `https://u${n}` })), 0, LIMITS);
    // 1 seed + up to 4 more = 5 seen (maxSources)
    expect(new Set(f.seen).size).toBe(5);
  });
});

describe('progress + limits', () => {
  it('markProcessed advances the count; isExhausted when pending empty', () => {
    let f = seedFrontier(['a', 'b']);
    const { batch, rest } = takeBatch(f, 2);
    f = markProcessed(rest, batch.length);
    expect(f.processedCount).toBe(2);
    expect(isExhausted(f)).toBe(true);
  });

  const job = (over: Partial<JobRecord> = {}): JobRecord => ({
    id: 'j', type: 'research', title: 't', objective: 'o', status: 'running', limits: LIMITS,
    createdAt: 0, startedAt: 0, updatedAt: 0, processed: 0, pending: 0, ...over,
  });

  it('stops at the elapsed cap', () => {
    const f = seedFrontier(['a']);
    expect(withinLimits(job(), f, 999).ok).toBe(true);
    expect(withinLimits(job(), f, 1000)).toEqual({ ok: false, reason: 'time_cap' });
  });

  it('stops at the source cap', () => {
    const f = { pending: [], seen: [], processedCount: LIMITS.maxSources };
    expect(withinLimits(job(), f, 0)).toEqual({ ok: false, reason: 'source_cap' });
  });
});

describe('resume semantics', () => {
  it('a checkpointed frontier resumes without reprocessing taken items', () => {
    // Simulate: take a batch, persist `rest`, "evict", resume from `rest`.
    let f = seedFrontier(['a', 'b', 'c', 'd']);
    const first = takeBatch(f, 2);
    f = markProcessed(first.rest, first.batch.length); // persisted state after batch 1
    const second = takeBatch(f, 2); // resume
    expect(second.batch.map((b) => b.query)).toEqual(['c', 'd']);
    expect(second.batch.some((b) => first.batch.includes(b))).toBe(false);
  });
});
