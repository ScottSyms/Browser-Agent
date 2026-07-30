import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createScheduledTask, getScheduledTasks, updateScheduledTask } from './scheduler';

let alarms: Record<string, number>;

beforeEach(() => {
  const store: Record<string, unknown> = {};
  alarms = {};
  vi.stubGlobal('chrome', {
    storage: { local: {
      async get(k: string) { return k in store ? { [k]: store[k] } : {}; },
      async set(o: Record<string, unknown>) { Object.assign(store, o); },
    } },
    alarms: {
      create: (name: string, info: { when: number }) => { alarms[name] = info.when; },
      clear: async (name: string) => { delete alarms[name]; return true; },
    },
  });
});

describe('updateScheduledTask', () => {
  it('edits title/prompt without changing the next run time', async () => {
    const task = await createScheduledTask({ title: 'A', prompt: 'do a', recurrence: { kind: 'daily', timeOfDay: '09:00' } });
    const before = task.nextRunAt;
    const updated = await updateScheduledTask(task.id, { title: 'B', prompt: 'do b' });
    expect(updated?.title).toBe('B');
    expect(updated?.prompt).toBe('do b');
    expect(updated?.nextRunAt).toBe(before); // timing untouched when no timing field supplied
  });

  it('reschedules when a recurrence is supplied (recomputes nextRunAt + re-arms alarm)', async () => {
    const task = await createScheduledTask({ title: 'A', prompt: 'p', recurrence: { kind: 'daily', timeOfDay: '09:00' } });
    const before = task.nextRunAt;
    const updated = await updateScheduledTask(task.id, { recurrence: { kind: 'interval', intervalMinutes: 30 } });
    expect(updated?.recurrence).toEqual({ kind: 'interval', intervalMinutes: 30 });
    expect(updated?.nextRunAt).not.toBe(before);
    expect(alarms[`scheduled_task:${task.id}`]).toBe(updated!.nextRunAt); // alarm re-armed to the new time
  });

  it('switches a recurring task to a one-time runAt', async () => {
    const task = await createScheduledTask({ title: 'A', prompt: 'p', recurrence: { kind: 'daily', timeOfDay: '09:00' } });
    const runAt = new Date(Date.now() + 3_600_000).toISOString();
    const updated = await updateScheduledTask(task.id, { runAt, recurrence: null });
    expect(updated?.recurrence).toBeUndefined();
    expect(updated?.nextRunAt).toBe(Date.parse(runAt));
  });

  it('rejects a blank title', async () => {
    const task = await createScheduledTask({ title: 'A', prompt: 'p', recurrence: { kind: 'daily', timeOfDay: '09:00' } });
    await expect(updateScheduledTask(task.id, { title: '  ' })).rejects.toThrow(/title/i);
  });

  it('returns null for an unknown id', async () => {
    expect(await updateScheduledTask('nope', { title: 'X' })).toBeNull();
    expect(await getScheduledTasks()).toHaveLength(0);
  });
});
