import { useEffect, useRef, useState } from 'react';
import { Upload, GitBranch, FileCode, RefreshCw, FolderTree, ChevronDown, ChevronRight } from 'lucide-react';
import { managedStacksApi } from '@/api/managed-stacks.api';
import type { ManagedStack } from '@oblihub/shared';
import toast from 'react-hot-toast';

/**
 * Source panel for a managed stack. Lets the operator point the stack's working directory
 * at one of three things:
 *
 *   - compose-only — legacy mode, no upload, just paste compose + env in the editor
 *   - zip          — upload a tarball (re-uploadable; .env is preserved across replacements)
 *   - git          — clone from a repo URL + branch; refreshable via "Pull latest"
 *
 * The build pipeline (next iteration) reads from the resulting dir. This panel is only
 * about ingesting source — discovery + env-form + build come after.
 */
export function SourcePanel({ stack, onStackUpdated }: { stack: ManagedStack; onStackUpdated: (s: ManagedStack) => void }) {
  const [sourceType, setSourceType] = useState(stack.sourceType);
  const [gitUrl, setGitUrl] = useState(stack.gitUrl || '');
  const [gitBranch, setGitBranch] = useState(stack.gitBranch || 'main');
  const [busy, setBusy] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [files, setFiles] = useState<{ path: string; size: number; isDir: boolean }[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Sync local state when the parent feeds in a fresh stack (e.g. after re-fetch).
  useEffect(() => {
    setSourceType(stack.sourceType);
    setGitUrl(stack.gitUrl || '');
    setGitBranch(stack.gitBranch || 'main');
  }, [stack.id, stack.sourceType, stack.gitUrl, stack.gitBranch]);

  const handleZipChosen = async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.zip')) {
      toast.error('Please choose a .zip file');
      return;
    }
    setBusy(true);
    try {
      const updated = await managedStacksApi.uploadZip(stack.id, file);
      toast.success(`Uploaded ${file.name} (${formatSize(file.size)})`);
      onStackUpdated(updated);
      if (showFiles) void loadFiles();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upload failed';
      toast.error(message);
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleGitSet = async () => {
    if (!gitUrl.trim()) { toast.error('Git URL is required'); return; }
    setBusy(true);
    try {
      const updated = await managedStacksApi.setGitSource(stack.id, gitUrl.trim(), gitBranch.trim() || 'main');
      toast.success('Repo cloned');
      onStackUpdated(updated);
      if (showFiles) void loadFiles();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Clone failed');
    } finally { setBusy(false); }
  };

  const handleGitPull = async () => {
    setBusy(true);
    try {
      const updated = await managedStacksApi.gitPull(stack.id);
      toast.success(`Pulled to ${updated.gitRef || 'latest'}`);
      onStackUpdated(updated);
      if (showFiles) void loadFiles();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Pull failed');
    } finally { setBusy(false); }
  };

  const loadFiles = async () => {
    try {
      setFiles(await managedStacksApi.listSourceFiles(stack.id));
    } catch { /* silent — the dir might be empty */ }
  };

  const toggleFiles = () => {
    setShowFiles(s => {
      const next = !s;
      if (next) void loadFiles();
      return next;
    });
  };

  return (
    <div className="rounded-xl border border-border bg-bg-secondary overflow-hidden mb-4">
      <div className="px-4 py-2.5 border-b border-border flex items-center gap-2">
        <FileCode size={14} className="text-text-muted" />
        <h2 className="text-sm font-semibold text-text-secondary">Source</h2>
        {stack.lastSourceSyncAt && stack.sourceType !== 'compose-only' && (
          <span className="text-[10px] text-text-muted ml-auto">
            Last sync: {new Date(stack.lastSourceSyncAt).toLocaleString()}
            {stack.gitRef && <span className="font-mono ml-2">@ {stack.gitRef}</span>}
          </span>
        )}
      </div>

      <div className="p-4 space-y-3">
        {/* Source type toggle */}
        <div className="flex gap-1 bg-bg-tertiary rounded-lg p-1 w-fit">
          {(['compose-only', 'zip', 'git'] as const).map(t => (
            <button
              key={t}
              onClick={() => setSourceType(t)}
              className={`px-3 py-1 text-xs rounded-md transition-colors ${
                sourceType === t ? 'bg-accent text-white' : 'text-text-muted hover:text-text-primary'
              }`}
            >
              {t === 'compose-only' ? 'Compose only' : t === 'zip' ? 'ZIP upload' : 'Git repo'}
            </button>
          ))}
        </div>

        {sourceType === 'compose-only' && (
          <p className="text-xs text-text-muted">
            Default mode — write your <code className="bg-bg-tertiary px-1 rounded">docker-compose.yml</code>
            {' '}directly in the editor below. No source files to upload.
          </p>
        )}

        {sourceType === 'zip' && (
          <div className="space-y-2">
            <p className="text-xs text-text-muted">
              Upload a <code className="bg-bg-tertiary px-1 rounded">.zip</code> of your project. Re-uploading replaces
              everything cleanly — your <code className="bg-bg-tertiary px-1 rounded">.env</code> is preserved across uploads.
            </p>
            <div className="flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept=".zip,application/zip"
                onChange={e => { const f = e.target.files?.[0]; if (f) void handleZipChosen(f); }}
                className="hidden"
                id={`zip-upload-${stack.id}`}
              />
              <label
                htmlFor={`zip-upload-${stack.id}`}
                className={`inline-flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-lg cursor-pointer ${
                  busy ? 'bg-bg-tertiary text-text-muted cursor-not-allowed' : 'bg-accent text-white hover:bg-accent-hover'
                }`}
              >
                <Upload size={13} /> {stack.sourceType === 'zip' && stack.lastSourceSyncAt ? 'Re-upload ZIP' : 'Upload ZIP'}
              </label>
              {stack.sourceType === 'zip' && stack.lastSourceSyncAt && (
                <span className="text-[11px] text-text-muted">
                  Current sources from {new Date(stack.lastSourceSyncAt).toLocaleString()}
                </span>
              )}
            </div>
          </div>
        )}

        {sourceType === 'git' && (
          <div className="space-y-3">
            <p className="text-xs text-text-muted">
              Clone from a git repo. Use a deploy key or HTTPS-with-token URL for private repos. Use{' '}
              <strong>Pull latest</strong> to refresh without re-typing the URL.
            </p>
            <div className="grid grid-cols-[1fr_140px] gap-2">
              <input
                type="text"
                value={gitUrl}
                onChange={e => setGitUrl(e.target.value)}
                placeholder="https://github.com/user/repo.git"
                className="rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-xs font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
              />
              <input
                type="text"
                value={gitBranch}
                onChange={e => setGitBranch(e.target.value)}
                placeholder="main"
                className="rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-xs font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
              />
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => void handleGitSet()}
                disabled={busy || !gitUrl.trim()}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-lg bg-accent text-white hover:bg-accent-hover disabled:opacity-50"
              >
                <GitBranch size={13} /> {stack.sourceType === 'git' ? 'Re-clone' : 'Clone'}
              </button>
              {stack.sourceType === 'git' && stack.gitUrl && (
                <button
                  onClick={() => void handleGitPull()}
                  disabled={busy}
                  className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-lg border border-border text-text-secondary hover:bg-bg-hover disabled:opacity-50"
                >
                  <RefreshCw size={13} /> Pull latest
                </button>
              )}
            </div>
          </div>
        )}

        {/* File listing — collapsed by default, shown when relevant */}
        {sourceType !== 'compose-only' && (
          <div className="border-t border-border pt-3">
            <button
              onClick={toggleFiles}
              className="text-[11px] text-text-muted hover:text-text-primary inline-flex items-center gap-1"
            >
              {showFiles ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              <FolderTree size={11} /> Files on disk{showFiles && files.length > 0 && ` (${files.filter(f => !f.isDir).length})`}
            </button>
            {showFiles && (
              <div className="mt-2 max-h-48 overflow-auto rounded bg-bg-primary border border-border p-2 font-mono text-[10px] leading-relaxed">
                {files.length === 0 ? (
                  <div className="text-text-muted italic">No files yet — upload a ZIP or clone a repo.</div>
                ) : (
                  files.map(f => (
                    <div key={f.path} className={f.isDir ? 'text-accent' : 'text-text-secondary'}>
                      {f.isDir ? '📁 ' : '   '}{f.path}
                      {!f.isDir && <span className="text-text-muted ml-2">{formatSize(f.size)}</span>}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
