import { useEffect, useRef, useState } from 'preact/hooks';
import type { AddFileResult, RepoInfo } from '../shared/messages';
import { UPLOAD_ACCEPT } from '../shared/uploadFile';
import { captureDropFull, itemsFromFiles, type DroppedItem } from './dropCapture';
import { useT } from './i18n';
import { uploadFilesToRepo } from './repoUploadClient';

/**
 * Add files to a repository — one shared, vertically-stacked uploader used in the
 * Knowledge-bases settings section (reveal-on-demand via "+ Add files") and the
 * composer (opened pre-loaded with dropped files). Every control is full-width
 * and stacks, so it fits the narrow side panel.
 *
 * - `initialFiles` opens the card with those files already queued (composer drop).
 * - `onDone` fires after a successful add (so the section can refresh counts).
 * - `onClose` (composer) dismisses the inline card.
 */
export interface UploadSummary {
  repo: string;
  added: number;
  chunks: number;
}

export function RepoUpload({
  initialItems,
  onDone,
  onClose,
}: {
  /** Pre-queued items (files or a captured email) — opens the card ready to add. */
  initialItems?: DroppedItem[];
  /** Called after a fully-successful add (the card then closes itself). */
  onDone?: (summary: UploadSummary) => void;
  onClose?: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(!!initialItems?.length);
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [target, setTarget] = useState(''); // '' = new repo
  const [newName, setNewName] = useState('');
  const [queue, setQueue] = useState<DroppedItem[]>(initialItems ?? []);
  const [results, setResults] = useState<AddFileResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Load the repo list whenever the card opens (so "Add to" is current).
  useEffect(() => {
    if (!open) return;
    chrome.runtime
      .sendMessage({ type: 'repo_list' })
      .then((list) => setRepos(Array.isArray(list) ? (list as RepoInfo[]) : []))
      .catch(() => setRepos([]));
  }, [open]);

  const addToQueue = (items: DroppedItem[]) => {
    if (items.length) {
      setQueue((q) => [...q, ...items]);
      setResults(null);
      setError(null);
    }
  };

  const submit = async () => {
    const repo = (target || newName).trim();
    if (!repo) {
      setError(t('repos.upload.needName'));
      return;
    }
    if (queue.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await uploadFilesToRepo(repo, queue.map((q) => q.file));
      setQueue([]);
      setNewName('');
      const added = res.filter((r) => r.ok);
      const chunks = added.reduce((n, r) => n + (r.chunks ?? 0), 0);
      if (added.length === res.length) {
        // Full success: acknowledge via the parent's banner and close the card.
        onDone?.({ repo, added: added.length, chunks });
        close();
      } else {
        // Some files were skipped — keep the card open so the failures are visible.
        setResults(res);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const close = () => {
    setOpen(false);
    setQueue([]);
    setResults(null);
    setError(null);
    onClose?.();
  };

  if (!open) {
    return (
      <button class="repo-upload-toggle" onClick={() => setOpen(true)}>
        ＋ {t('repos.upload.add')}
      </button>
    );
  }

  return (
    <div class="repo-upload">
      <div
        class={`repo-drop${dragOver ? ' drag-over' : ''}`}
        onDragOver={(e) => {
          const types = e.dataTransfer?.types;
          if (types?.includes('Files') || types?.includes('text/html') || types?.includes('text/plain')) {
            e.preventDefault();
            setDragOver(true);
          }
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          void captureDropFull(e.dataTransfer).then((items) => {
            if (items.length) addToQueue(items);
            else setError(t('repos.upload.nothing'));
          });
        }}
        tabIndex={0}
        onPaste={(e) => {
          // Paste a copied email (or file) directly onto the drop box.
          e.preventDefault();
          void captureDropFull(e.clipboardData).then((items) => {
            if (items.length) addToQueue(items);
          });
        }}
        onClick={() => inputRef.current?.click()}
      >
        <span class="repo-drop-hint">{t('repos.upload.dropHint')}</span>
        <span class="repo-drop-types">{t('repos.upload.types')}</span>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={UPLOAD_ACCEPT}
          style="display:none"
          onChange={(e) => {
            const fl = (e.target as HTMLInputElement).files;
            if (fl) void itemsFromFiles(Array.from(fl)).then((items) => addToQueue(items));
          }}
        />
      </div>

      <label class="field">
        <span>{t('repos.upload.target')}</span>
        <select value={target} onChange={(e) => setTarget((e.target as HTMLSelectElement).value)}>
          <option value="">{t('repos.upload.newRepo')}</option>
          {repos.map((r) => (
            <option key={r.name} value={r.name}>
              {r.name}
            </option>
          ))}
        </select>
      </label>
      {!target && (
        <label class="field">
          <span>{t('repos.upload.newName')}</span>
          <input
            type="text"
            value={newName}
            placeholder={t('repos.upload.newNamePlaceholder')}
            onInput={(e) => setNewName((e.target as HTMLInputElement).value)}
          />
        </label>
      )}

      {(queue.length > 0 || results) && (
        <ul class="repo-files">
          {queue.map((item, i) =>
            item.email ? (
              <li key={`q${i}`} class="repo-file repo-file-email">
                <div class="repo-email-head">
                  <span class="repo-email-badge">✉️ {t('repos.upload.emailBadge')}</span>
                  <span class="repo-file-status">{busy ? t('repos.upload.working') : t('repos.upload.queued')}</span>
                </div>
                <span class="repo-email-subject">{item.email.subject || item.file.name}</span>
                {(item.email.from || item.email.date) && (
                  <span class="repo-email-meta">
                    {item.email.from ? item.email.from : ''}
                    {item.email.from && item.email.date ? ' · ' : ''}
                    {item.email.date ? item.email.date : ''}
                  </span>
                )}
                {item.email.snippet && <span class="repo-email-snippet">{item.email.snippet}</span>}
              </li>
            ) : (
              <li key={`q${i}`} class="repo-file">
                <span class="repo-file-name">{item.file.name}</span>
                <span class="repo-file-status">{busy ? t('repos.upload.working') : t('repos.upload.queued')}</span>
              </li>
            ),
          )}
          {results?.map((r, i) => (
            <li key={`r${i}`} class={`repo-file${r.ok ? '' : ' is-skip'}`}>
              <span class="repo-file-name">{r.name}</span>
              <span class="repo-file-status">
                {r.ok
                  ? t('repos.upload.addedOne', { c: String(r.chunks ?? 0) })
                  : t('repos.upload.skippedOne', { why: r.error ?? '' })}
              </span>
            </li>
          ))}
        </ul>
      )}

      {error && <p class="settings-note repo-upload-error">{error}</p>}
      <p class="settings-note">{t('repos.upload.note')}</p>

      <div class="repo-upload-actions">
        <button class="btn btn-small btn-primary" disabled={busy || queue.length === 0} onClick={() => void submit()}>
          {busy ? t('repos.upload.working') : t('repos.upload.add')}
        </button>
        <button class="btn btn-small" onClick={close}>
          {results ? t('common.dismiss') : t('repos.upload.cancel')}
        </button>
      </div>
    </div>
  );
}
