import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobRecord } from '../shared/jobs';
import { seedFrontier } from '../shared/jobs';
import {
  appendFindings,
  deleteJob,
  getJob,
  getJobs,
  readFindings,
  readFrontier,
  readReport,
  saveJob,
  writeFrontier,
  writeReport,
  type JobFinding,
} from './jobStore';

// append-capable OPFS fake + persistent chrome.storage.local fake
class FakeWritable {
  constructor(private file: FakeFile, keep: boolean) {
    if (!keep) file.bytes = new Uint8Array(0);
  }
  async write(input: string | { type: 'write'; position: number; data: BufferSource }) {
    const toBytes = (d: string | BufferSource) => (typeof d === 'string' ? new TextEncoder().encode(d) : new Uint8Array(d as ArrayBuffer));
    let pos: number, data: Uint8Array;
    if (typeof input === 'object' && 'type' in input) { pos = input.position; data = toBytes(input.data); }
    else { pos = this.file.bytes.length; data = toBytes(input); }
    const end = pos + data.length;
    if (end > this.file.bytes.length) { const g = new Uint8Array(end); g.set(this.file.bytes); this.file.bytes = g; }
    this.file.bytes.set(data, pos);
  }
  async close() {}
}
class FakeFile {
  kind = 'file' as const;
  bytes = new Uint8Array(0);
  constructor(public name: string) {}
  async getFile() { const b = this.bytes; return { size: b.length, async text() { return new TextDecoder().decode(b); } }; }
  async createWritable(opts?: { keepExistingData?: boolean }) { return new FakeWritable(this, opts?.keepExistingData ?? false); }
}
class FakeDir {
  kind = 'directory' as const;
  dirs = new Map<string, FakeDir>();
  files = new Map<string, FakeFile>();
  constructor(public name: string) {}
  async getDirectoryHandle(n: string, o?: { create?: boolean }) {
    let d = this.dirs.get(n); if (!d) { if (!o?.create) throw new Error('NF'); d = new FakeDir(n); this.dirs.set(n, d); } return d;
  }
  async getFileHandle(n: string, o?: { create?: boolean }) {
    let f = this.files.get(n); if (!f) { if (!o?.create) throw new Error('NF'); f = new FakeFile(n); this.files.set(n, f); } return f;
  }
  async removeEntry(n: string) { this.dirs.delete(n); this.files.delete(n); }
}

beforeEach(() => {
  const root = new FakeDir('root');
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
  const store: Record<string, unknown> = {};
  vi.stubGlobal('chrome', { storage: { local: {
    async get(k: string) { return k in store ? { [k]: store[k] } : {}; },
    async set(o: Record<string, unknown>) { Object.assign(store, o); },
  } } });
});

const job = (id: string, over: Partial<JobRecord> = {}): JobRecord => ({
  id, type: 'research', title: 't', objective: 'o', status: 'running',
  limits: { maxSources: 5, maxDepth: 2, maxConcurrency: 2, perItemMaxSteps: 4, elapsedCapMs: 1000 },
  createdAt: 0, startedAt: 0, updatedAt: 0, processed: 0, pending: 0, ...over,
});

const finding = (id: string, conclusion: string): JobFinding => ({
  itemId: id, depth: 0, conclusion, sources: ['https://x'], at: '2026-01-01T00:00:00Z',
});

describe('job catalogue', () => {
  it('upserts and reads back', async () => {
    await saveJob(job('j1', { title: 'first' }));
    await saveJob(job('j2'));
    await saveJob(job('j1', { title: 'updated' })); // upsert
    expect((await getJobs()).length).toBe(2);
    expect((await getJob('j1'))?.title).toBe('updated');
  });

  it('deleteJob removes the catalogue row', async () => {
    await saveJob(job('j1'));
    await deleteJob('j1');
    expect(await getJob('j1')).toBeNull();
  });
});

describe('frontier + findings + report (OPFS)', () => {
  it('checkpoints and reloads the frontier', async () => {
    const f = seedFrontier(['a', 'b']);
    await writeFrontier('j1', f);
    const back = await readFrontier('j1');
    expect(back?.pending.map((p) => p.query)).toEqual(['a', 'b']);
  });

  it('appends findings across calls and reads them oldest-first', async () => {
    await appendFindings('j1', [finding('i1', 'one')]);
    await appendFindings('j1', [finding('i2', 'two'), finding('i3', 'three')]);
    const all = await readFindings('j1');
    expect(all.map((x) => x.conclusion)).toEqual(['one', 'two', 'three']);
  });

  it('writes and reads the report', async () => {
    await writeReport('j1', '# Report\nbody');
    expect(await readReport('j1')).toContain('# Report');
  });

  it('returns empty/null for a job with no OPFS state', async () => {
    expect(await readFrontier('nope')).toBeNull();
    expect(await readFindings('nope')).toEqual([]);
    expect(await readReport('nope')).toBeNull();
  });
});
