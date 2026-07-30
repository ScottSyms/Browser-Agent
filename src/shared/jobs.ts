// =============================================================================
// Durable job model + pure state machine. A "job" is long-running, resumable
// fan-out work (the first type is deep research). This module is pure — no
// chrome.*, no I/O, no model calls — so the frontier logic (dedup, depth/source
// caps, batching, limits) is fully unit-testable. Persistence lives in
// background/jobStore.ts; the loop that drives it in background/jobEngine.ts.
// =============================================================================

export type JobType = 'research';

export type JobStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'reducing'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface JobLimits {
  /** Cap on total sources discovered/processed — bounds the whole exploration. */
  maxSources: number;
  /** Follow-up rounds: seeds are depth 0, their leads depth 1, and so on. */
  maxDepth: number;
  /** Parallel sub-agents / background tabs per batch. */
  maxConcurrency: number;
  /** Step budget for each per-item scoped sub-agent. */
  perItemMaxSteps: number;
  /** Hard wall-clock cap for the whole job (hours). */
  elapsedCapMs: number;
}

export const DEFAULT_RESEARCH_LIMITS: JobLimits = {
  maxSources: 60,
  maxDepth: 2,
  maxConcurrency: 3,
  perItemMaxSteps: 6,
  elapsedCapMs: 4 * 60 * 60 * 1000,
};

/** One unit of work: a URL to read or a subquery to search. */
export interface FrontierItem {
  id: string;
  depth: number;
  url?: string;
  query?: string;
}

/** Serializable frontier state (persisted as frontier.json). `seen` doubles as
 *  the dedup set and the source-count for the maxSources cap. */
export interface FrontierState {
  pending: FrontierItem[];
  seen: string[];
  processedCount: number;
}

/** Catalogue record (small; lives in chrome.storage.local `ba_jobs`). */
export interface JobRecord {
  id: string;
  type: JobType;
  title: string;
  objective: string;
  status: JobStatus;
  limits: JobLimits;
  createdAt: number;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  processed: number;
  pending: number;
  error?: string;
  /** productStore filename of the final report, once `done`. */
  reportName?: string;
}

/** Dedup/identity key for a lead: URL without its hash, or `q:<lowercased query>`. */
export function frontierKey(item: { url?: string; query?: string }): string {
  if (item.url) return item.url.split('#')[0].replace(/\/+$/, '');
  return `q:${(item.query ?? '').trim().toLowerCase().replace(/\s+/g, ' ')}`;
}

let counter = 0;
function nextId(): string {
  return `fi-${Date.now().toString(36)}-${(counter++).toString(36)}`;
}

/** Seed the frontier from initial subqueries (depth 0). */
export function seedFrontier(queries: string[]): FrontierState {
  const state: FrontierState = { pending: [], seen: [], processedCount: 0 };
  return addLeads(state, queries.map((q) => ({ query: q })), -1, DEFAULT_RESEARCH_LIMITS);
  // parentDepth -1 ⇒ seeds land at depth 0.
}

/**
 * Add discovered leads to the frontier. Skips anything already seen, past
 * `maxDepth`, or beyond `maxSources`. Returns a new state (pure).
 */
export function addLeads(
  state: FrontierState,
  leads: Array<{ url?: string; query?: string }>,
  parentDepth: number,
  limits: JobLimits,
): FrontierState {
  const seen = new Set(state.seen);
  const pending = [...state.pending];
  const depth = parentDepth + 1;
  if (depth > limits.maxDepth) return state;
  for (const lead of leads) {
    if (!lead.url && !lead.query?.trim()) continue;
    const key = frontierKey(lead);
    if (seen.has(key)) continue;
    if (seen.size >= limits.maxSources) break;
    seen.add(key);
    pending.push({ id: nextId(), depth, ...(lead.url ? { url: lead.url } : {}), ...(lead.query ? { query: lead.query } : {}) });
  }
  return { pending, seen: [...seen], processedCount: state.processedCount };
}

/** Pop up to `n` items off the front of the frontier. Pure — returns both. */
export function takeBatch(state: FrontierState, n: number): { batch: FrontierItem[]; rest: FrontierState } {
  const batch = state.pending.slice(0, Math.max(0, n));
  const rest: FrontierState = { ...state, pending: state.pending.slice(batch.length) };
  return { batch, rest };
}

/** Record that `count` items finished (their keys were already marked on enqueue). */
export function markProcessed(state: FrontierState, count: number): FrontierState {
  return { ...state, processedCount: state.processedCount + count };
}

export function isExhausted(state: FrontierState): boolean {
  return state.pending.length === 0;
}

/** Whether the job may keep running: under the elapsed cap and source cap. */
export function withinLimits(job: JobRecord, state: FrontierState, now: number): { ok: boolean; reason?: string } {
  if (now - job.startedAt >= job.limits.elapsedCapMs) return { ok: false, reason: 'time_cap' };
  if (state.processedCount >= job.limits.maxSources) return { ok: false, reason: 'source_cap' };
  return { ok: true };
}
