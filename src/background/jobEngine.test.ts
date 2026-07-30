import { beforeEach, describe, expect, it, vi } from 'vitest';
import { seedFrontier, type FrontierState, type JobLimits } from '../shared/jobs';
import { cancelJob, registerJobType, startJob, tick, type JobTypeHandler } from './jobEngine';
import { getJob, readFindings, readReport, writeFrontier, writeReport, type JobFinding } from './jobStore';

// ---- fakes: chrome.storage.local, chrome.alarms, navigator.storage (OPFS) ----

class FakeWritable {
  constructor(private f: FakeFile, keep: boolean) { if (!keep) f.bytes = new Uint8Array(0); }
  async write(input: string | { type: 'write'; position: number; data: BufferSource }) {
    const toB = (d: string | BufferSource) => (typeof d === 'string' ? new TextEncoder().encode(d) : new Uint8Array(d as ArrayBuffer));
    let pos: number, data: Uint8Array;
    if (typeof input === 'object' && 'type' in input) { pos = input.position; data = toB(input.data); }
    else { pos = this.f.bytes.length; data = toB(input); }
    const end = pos + data.length;
    if (end > this.f.bytes.length) { const g = new Uint8Array(end); g.set(this.f.bytes); this.f.bytes = g; }
    this.f.bytes.set(data, pos);
  }
  async close() {}
}
class FakeFile { kind = 'file' as const; bytes = new Uint8Array(0); constructor(public name: string) {}
  async getFile() { const b = this.bytes; return { size: b.length, async text() { return new TextDecoder().decode(b); } }; }
  async createWritable(o?: { keepExistingData?: boolean }) { return new FakeWritable(this, o?.keepExistingData ?? false); } }
class FakeDir { kind = 'directory' as const; dirs = new Map<string, FakeDir>(); files = new Map<string, FakeFile>(); constructor(public name: string) {}
  async getDirectoryHandle(n: string, o?: { create?: boolean }) { let d = this.dirs.get(n); if (!d) { if (!o?.create) throw new Error('NF'); d = new FakeDir(n); this.dirs.set(n, d); } return d; }
  async getFileHandle(n: string, o?: { create?: boolean }) { let f = this.files.get(n); if (!f) { if (!o?.create) throw new Error('NF'); f = new FakeFile(n); this.files.set(n, f); } return f; }
  async removeEntry(n: string) { this.dirs.delete(n); this.files.delete(n); } }

let alarms: Record<string, number>;

beforeEach(() => {
  const store: Record<string, unknown> = {
    // a usable model config so getSettings() returns non-null (no vault ⇒ plaintext)
    ba_settings: { baseUrl: 'https://api.x/v1', apiKey: 'k', model: 'm' },
  };
  alarms = {};
  const root = new FakeDir('root'); // one persistent OPFS root across all calls
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
  vi.stubGlobal('chrome', {
    storage: { local: {
      async get(k: string | string[]) { const ks = Array.isArray(k) ? k : [k]; const o: Record<string, unknown> = {}; for (const x of ks) if (x in store) o[x] = store[x]; return o; },
      async set(o: Record<string, unknown>) { Object.assign(store, o); },
      async remove(k: string | string[]) { for (const x of Array.isArray(k) ? k : [k]) delete store[x]; },
    } },
    alarms: {
      create: (name: string, info: { when: number }) => { alarms[name] = info.when; },
      clear: async (name: string) => { delete alarms[name]; return true; },
    },
    runtime: { getURL: (p: string) => p },
    // no chrome.notifications ⇒ notifyRunComplete no-ops
  });
});

const LIMITS: JobLimits = { maxSources: 20, maxDepth: 1, maxConcurrency: 2, perItemMaxSteps: 2, elapsedCapMs: 60_000 };

/** A mock research handler — no real model/browser; deterministic. */
function installMock(opts: { leadsPerItem?: number } = {}): void {
  const handler: JobTypeHandler = {
    async seed() { return seedFrontier(['q1', 'q2', 'q3']); },
    async runItem(_s, _j, item) {
      const finding: JobFinding = { itemId: item.id, depth: item.depth, url: item.url, query: item.query, conclusion: `done:${item.query ?? item.url}`, sources: ['https://s'], at: 't' };
      const leads = Array.from({ length: opts.leadsPerItem ?? 0 }, (_v, i) => ({ url: `https://lead-${item.id}-${i}` }));
      return { finding, leads };
    },
    async reduce(_s, job, findings) { await writeReport(job.id, `# report\n${findings.length} findings`); return 'report.md'; },
  };
  registerJobType('research', handler);
}

describe('jobEngine durable loop', () => {
  it('seeds, processes every item, writes findings + report, and finishes done', async () => {
    installMock();
    const job = await startJob('research', 'obj', 'Title', LIMITS);
    await tick(job.id);

    const done = await getJob(job.id);
    expect(done?.status).toBe('done');
    expect(done?.reportName).toBe('report.md');
    expect(done?.processed).toBe(3);
    expect((await readFindings(job.id)).map((f) => f.conclusion)).toEqual(['done:q1', 'done:q2', 'done:q3']);
    expect(await readReport(job.id)).toContain('3 findings');
    expect(alarms[`job:${job.id}`]).toBeUndefined(); // finished ⇒ alarm cleared
  });

  it('follows depth-capped leads before finishing', async () => {
    installMock({ leadsPerItem: 2 }); // each seed adds 2 depth-1 leads; depth 1 is the cap
    const job = await startJob('research', 'obj', 'T', LIMITS);
    await tick(job.id);
    const done = await getJob(job.id);
    // 3 seeds + 6 leads = 9 processed, then done (leads' own leads are past maxDepth)
    expect(done?.status).toBe('done');
    expect(done?.processed).toBe(9);
  });

  it('resumes from a checkpointed frontier without re-seeding', async () => {
    installMock();
    // Pre-create a running job whose frontier already has 2 pending, 1 processed.
    const frontier: FrontierState = { ...seedFrontier(['a', 'b']), processedCount: 1 };
    const job = await startJob('research', 'obj', 'T', LIMITS);
    await writeFrontier(job.id, frontier); // overwrite the (empty) checkpoint
    // reset counters as if partway through
    await tick(job.id);
    const done = await getJob(job.id);
    expect(done?.status).toBe('done');
    // resumed 1 (checkpointed) + 2 pending processed = 3, NOT the 3 default seeds
    expect(done?.processed).toBe(3);
    expect((await readFindings(job.id)).map((f) => f.query)).toEqual(['a', 'b']);
  });

  it('a cancelled job does not process on tick', async () => {
    installMock();
    const job = await startJob('research', 'obj', 'T', LIMITS);
    await cancelJob(job.id);
    await tick(job.id);
    const j = await getJob(job.id);
    expect(j?.status).toBe('cancelled');
    expect(await readFindings(job.id)).toEqual([]);
  });
});
