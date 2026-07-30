// =============================================================================
// Durable job persistence. Small catalogue in chrome.storage.local (`ba_jobs`,
// for the Jobs console) + bulk state in OPFS `/jobs/{id}/`:
//   - frontier.json   : the FrontierState checkpoint (overwritten each batch)
//   - findings.jsonl  : append-only per-item conclusions
//   - report.md       : the final synthesized report
// Same catalogue+OPFS split as auditLog.ts / the conversation store. OPFS is
// origin-scoped, so the service worker (writer) and the workspace console
// (reader) share it. (Encrypting /jobs/* at rest via the vault is a noted
// follow-up; findings are largely public-web research this slice.)
// =============================================================================

import type { FrontierState, JobRecord } from '../shared/jobs';

const JOBS_KEY = 'ba_jobs';
const JOBS_DIR = 'jobs';

export interface JobFinding {
  itemId: string;
  depth: number;
  url?: string;
  query?: string;
  conclusion: string;
  sources: string[];
  at: string; // ISO
  error?: string;
}

// ---- catalogue (chrome.storage.local) ---------------------------------------

export async function getJobs(): Promise<JobRecord[]> {
  const r = await chrome.storage.local.get(JOBS_KEY);
  const jobs = r[JOBS_KEY];
  return Array.isArray(jobs) ? (jobs as JobRecord[]) : [];
}

export async function getJob(id: string): Promise<JobRecord | null> {
  return (await getJobs()).find((j) => j.id === id) ?? null;
}

export async function saveJob(record: JobRecord): Promise<void> {
  const jobs = await getJobs();
  const idx = jobs.findIndex((j) => j.id === record.id);
  if (idx >= 0) jobs[idx] = record;
  else jobs.push(record);
  await chrome.storage.local.set({ [JOBS_KEY]: jobs });
}

export async function deleteJob(id: string): Promise<void> {
  const jobs = await getJobs();
  await chrome.storage.local.set({ [JOBS_KEY]: jobs.filter((j) => j.id !== id) });
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(JOBS_DIR, { create: true });
    await dir.removeEntry(id, { recursive: true });
  } catch {
    // no OPFS dir — nothing to remove
  }
}

// ---- OPFS bulk state --------------------------------------------------------

function safe(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

async function jobDir(id: string): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  const jobs = await root.getDirectoryHandle(JOBS_DIR, { create: true });
  return jobs.getDirectoryHandle(safe(id), { create: true });
}

async function writeFile(dir: FileSystemDirectoryHandle, name: string, text: string): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true });
  const w = await handle.createWritable();
  await w.write(text);
  await w.close();
}

async function readFile(dir: FileSystemDirectoryHandle, name: string): Promise<string | null> {
  try {
    const handle = await dir.getFileHandle(name);
    return await (await handle.getFile()).text();
  } catch {
    return null;
  }
}

export async function writeFrontier(id: string, state: FrontierState): Promise<void> {
  await writeFile(await jobDir(id), 'frontier.json', JSON.stringify(state));
}

export async function readFrontier(id: string): Promise<FrontierState | null> {
  const text = await readFile(await jobDir(id), 'frontier.json');
  if (!text) return null;
  try {
    return JSON.parse(text) as FrontierState;
  } catch {
    return null;
  }
}

/** Append one JSON line per finding (append-only; a concurrent read sees a valid prefix). */
export async function appendFindings(id: string, findings: JobFinding[]): Promise<void> {
  if (findings.length === 0) return;
  const dir = await jobDir(id);
  const handle = await dir.getFileHandle('findings.jsonl', { create: true });
  const existing = (await handle.getFile()).size;
  const bytes = new TextEncoder().encode(findings.map((f) => JSON.stringify(f)).join('\n') + '\n');
  const w = await handle.createWritable({ keepExistingData: true });
  await w.write({ type: 'write', position: existing, data: bytes as unknown as BufferSource });
  await w.close();
}

export async function readFindings(id: string): Promise<JobFinding[]> {
  const text = await readFile(await jobDir(id), 'findings.jsonl');
  if (!text) return [];
  const out: JobFinding[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as JobFinding);
    } catch {
      // torn final line from a concurrent append — skip
    }
  }
  return out;
}

export async function writeReport(id: string, markdown: string): Promise<void> {
  await writeFile(await jobDir(id), 'report.md', markdown);
}

export async function readReport(id: string): Promise<string | null> {
  return readFile(await jobDir(id), 'report.md');
}
