import { useEffect, useState } from 'preact/hooks';
import type { EventTrigger, TriggerRun } from '../shared/eventTriggers';
import type { ScheduledRun, ScheduledTask, ScheduledTaskRecurrence } from '../shared/scheduledTasks';
import type { Skill } from '../shared/types';
import type { Workflow } from '../shared/workflows';
import { useT } from '../sidebar/i18n';

function fmt(ts: number | string | undefined): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

const STATUS_LABEL: Record<string, string> = {
  ok: 'OK',
  error: 'Error',
  deferred: 'Deferred',
  needs_approval: 'Needs approval',
  running: 'Running…',
};

// The pre-existing scheduled-task system (previously tool-only, no UI) plus
// the two Phase 6 additions — Workflows (named ordered skill chains) and
// Event triggers (fire an unattended run when a matching site is opened).
// Every run here goes through AgentRuntime.runScheduledTask, so the existing
// unattended-approval gate (state-changing tools blocked, not silently run)
// applies exactly as it does to scheduled tasks today.
export function AutomationsPage() {
  const t = useT();
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [taskRuns, setTaskRuns] = useState<ScheduledRun[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [triggers, setTriggers] = useState<EventTrigger[]>([]);
  const [triggerRuns, setTriggerRuns] = useState<TriggerRun[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);

  const [showTriggerForm, setShowTriggerForm] = useState(false);
  const [editingTriggerId, setEditingTriggerId] = useState<string | null>(null);
  const [trName, setTrName] = useState('');
  const [trHost, setTrHost] = useState('');
  const [trTargetValue, setTrTargetValue] = useState('');
  const [trCooldown, setTrCooldown] = useState('');
  const [trMatchSubPages, setTrMatchSubPages] = useState(true);
  const [trError, setTrError] = useState<string | null>(null);

  // Inline edit/reschedule form for a scheduled task.
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [etTitle, setEtTitle] = useState('');
  const [etPrompt, setEtPrompt] = useState('');
  const [etKind, setEtKind] = useState<'once' | 'daily' | 'weekly' | 'interval'>('once');
  const [etRunAt, setEtRunAt] = useState('');
  const [etTime, setEtTime] = useState('09:00');
  const [etDays, setEtDays] = useState<number[]>([]);
  const [etInterval, setEtInterval] = useState('60');
  const [etError, setEtError] = useState<string | null>(null);

  const reload = () => {
    chrome.runtime.sendMessage({ type: 'scheduled_tasks_get' }).then((r: ScheduledTask[]) => setTasks(Array.isArray(r) ? r : []));
    chrome.runtime.sendMessage({ type: 'scheduled_runs_get' }).then((r: ScheduledRun[]) => setTaskRuns(Array.isArray(r) ? r : []));
    chrome.runtime.sendMessage({ type: 'workflow_list' }).then((r: Workflow[]) => setWorkflows(Array.isArray(r) ? r : []));
    chrome.runtime.sendMessage({ type: 'event_trigger_list' }).then((r: EventTrigger[]) => setTriggers(Array.isArray(r) ? r : []));
    chrome.runtime.sendMessage({ type: 'trigger_runs_get' }).then((r: TriggerRun[]) => setTriggerRuns(Array.isArray(r) ? r : []));
    chrome.storage.local.get('ba_skills').then((r) => setSkills(Array.isArray(r.ba_skills) ? (r.ba_skills as Skill[]) : []));
  };

  useEffect(() => {
    reload();
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return;
      if (changes.ba_scheduled_tasks || changes.ba_scheduled_runs || changes.ba_workflows || changes.ba_event_triggers || changes.ba_trigger_runs || changes.ba_skills) {
        reload();
      }
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);

  const toggleTask = async (id: string, enabled: boolean) => {
    await chrome.runtime.sendMessage({ type: 'scheduled_task_set_enabled', id, enabled });
    reload();
  };
  const deleteTask = async (id: string) => {
    await chrome.runtime.sendMessage({ type: 'scheduled_task_delete', id });
    reload();
  };

  // datetime-local value (local time, no timezone suffix) for a timestamp.
  const toLocalInput = (ms?: number): string => {
    const d = ms ? new Date(ms) : new Date(Date.now() + 5 * 60_000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const startEditTask = (task: ScheduledTask) => {
    setEditingTaskId(task.id);
    setEtTitle(task.title);
    setEtPrompt(task.prompt);
    setEtError(null);
    const r = task.recurrence;
    if (!r) {
      setEtKind('once');
      setEtRunAt(toLocalInput(task.nextRunAt));
    } else if (r.kind === 'weekly') {
      setEtKind('weekly');
      setEtTime(r.timeOfDay ?? '09:00');
      setEtDays(r.daysOfWeek ?? []);
    } else if (r.kind === 'interval') {
      setEtKind('interval');
      setEtInterval(String(r.intervalMinutes ?? 60));
    } else {
      setEtKind('daily');
      setEtTime(r.timeOfDay ?? '09:00');
    }
  };
  const toggleDay = (d: number) => setEtDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort()));
  const saveEditTask = async () => {
    if (!editingTaskId) return;
    setEtError(null);
    const patch: { title: string; prompt: string; runAt?: string; recurrence?: ScheduledTaskRecurrence | null } = { title: etTitle, prompt: etPrompt };
    if (etKind === 'once') {
      const ms = Date.parse(etRunAt);
      if (!Number.isFinite(ms)) {
        setEtError('Pick a valid date and time.');
        return;
      }
      patch.runAt = new Date(ms).toISOString();
      patch.recurrence = null;
    } else if (etKind === 'daily') {
      patch.recurrence = { kind: 'daily', timeOfDay: etTime };
    } else if (etKind === 'weekly') {
      patch.recurrence = { kind: 'weekly', timeOfDay: etTime, daysOfWeek: etDays };
    } else {
      patch.recurrence = { kind: 'interval', intervalMinutes: Math.max(1, Number(etInterval) || 60) };
    }
    const res = (await chrome.runtime.sendMessage({ type: 'scheduled_task_update', id: editingTaskId, patch })) as { ok: boolean; error?: string };
    if (!res.ok) {
      setEtError(res.error ?? 'Could not update the task.');
      return;
    }
    setEditingTaskId(null);
    reload();
  };

  const createTrigger = async () => {
    setTrError(null);
    if (!trTargetValue.trim()) {
      setTrError('Pick a skill.');
      return;
    }
    const target = { kind: 'skill' as const, name: trTargetValue };
    const cooldownMinutes = trCooldown.trim() ? Number(trCooldown) : undefined;
    const req = editingTriggerId
      ? {
          type: 'event_trigger_update' as const,
          id: editingTriggerId,
          patch: { name: trName, hostPattern: trHost, matchSubPages: trMatchSubPages, target, cooldownMinutes },
        }
      : {
          type: 'event_trigger_create' as const,
          name: trName,
          hostPattern: trHost,
          matchSubPages: trMatchSubPages,
          target,
          cooldownMinutes,
        };
    const res = (await chrome.runtime.sendMessage(req)) as { ok: boolean; error?: string };
    if (!res.ok) {
      setTrError(res.error ?? 'Could not create trigger.');
      return;
    }
    setTrName('');
    setTrHost('');
    setTrTargetValue('');
    setTrCooldown('');
    setTrMatchSubPages(true);
    setShowTriggerForm(false);
    setEditingTriggerId(null);
    reload();
  };
  const toggleTrigger = async (id: string, enabled: boolean) => {
    await chrome.runtime.sendMessage({ type: 'event_trigger_update', id, patch: { enabled } });
    reload();
  };
  const deleteTrigger = async (id: string) => {
    await chrome.runtime.sendMessage({ type: 'event_trigger_delete', id });
    reload();
  };
  const editTrigger = (t: EventTrigger) => {
    setTrError(null);
    setEditingTriggerId(t.id);
    setTrName(t.name);
    setTrHost(t.hostPattern);
    // Triggers are skill-only now; a legacy workflow target has no skill to
    // preselect, so start empty and let the user pick a skill.
    setTrTargetValue(t.target.kind === 'skill' ? t.target.name : '');
    setTrCooldown(t.cooldownMinutes ? String(t.cooldownMinutes) : '');
    setTrMatchSubPages(t.matchSubPages ?? true);
    setShowTriggerForm(true);
  };
  const newTrigger = () => {
    setTrError(null);
    setEditingTriggerId(null);
    setTrName('');
    setTrHost('');
    setTrTargetValue('');
    setTrCooldown('');
    setTrMatchSubPages(true);
    setShowTriggerForm(true);
  };

  const workflowName = (id: string) => workflows.find((w) => w.id === id)?.name ?? t('automations.deletedWorkflow');
  const targetLabel = (t: EventTrigger) => (t.target.kind === 'skill' ? `/${t.target.name}` : workflowName(t.target.workflowId));

  const recentTaskRuns = [...taskRuns].sort((a, b) => b.startedAt - a.startedAt).slice(0, 15);
  const recentTriggerRuns = [...triggerRuns].sort((a, b) => b.startedAt - a.startedAt).slice(0, 15);

  return (
    <div class="ws-automations-page">
      <h2>{t('automations.title')}</h2>
      <p class="settings-note">{t('automations.note')}</p>

      <details class="settings-acc" open>
        <summary class="settings-acc-summary">
          <strong>{t('automations.scheduledTasks')}</strong>
        </summary>
        <p class="settings-note">{t('automations.scheduledTasksNote')}</p>
        {tasks.length === 0 ? (
          <div class="ws-empty">{t('automations.noneYet')}</div>
        ) : (
          <ul class="ws-item-list">
            {tasks.map((task) => (
              <li key={task.id} class={`ws-item${editingTaskId === task.id ? ' is-editing' : ''}`} title={task.prompt}>
                <div class="ws-item-main">
                  <span class="ws-item-title">
                    {task.title}
                    <span class={`ws-chip ${task.enabled ? 'ws-chip-ok' : 'ws-chip-paused'}`}>{task.enabled ? t('automations.enabled') : t('automations.paused')}</span>
                  </span>
                  <span class="ws-item-meta">
                    {t('automations.next')}: {fmt(task.enabled ? task.nextRunAt : undefined)} · {t('automations.last')}: {fmt(task.lastRunAt)}
                    {task.lastStatus ? ` (${STATUS_LABEL[task.lastStatus] ?? task.lastStatus})` : ''}
                  </span>
                </div>
                <div class="ws-item-actions">
                  <button class="btn btn-small" onClick={() => (editingTaskId === task.id ? setEditingTaskId(null) : startEditTask(task))}>{editingTaskId === task.id ? 'Close' : 'Edit'}</button>
                  <button class="btn btn-small" onClick={() => toggleTask(task.id, !task.enabled)}>{task.enabled ? t('automations.pause') : t('automations.resume')}</button>
                  <button class="icon-btn" title={t('automations.delete')} onClick={() => deleteTask(task.id)}>✕</button>
                </div>
                {editingTaskId === task.id && (
                  <div class="ws-task-edit">
                    {etError && <div class="banner banner-error">{etError}</div>}
                    <label class="field"><span>Title</span><input value={etTitle} onInput={(e) => setEtTitle((e.target as HTMLInputElement).value)} /></label>
                    <label class="field"><span>Instruction</span><textarea rows={3} value={etPrompt} onInput={(e) => setEtPrompt((e.target as HTMLTextAreaElement).value)} /></label>
                    <label class="field"><span>Schedule</span>
                      <select value={etKind} onChange={(e) => setEtKind((e.target as HTMLSelectElement).value as typeof etKind)}>
                        <option value="once">One time</option>
                        <option value="daily">Daily</option>
                        <option value="weekly">Weekly</option>
                        <option value="interval">Every N minutes</option>
                      </select>
                    </label>
                    {etKind === 'once' && (
                      <label class="field"><span>Run at (local time)</span><input type="datetime-local" value={etRunAt} onInput={(e) => setEtRunAt((e.target as HTMLInputElement).value)} /></label>
                    )}
                    {(etKind === 'daily' || etKind === 'weekly') && (
                      <label class="field"><span>Time (local)</span><input type="time" value={etTime} onInput={(e) => setEtTime((e.target as HTMLInputElement).value)} /></label>
                    )}
                    {etKind === 'weekly' && (
                      <div class="field"><span>Days</span>
                        <div class="ws-days">
                          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => (
                            <label key={i} class="ws-day"><input type="checkbox" checked={etDays.includes(i)} onChange={() => toggleDay(i)} /> {d}</label>
                          ))}
                        </div>
                      </div>
                    )}
                    {etKind === 'interval' && (
                      <label class="field"><span>Every (minutes)</span><input type="number" min="1" value={etInterval} onInput={(e) => setEtInterval((e.target as HTMLInputElement).value)} /></label>
                    )}
                    <div class="settings-actions">
                      <button class="btn btn-primary" onClick={saveEditTask} disabled={!etTitle.trim() || !etPrompt.trim()}>Save changes</button>
                      <button class="btn" onClick={() => setEditingTaskId(null)}>Cancel</button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {recentTaskRuns.length > 0 && (
          <>
            <p class="settings-note">{t('automations.recentRuns')}</p>
            <ul class="ws-run-list">
              {recentTaskRuns.map((r) => (
                <li key={r.id} class={`ws-run-item ws-run-${r.status}`}>
                  <div class="ws-run-header">
                    <span class="ws-run-title">{tasks.find((t) => t.id === r.taskId)?.title ?? t('automations.deletedWorkflow')}</span>
                    <span class="ws-run-meta">{fmt(r.startedAt)} · {STATUS_LABEL[r.status] ?? r.status}</span>
                  </div>
                  {(r.summary || r.error) && <p class="ws-run-detail">{r.error ?? r.summary}</p>}
                  {r.fileArtifactNames && r.fileArtifactNames.length > 0 && (
                    <p class="ws-run-detail ws-dim">📎 {t('automations.savedToProducts')}: {r.fileArtifactNames.join(', ')}</p>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </details>

      <details class="settings-acc">
        <summary class="settings-acc-summary">
          <strong>{t('automations.eventTriggers')}</strong>
        </summary>
        <p class="settings-note">{t('automations.eventTriggersNote')}</p>
        {triggers.length > 0 && (
          <ul class="ws-item-list">
            {triggers.map((trigger) => (
              <li key={trigger.id} class="ws-item">
                <div class="ws-item-main">
                  <span class="ws-item-title">
                    {trigger.name}
                    <span class={`ws-chip ${trigger.enabled ? 'ws-chip-ok' : 'ws-chip-paused'}`}>{trigger.enabled ? t('automations.enabled') : t('automations.paused')}</span>
                  </span>
                  <span class="ws-item-meta">
                    {trigger.hostPattern} → {targetLabel(trigger)}
                    {trigger.matchSubPages ? ` · ${t('automations.allPages')}` : ''} · {t('automations.cooldown')}: {trigger.cooldownMinutes ?? 60}min · {t('automations.last')}: {fmt(trigger.lastFiredAt)}
                  </span>
                </div>
                <div class="ws-item-actions">
                  <button class="icon-btn" title={t('automations.edit')} onClick={() => editTrigger(trigger)}>✎</button>
                  <button class="btn btn-small" onClick={() => toggleTrigger(trigger.id, !trigger.enabled)}>{trigger.enabled ? t('automations.pause') : t('automations.resume')}</button>
                  <button class="icon-btn" title={t('automations.delete')} onClick={() => deleteTrigger(trigger.id)}>✕</button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {showTriggerForm ? (
          <div class="site-form">
            <label class="field">
              <span>{t('automations.triggerName')}</span>
              <input type="text" value={trName} onInput={(e) => setTrName((e.target as HTMLInputElement).value)} />
            </label>
            <label class="field">
              <span>{t('automations.triggerSite')}</span>
              <input type="text" placeholder="jira.example.com" value={trHost} onInput={(e) => setTrHost((e.target as HTMLInputElement).value)} />
            </label>
            <label class="field">
              <span>{t('automations.triggerSkill')}</span>
              <select value={trTargetValue} onChange={(e) => setTrTargetValue((e.target as HTMLSelectElement).value)}>
                <option value="">{t('automations.chooseSkill')}</option>
                {skills.map((s) => (
                  <option key={s.id} value={s.name}>/{s.name}</option>
                ))}
              </select>
            </label>
            <label class="field">
              <span>{t('automations.cooldownMinutes')}</span>
              <input type="number" min="1" placeholder="60" value={trCooldown} onInput={(e) => setTrCooldown((e.target as HTMLInputElement).value)} />
            </label>
            <label class="toggle-row">
              <input
                type="checkbox"
                checked={trMatchSubPages}
                onChange={(e) => setTrMatchSubPages((e.target as HTMLInputElement).checked)}
              />
              <span class="toggle-text">
                <span class="toggle-label">{t('automations.fireEveryPage')}</span>
                <span class="toggle-note">{t('automations.fireEveryPageNote')}</span>
              </span>
            </label>
            {trError && <div class="banner banner-error">{trError}</div>}
            <div class="settings-actions">
              <button
                class="btn"
                onClick={() => {
                  setShowTriggerForm(false);
                  setEditingTriggerId(null);
                  setTrError(null);
                }}
              >
                {t('common.cancel')}
              </button>
              <button class="btn btn-primary" onClick={createTrigger} disabled={!trName.trim() || !trHost.trim()}>
                {editingTriggerId ? t('automations.updateTrigger') : t('automations.createTrigger')}
              </button>
            </div>
          </div>
        ) : (
          <div class="context-actions">
            <button class="btn btn-small" onClick={newTrigger}>{t('automations.addTrigger')}</button>
          </div>
        )}
        {recentTriggerRuns.length > 0 && (
          <>
            <p class="settings-note">{t('automations.recentRuns')}</p>
            <ul class="ws-run-list">
              {recentTriggerRuns.map((r) => (
                <li key={r.id} class={`ws-run-item ws-run-${r.status}`}>
                  <div class="ws-run-header">
                    <span class="ws-run-title">{triggers.find((t) => t.id === r.triggerId)?.name ?? t('automations.deletedTrigger')}</span>
                    <span class="ws-run-meta">{fmt(r.startedAt)} · {STATUS_LABEL[r.status] ?? r.status} · {r.url}</span>
                  </div>
                  {(r.summary || r.error) && <p class="ws-run-detail">{r.error ?? r.summary}</p>}
                  {r.fileArtifactNames && r.fileArtifactNames.length > 0 && (
                    <p class="ws-run-detail ws-dim">📎 {t('automations.savedToProducts')}: {r.fileArtifactNames.join(', ')}</p>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </details>
    </div>
  );
}
