import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Play, Square, Trash2, Save, RotateCcw, Download, Plus, X, FileText, Code } from 'lucide-react';
import { managedStacksApi } from '@/api/managed-stacks.api';
import type { ManagedStack, ManagedStackStatus } from '@oblihub/shared';
import toast from 'react-hot-toast';

const STATUS_STYLES: Record<ManagedStackStatus, string> = {
  draft: 'bg-bg-tertiary text-text-muted',
  deploying: 'bg-accent/10 text-accent',
  deployed: 'bg-status-up/10 text-status-up',
  stopped: 'bg-status-pending/10 text-status-pending',
  error: 'bg-status-down/10 text-status-down',
};

const STATUS_LABELS: Record<ManagedStackStatus, string> = {
  draft: 'Draft',
  deploying: 'Deploying...',
  deployed: 'Deployed',
  stopped: 'Stopped',
  error: 'Error',
};

const DEFAULT_COMPOSE = `version: "3.8"

services:
  app:
    image: nginx:latest
    ports:
      - "8080:80"
    restart: unless-stopped
`;

interface EnvEntry {
  key: string;
  value: string;
}

function parseEnvContent(content: string | null): EnvEntry[] {
  if (!content) return [];
  return content
    .split('\n')
    .filter(line => line.trim() && !line.startsWith('#'))
    .map(line => {
      const idx = line.indexOf('=');
      if (idx < 0) return { key: line.trim(), value: '' };
      return { key: line.substring(0, idx).trim(), value: line.substring(idx + 1).trim() };
    });
}

function entriesToEnvContent(entries: EnvEntry[]): string | null {
  const filtered = entries.filter(e => e.key.trim());
  if (filtered.length === 0) return null;
  return filtered.map(e => `${e.key}=${e.value}`).join('\n');
}

export function StackEditorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isNew = !id || id === 'new';

  const [stack, setStack] = useState<ManagedStack | null>(null);
  const [name, setName] = useState('');
  const [composeContent, setComposeContent] = useState(DEFAULT_COMPOSE);
  const [envMode, setEnvMode] = useState<'kv' | 'raw'>('kv');
  const [envEntries, setEnvEntries] = useState<EnvEntry[]>([]);
  const [envRaw, setEnvRaw] = useState('');
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    if (isNew) return;
    try {
      const s = await managedStacksApi.getById(Number(id));
      setStack(s);
      setName(s.name);
      setComposeContent(s.composeContent);
      const entries = parseEnvContent(s.envContent);
      setEnvEntries(entries);
      setEnvRaw(s.envContent || '');
      setDirty(false);
    } catch { toast.error('Failed to load stack'); }
    finally { setLoading(false); }
  }, [id, isNew]);

  useEffect(() => { load(); }, [load]);

  // Poll status while deploying
  useEffect(() => {
    if (!stack || stack.status !== 'deploying') return;
    const interval = setInterval(async () => {
      try {
        const s = await managedStacksApi.getById(stack.id);
        setStack(s);
        if (s.status !== 'deploying') clearInterval(interval);
      } catch { /* ignore */ }
    }, 2000);
    return () => clearInterval(interval);
  }, [stack?.id, stack?.status]);

  const getEnvContent = (): string | null => {
    if (envMode === 'kv') return entriesToEnvContent(envEntries);
    return envRaw.trim() || null;
  };

  const handleSave = async () => {
    if (!name.trim()) { toast.error('Stack name is required'); return; }
    if (!composeContent.trim()) { toast.error('Compose content is required'); return; }
    setSaving(true);
    try {
      const envContent = getEnvContent();
      if (isNew) {
        const created = await managedStacksApi.create({ name, composeContent, envContent });
        toast.success('Stack created');
        navigate(`/stack-editor/${created.id}`, { replace: true });
      } else {
        const updated = await managedStacksApi.update(Number(id), { name, composeContent, envContent });
        setStack(updated);
        toast.success('Stack saved');
      }
      setDirty(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Save failed';
      toast.error(msg);
    }
    finally { setSaving(false); }
  };

  const handleDeploy = async () => {
    if (!stack) return;
    // Save first if dirty
    if (dirty) await handleSave();
    try {
      await managedStacksApi.deploy(stack.id);
      toast.success('Deploying...');
      setStack(s => s ? { ...s, status: 'deploying' } : null);
    } catch { toast.error('Deploy failed'); }
  };

  const handleStop = async () => {
    if (!stack) return;
    try {
      await managedStacksApi.stop(stack.id);
      toast.success('Stack stopped');
      load();
    } catch { toast.error('Stop failed'); }
  };

  const handleDown = async () => {
    if (!stack) return;
    if (!confirm('This will stop and remove all containers for this stack. Continue?')) return;
    try {
      await managedStacksApi.down(stack.id);
      toast.success('Stack downed');
      load();
    } catch { toast.error('Down failed'); }
  };

  const handleDelete = async () => {
    if (!stack) return;
    if (!confirm('Delete this managed stack? This will also remove its containers if deployed.')) return;
    try {
      await managedStacksApi.delete(stack.id);
      toast.success('Stack deleted');
      navigate('/managed-stacks');
    } catch { toast.error('Delete failed'); }
  };

  const handleRedeploy = async () => {
    if (!stack) return;
    if (dirty) await handleSave();
    try {
      await managedStacksApi.redeploy(stack.id);
      toast.success('Redeploying (pull + up)...');
      setStack(s => s ? { ...s, status: 'deploying' } : null);
    } catch { toast.error('Redeploy failed'); }
  };

  const addEnvEntry = () => {
    setEnvEntries(e => [...e, { key: '', value: '' }]);
    setDirty(true);
  };

  const updateEnvEntry = (idx: number, field: 'key' | 'value', val: string) => {
    setEnvEntries(e => e.map((entry, i) => i === idx ? { ...entry, [field]: val } : entry));
    setDirty(true);
  };

  const removeEnvEntry = (idx: number) => {
    setEnvEntries(e => e.filter((_, i) => i !== idx));
    setDirty(true);
  };

  const switchEnvMode = (mode: 'kv' | 'raw') => {
    if (mode === 'raw' && envMode === 'kv') {
      setEnvRaw(entriesToEnvContent(envEntries) || '');
    } else if (mode === 'kv' && envMode === 'raw') {
      setEnvEntries(parseEnvContent(envRaw));
    }
    setEnvMode(mode);
  };

  if (loading) return <div className="flex items-center justify-center h-full"><div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" /></div>;

  return (
    <div className="p-6 max-w-6xl">
      <button onClick={() => navigate('/managed-stacks')} className="flex items-center gap-1 text-sm text-text-muted hover:text-text-primary mb-4">
        <ArrowLeft size={14} /> Back to Stacks
      </button>

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <input
            value={name}
            onChange={e => { setName(e.target.value); setDirty(true); }}
            placeholder="Stack name"
            className="text-xl font-semibold text-text-primary bg-transparent border-b border-transparent hover:border-border focus:border-accent focus:outline-none pb-0.5 transition-colors"
          />
          {stack && (
            <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[stack.status]}`}>
              {STATUS_LABELS[stack.status]}
            </span>
          )}
          {dirty && <span className="text-[10px] text-status-pending">unsaved</span>}
        </div>

        <div className="flex items-center gap-2">
          <button onClick={handleSave} disabled={saving} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover disabled:opacity-50">
            <Save size={14} /> {saving ? 'Saving...' : 'Save'}
          </button>
          {!isNew && stack && (
            <>
              {stack.status !== 'deployed' && stack.status !== 'deploying' && (
                <button onClick={handleDeploy} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-status-up text-white hover:bg-status-up/80">
                  <Play size={14} /> Deploy
                </button>
              )}
              {stack.status === 'deployed' && (
                <>
                  <button onClick={handleRedeploy} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover">
                    <RotateCcw size={14} /> Redeploy
                  </button>
                  <button onClick={handleStop} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-status-pending text-status-pending hover:bg-status-pending/10">
                    <Square size={14} /> Stop
                  </button>
                  <button onClick={handleDown} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-status-down text-status-down hover:bg-status-down/10">
                    <Download size={14} className="rotate-180" /> Down
                  </button>
                </>
              )}
              <button onClick={handleDelete} className="p-1.5 rounded-lg text-text-muted hover:text-status-down hover:bg-bg-hover" title="Delete stack">
                <Trash2 size={16} />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Error message */}
      {stack?.errorMessage && (
        <div className="rounded-lg border border-status-down/30 bg-status-down/5 p-3 mb-4">
          <div className="text-xs font-medium text-status-down mb-1">Error</div>
          <pre className="text-xs text-text-secondary whitespace-pre-wrap font-mono max-h-32 overflow-auto">{stack.errorMessage}</pre>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Compose editor - 2/3 width */}
        <div className="lg:col-span-2">
          <div className="rounded-xl border border-border bg-bg-secondary overflow-hidden">
            <div className="px-4 py-2.5 border-b border-border flex items-center gap-2">
              <Code size={14} className="text-text-muted" />
              <h2 className="text-sm font-semibold text-text-secondary">docker-compose.yml</h2>
            </div>
            <textarea
              value={composeContent}
              onChange={e => { setComposeContent(e.target.value); setDirty(true); }}
              spellCheck={false}
              className="w-full h-[500px] p-4 font-mono text-sm text-text-primary bg-[#0d1117] resize-none focus:outline-none leading-relaxed"
              placeholder="version: '3.8'&#10;&#10;services:&#10;  ..."
            />
          </div>
        </div>

        {/* Env editor - 1/3 width */}
        <div>
          <div className="rounded-xl border border-border bg-bg-secondary overflow-hidden">
            <div className="px-4 py-2.5 border-b border-border flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileText size={14} className="text-text-muted" />
                <h2 className="text-sm font-semibold text-text-secondary">Environment</h2>
              </div>
              <div className="flex bg-bg-tertiary rounded-md">
                <button
                  onClick={() => switchEnvMode('kv')}
                  className={`px-2 py-0.5 text-[10px] rounded-md transition-colors ${envMode === 'kv' ? 'bg-accent text-white' : 'text-text-muted hover:text-text-primary'}`}
                >
                  Key/Value
                </button>
                <button
                  onClick={() => switchEnvMode('raw')}
                  className={`px-2 py-0.5 text-[10px] rounded-md transition-colors ${envMode === 'raw' ? 'bg-accent text-white' : 'text-text-muted hover:text-text-primary'}`}
                >
                  Raw
                </button>
              </div>
            </div>

            {envMode === 'kv' ? (
              <div className="p-3 space-y-2 max-h-[460px] overflow-auto">
                {envEntries.map((entry, i) => (
                  <div key={i} className="flex gap-1.5 items-center">
                    <input
                      value={entry.key}
                      onChange={e => updateEnvEntry(i, 'key', e.target.value)}
                      placeholder="KEY"
                      className="flex-1 min-w-0 rounded border border-border bg-bg-tertiary px-2 py-1 text-xs font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                    />
                    <span className="text-text-muted text-xs">=</span>
                    <input
                      value={entry.value}
                      onChange={e => updateEnvEntry(i, 'value', e.target.value)}
                      placeholder="value"
                      className="flex-1 min-w-0 rounded border border-border bg-bg-tertiary px-2 py-1 text-xs font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                    />
                    <button onClick={() => removeEnvEntry(i)} className="p-0.5 text-text-muted hover:text-status-down shrink-0">
                      <X size={12} />
                    </button>
                  </div>
                ))}
                <button onClick={addEnvEntry} className="flex items-center gap-1 text-xs text-accent hover:text-accent-hover">
                  <Plus size={12} /> Add variable
                </button>
              </div>
            ) : (
              <textarea
                value={envRaw}
                onChange={e => { setEnvRaw(e.target.value); setDirty(true); }}
                spellCheck={false}
                className="w-full h-[460px] p-3 font-mono text-xs text-text-primary bg-[#0d1117] resize-none focus:outline-none leading-relaxed"
                placeholder="DB_HOST=localhost&#10;DB_PORT=5432&#10;DB_PASSWORD=secret"
              />
            )}
          </div>
        </div>
      </div>

      {/* Stack info */}
      {stack && (
        <div className="mt-4 text-xs text-text-muted flex items-center gap-4">
          <span>Project: <code className="bg-bg-tertiary px-1 py-0.5 rounded">{stack.composeProject}</code></span>
          <span>Created: {new Date(stack.createdAt).toLocaleString()}</span>
          <span>Updated: {new Date(stack.updatedAt).toLocaleString()}</span>
        </div>
      )}
    </div>
  );
}
