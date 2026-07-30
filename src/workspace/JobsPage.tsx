import { useEffect, useState } from 'preact/hooks';
import type { JobRecord } from '../shared/jobs';
import { getJobs, readReport } from '../background/jobStore';

// Durable-jobs console: lists long-running background jobs (the first type is
// deep research), shows live progress, and controls them via the service worker.
// Reads the catalogue + report directly from OPFS/storage (same origin); control
// actions go through the SW so its alarms stay authoritative.

function fmtElapsed(job: JobRecord): string {
  const end = job.finishedAt ?? Date.now();
  const s = Math.max(0, Math.round((end - job.startedAt) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

const STATUS_CLASS: Record<string, string> = {
  running: 'ws-chip-ok',
  reducing: 'ws-chip-ok',
  queued: 'ws-chip-ok',
  paused: 'ws-chip-warn',
  done: 'ws-chip-ok',
  failed: 'ws-chip-error',
  cancelled: 'ws-chip-paused',
};

export function JobsPage() {
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [report, setReport] = useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => void getJobs().then((j) => setJobs([...j].sort((a, b) => b.createdAt - a.createdAt)));
  useEffect(() => {
    load();
    const t = setInterval(load, 3000); // jobs advance in the background — poll for progress
    return () => clearInterval(t);
  }, []);

  const control = async (id: string, action: 'pause' | 'resume' | 'cancel' | 'delete') => {
    if (action === 'delete' && !confirm('Delete this job and its findings/report?')) return;
    setBusy(id);
    try {
      await chrome.runtime.sendMessage({ type: 'job_control', action, id });
      if (report?.id === id && action === 'delete') setReport(null);
      load();
    } finally {
      setBusy(null);
    }
  };

  const openReport = async (id: string) => {
    const text = await readReport(id);
    setReport({ id, text: text ?? '_No report yet._' });
  };

  return (
    <div class="ws-jobs-page">
      <h2>Jobs</h2>
      <p class="settings-note">
        Durable background jobs — e.g. deep research. They keep running (and resume after the browser
        suspends the extension) and save a report to Products when done. Start one by asking the agent to
        research something exhaustively.
      </p>

      {jobs.length === 0 && <div class="ws-empty">No jobs yet.</div>}

      <div class="ws-jobs-layout">
        <ul class="ws-jobs-list">
          {jobs.map((j) => {
            const total = j.processed + j.pending;
            const pct = total > 0 ? Math.round((j.processed / total) * 100) : 0;
            const active = j.status === 'running' || j.status === 'queued' || j.status === 'reducing';
            return (
              <li key={j.id} class="ws-job">
                <div class="ws-job-head">
                  <strong>{j.title}</strong>
                  <span class={`ws-chip ${STATUS_CLASS[j.status] ?? ''}`}>{j.status}</span>
                </div>
                <p class="ws-job-meta ws-dim">
                  {j.processed} processed · {j.pending} pending{active ? ` · ${pct}%` : ''} · {fmtElapsed(j)}
                  {j.error ? ` · ${j.error}` : ''}
                </p>
                <div class="ws-job-actions">
                  {j.status === 'running' && <button class="btn btn-small" disabled={busy === j.id} onClick={() => control(j.id, 'pause')}>Pause</button>}
                  {j.status === 'paused' && <button class="btn btn-small" disabled={busy === j.id} onClick={() => control(j.id, 'resume')}>Resume</button>}
                  {active && <button class="btn btn-small" disabled={busy === j.id} onClick={() => control(j.id, 'cancel')}>Cancel</button>}
                  {j.reportName && <button class="btn btn-small" onClick={() => openReport(j.id)}>View report</button>}
                  <button class="icon-btn" title="Delete" disabled={busy === j.id} onClick={() => control(j.id, 'delete')}>✕</button>
                </div>
              </li>
            );
          })}
        </ul>

        {report && (
          <div class="ws-job-report">
            <pre>{report.text}</pre>
          </div>
        )}
      </div>
    </div>
  );
}
