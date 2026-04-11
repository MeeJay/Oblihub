import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Play, Square, Trash2, Save, RotateCcw, Download, Plus, X, FileText, Code, Link, Box, AlertTriangle } from 'lucide-react';
import { managedStacksApi } from '@/api/managed-stacks.api';
import { systemApi } from '@/api/stacks.api';
import { teamsApi } from '@/api/teams.api';
import { useAuthStore } from '@/store/authStore';
import type { Team } from '@oblihub/shared';
import { ComposePreview } from '@/components/ComposePreview';
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
  const [isSelf, setIsSelf] = useState(false);
  const [teams, setTeams] = useState<Team[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<number | null>(null);
  const { user } = useAuthStore();
  const isAdmin = user?.role === 'admin';

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

  // Load teams for non-admin stack creation
  useEffect(() => {
    teamsApi.list().then(t => {
      setTeams(t);
      if (t.length > 0 && !selectedTeamId) setSelectedTeamId(t[0].id);
    }).catch(() => {});
  }, []);

  // Detect self stack
  useEffect(() => {
    if (!stack) return;
    systemApi.getFeatures().then(f => {
      if (f.selfProject && stack.composeProject === f.selfProject) {
        setIsSelf(true);
      }
    }).catch(() => {});
  }, [stack?.composeProject]);

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
    if (isNew && !isAdmin && !selectedTeamId) { toast.error('Select a team for this stack'); return; }
    setSaving(true);
    try {
      const envContent = getEnvContent();
      if (isNew) {
        const created = await managedStacksApi.create({ name, composeContent, envContent, teamId: isAdmin ? selectedTeamId : selectedTeamId! });
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
    const content = composeContent.trim();
    if (!content || (!content.includes('image:') && !content.includes('build:'))) {
      toast.error('Cannot deploy: compose file has no services with an image or build directive.');
      return;
    }
    const confirmMsg = isSelf
      ? '⚠️ You are about to redeploy OBLIHUB ITSELF.\n\nIf the compose is invalid, you will lose access to this interface.\n\nAre you absolutely sure?'
      : 'Deploy this stack? This will create/recreate containers.';
    if (!confirm(confirmMsg)) return;
    // Save first if dirty
    if (dirty) await handleSave();
    try {
      await managedStacksApi.deploy(stack.id);
      toast.success('Deploying...');
      setStack(s => s ? { ...s, status: 'deploying' } : null);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Deploy failed';
      toast.error(msg);
    }
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
    <div className="p-6">
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
          {isNew && teams.length > 0 && (
            <select value={selectedTeamId || ''} onChange={e => setSelectedTeamId(parseInt(e.target.value) || null)}
              className="rounded-lg border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent">
              {isAdmin && <option value="">No team</option>}
              {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          )}
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
                  {!isSelf && (
                    <>
                      <button onClick={handleStop} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-status-pending text-status-pending hover:bg-status-pending/10">
                        <Square size={14} /> Stop
                      </button>
                      <button onClick={handleDown} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-status-down text-status-down hover:bg-status-down/10">
                        <Download size={14} className="rotate-180" /> Down
                      </button>
                    </>
                  )}
                </>
              )}
              {!isSelf && (
                <button onClick={handleDelete} className="p-1.5 rounded-lg text-text-muted hover:text-status-down hover:bg-bg-hover" title="Delete stack">
                  <Trash2 size={16} />
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Self-management warning */}
      {isSelf && (
        <div className="rounded-lg border border-accent/30 bg-accent/5 p-3 mb-4 flex items-start gap-2">
          <AlertTriangle size={14} className="text-accent shrink-0 mt-0.5" />
          <div className="text-xs text-text-secondary">
            <span className="font-semibold text-accent">This is Oblihub's own stack.</span> You can edit and redeploy, but Stop, Down and Delete are disabled. If you deploy an invalid compose, you may lose access to this interface.
          </div>
        </div>
      )}

      {/* Deploy output */}
      {stack?.errorMessage && (
        <div className={`rounded-lg border p-3 mb-4 ${stack.status === 'error' ? 'border-status-down/30 bg-status-down/5' : 'border-status-up/30 bg-status-up/5'}`}>
          <div className={`text-xs font-medium mb-1 ${stack.status === 'error' ? 'text-status-down' : 'text-status-up'}`}>
            {stack.status === 'error' ? 'Error' : 'Deploy Output'}
          </div>
          <pre className="text-xs text-text-secondary whitespace-pre-wrap font-mono max-h-48 overflow-auto bg-[#0d1117] rounded p-2 mt-1">{stack.errorMessage}</pre>
        </div>
      )}
      {stack?.status === 'deploying' && (
        <div className="rounded-lg border border-accent/30 bg-accent/5 p-3 mb-4">
          <div className="flex items-center gap-2 text-xs font-medium text-accent">
            <div className="h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent" />
            Deploying... This may take a moment.
          </div>
        </div>
      )}

      {/* Relative path warning */}
      {composeContent.includes('./') && (
        <div className="rounded-lg border border-status-pending/30 bg-status-pending/5 p-3 mb-4">
          <div className="text-xs font-medium text-status-pending mb-1">Warning: Relative paths detected</div>
          <div className="text-xs text-text-secondary">
            Your compose file uses relative paths (<code className="bg-bg-tertiary px-1 rounded">./</code>). These resolve relative to Oblihub's stack directory (<code className="bg-bg-tertiary px-1 rounded">/data/stacks/{stack?.composeProject || name.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}/</code>), not the original location. Use <strong>absolute paths</strong> to mount existing data.
          </div>
        </div>
      )}

      {/* Compose + Env side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 mb-6">
        {/* Compose editor - 3/5 */}
        <div className="lg:col-span-3">
          <div className="rounded-xl border border-border bg-bg-secondary overflow-hidden h-full">
            <div className="px-4 py-2.5 border-b border-border flex items-center gap-2">
              <Code size={14} className="text-text-muted" />
              <h2 className="text-sm font-semibold text-text-secondary">docker-compose.yml</h2>
            </div>
            <textarea
              value={composeContent}
              onChange={e => { setComposeContent(e.target.value); setDirty(true); }}
              spellCheck={false}
              className="w-full h-[450px] p-4 font-mono text-sm text-text-primary bg-[#0d1117] resize-none focus:outline-none leading-relaxed"
              placeholder="version: '3.8'&#10;&#10;services:&#10;  ..."
            />
          </div>
        </div>

        {/* Env editor - 2/5 */}
        <div className="lg:col-span-2">
          <div className="rounded-xl border border-border bg-bg-secondary overflow-hidden h-full">
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
              <div className="p-3 space-y-2 overflow-auto" style={{ maxHeight: '412px' }}>
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
                className="w-full h-[412px] p-3 font-mono text-xs text-text-primary bg-[#0d1117] resize-none focus:outline-none leading-relaxed"
                placeholder="DB_HOST=localhost&#10;DB_PORT=5432&#10;DB_PASSWORD=secret"
              />
            )}
          </div>
        </div>
      </div>

      {/* Preview - full width below */}
      <div className="rounded-xl border border-border bg-bg-secondary overflow-hidden mb-6">
        <div className="px-4 py-2.5 border-b border-border flex items-center gap-2">
          <Box size={14} className="text-text-muted" />
          <h2 className="text-sm font-semibold text-text-secondary">Preview</h2>
        </div>
        <div className="p-4">
          <ComposePreview composeContent={composeContent} />
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
