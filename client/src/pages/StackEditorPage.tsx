import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Play, Square, Trash2, Save, RotateCcw, Download, Plus, X, FileText, Code, Link, Box, AlertTriangle, XCircle, Terminal } from 'lucide-react';
import { managedStacksApi } from '@/api/managed-stacks.api';
import { systemApi } from '@/api/stacks.api';
import { teamsApi } from '@/api/teams.api';
import { useAuthStore } from '@/store/authStore';
import { useSocket } from '@/hooks/useSocket';
import type { Team } from '@oblihub/shared';
import { ComposePreview, extractHostPort, type PortConflict } from '@/components/ComposePreview';
import { SourcePanel } from '@/components/SourcePanel';
import yaml from 'js-yaml';
import { SOCKET_EVENTS, type ManagedStack, type ManagedStackStatus } from '@oblihub/shared';
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
  const [engines, setEngines] = useState<{ id: number; name: string; type: string; isDefault: boolean; enabled: boolean }[]>([]);
  const [selectedEngineId, setSelectedEngineId] = useState<number | null>(null);
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
      setSelectedEngineId(s.engineId ?? null);
      setDirty(false);
    } catch { toast.error('Failed to load stack'); }
    finally { setLoading(false); }
  }, [id, isNew]);

  useEffect(() => { load(); }, [load]);

  // Load teams for non-admin stack creation
  useEffect(() => {
    teamsApi.list().then(t => {
      setTeams(t);
      // Admins default to "No team" (null) — they can opt-in to a team via the dropdown.
      // Non-admins must own a team; pre-select the first one as a convenience since the form
      // refuses to submit without a team for them anyway.
      if (!isAdmin && t.length > 0 && !selectedTeamId) setSelectedTeamId(t[0].id);
    }).catch(() => {});
  }, [isAdmin]);

  // Load engines for the target-engine picker (admin only)
  useEffect(() => {
    if (!isAdmin) return;
    import('@/api/engines.api').then(({ enginesApi }) => {
      enginesApi.list().then(list => {
        setEngines(list);
        // Default to the default engine on new stacks
        if (isNew && selectedEngineId == null) {
          const def = list.find(e => e.isDefault) || list[0];
          if (def) setSelectedEngineId(def.id);
        }
      }).catch(() => {});
    });
  }, [isAdmin, isNew, selectedEngineId]);

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

  // Build the env var map used to resolve ${VAR} refs in the compose preview.
  const resolvedEnvVars = (() => {
    const map: Record<string, string> = {};
    if (envMode === 'kv') {
      for (const e of envEntries) { if (e.key) map[e.key] = e.value; }
    } else {
      for (const line of envRaw.split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
        if (!m) continue;
        let val = m[2];
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        map[m[1]] = val;
      }
    }
    return map;
  })();

  // ── Port conflict detection ──
  // Extract every host port declared by this stack's compose, then ask the server which ones
  // are already in use by another container on the same engine. Debounced 500ms so we don't
  // spam the API on each keystroke. The result feeds two UI surfaces: a red banner above the
  // editor + per-port "!" markers in the ComposePreview.
  const [portConflicts, setPortConflicts] = useState<PortConflict[]>([]);
  useEffect(() => {
    if (!composeContent.trim()) { setPortConflicts([]); return; }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        // Reuse the same env-substitution semantics as ComposePreview by parsing the YAML
        // here too — keeps the two views consistent.
        const doc = yaml.load(composeContent) as { services?: Record<string, { ports?: unknown[] }> } | null;
        const services = doc?.services || {};
        const hostPorts = new Set<number>();
        const substitute = (s: string): string => s
          .replace(/\$\{([A-Z_][A-Z0-9_]*):-([^}]*)\}/gi, (_, n, d) => resolvedEnvVars[n] || d)
          .replace(/\$\{([A-Z_][A-Z0-9_]*)\}/gi, (_, n) => resolvedEnvVars[n] || '')
          .replace(/\$([A-Z_][A-Z0-9_]*)/gi, (_, n) => resolvedEnvVars[n] || '');
        for (const svc of Object.values(services)) {
          if (!Array.isArray(svc?.ports)) continue;
          for (const p of svc.ports as unknown[]) {
            let str: string;
            if (typeof p === 'string' || typeof p === 'number') str = String(p);
            else if (p && typeof p === 'object') {
              const o = p as { published?: unknown; target?: unknown };
              if (o.published != null && o.target != null) str = `${o.published}:${o.target}`;
              else continue;
            } else continue;
            const resolved = substitute(str);
            const hp = extractHostPort(resolved);
            if (hp != null) hostPorts.add(hp);
          }
        }
        if (hostPorts.size === 0) { if (!cancelled) setPortConflicts([]); return; }
        // For an existing stack: exclude by compose_project name — the link between
        // managed_stacks (where stack.id lives) and the discovered `stacks` table is
        // compose_project, not numeric id. For a brand new stack, derive the project name
        // we'll be using at deploy time so a user editing pre-deploy still gets self-exclusion.
        const excludeComposeProject =
          stack?.composeProject ||
          (name ? name.toLowerCase().replace(/[^a-z0-9_-]/g, '-') : undefined);
        const result = await managedStacksApi.checkPortConflicts({
          engineId: selectedEngineId,
          ports: [...hostPorts],
          excludeComposeProject,
        });
        if (!cancelled) setPortConflicts(result.conflicts.map(c => ({ port: c.port, stackName: c.stackName, containerName: c.containerName })));
      } catch {
        // YAML parse fails or API down — just clear so we don't show stale conflicts on broken input.
        if (!cancelled) setPortConflicts([]);
      }
    }, 500);
    return () => { cancelled = true; clearTimeout(timer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- resolvedEnvVars is a fresh object each render; we re-resolve on compose/env changes
  }, [composeContent, envRaw, JSON.stringify(envEntries), selectedEngineId, stack?.id, stack?.composeProject, name]);

  const handleDeletePort = (serviceName: string, rawPort: string) => {
    // Find and remove the port line within the named service's ports list.
    // Escape regex special chars in the port string.
    const escaped = rawPort.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Match: `- "port"` or `- port` on its own line, with any surrounding whitespace and optional quotes.
    const portLineRe = new RegExp(`\\n[ \\t]+-[ \\t]+["']?${escaped}["']?[ \\t]*(?=\\r?\\n|$)`);
    // Restrict to the target service block. Match service header + indented body.
    const serviceRe = new RegExp(`((?:^|\\n)[ \\t]*${serviceName}:(?:\\r?\\n)(?:[ \\t]+[^\\n]*(?:\\r?\\n)?)+)`, 'm');
    const m = composeContent.match(serviceRe);
    if (!m) { toast.error(`Service "${serviceName}" not found in compose`); return; }
    const block = m[0];
    const newBlock = block.replace(portLineRe, '');
    if (newBlock === block) { toast.error(`Port "${rawPort}" not found in ${serviceName}`); return; }
    setComposeContent(composeContent.replace(block, newBlock));
    setDirty(true);
    toast.success(`Removed port ${rawPort}`);
  };

  // Engine-change modal state. Populated when the user picks a different engine on an
  // already-deployed stack, gated through `handleSave` to force a deliberate choice between
  // just-save (orphan), stop-and-deploy (clean cut), or migrate-data (full move).
  const [engineMigration, setEngineMigration] = useState<null | {
    fromEngineId: number | null;
    toEngineId: number | null;
    namedVolumes: string[];
    bindMounts: string[];
    loading: boolean;
  }>(null);

  const handleSave = async () => {
    if (!name.trim()) { toast.error('Stack name is required'); return; }
    if (!composeContent.trim()) { toast.error('Compose content is required'); return; }
    if (isNew && !isAdmin && !selectedTeamId) { toast.error('Select a team for this stack'); return; }

    // If the operator changed the target engine on a stack that's actually deployed, surface
    // the migration modal before doing anything destructive. The 3 choices map to different
    // back-end strategies; we never silently leave containers behind.
    if (!isNew && stack && stack.status === 'deployed' && selectedEngineId !== stack.engineId) {
      setEngineMigration({
        fromEngineId: stack.engineId,
        toEngineId: selectedEngineId,
        namedVolumes: [],
        bindMounts: [],
        loading: true,
      });
      try {
        const preview = await managedStacksApi.previewMigration(Number(id));
        setEngineMigration({
          fromEngineId: stack.engineId,
          toEngineId: selectedEngineId,
          namedVolumes: preview.named,
          bindMounts: preview.binds,
          loading: false,
        });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to inspect volumes');
        setEngineMigration(null);
      }
      return;
    }

    setSaving(true);
    try {
      const envContent = getEnvContent();
      if (isNew) {
        const created = await managedStacksApi.create({ name, composeContent, envContent, teamId: isAdmin ? selectedTeamId : selectedTeamId!, engineId: selectedEngineId });
        toast.success('Stack created');
        navigate(`/stack-editor/${created.id}`, { replace: true });
      } else {
        const updated = await managedStacksApi.update(Number(id), { name, composeContent, envContent, engineId: selectedEngineId });
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

  /** Confirm the engine migration with the chosen strategy. Closes the modal on completion. */
  const confirmEngineMigration = async (strategy: 'just-save' | 'stop-and-deploy' | 'migrate-data') => {
    if (!engineMigration) return;
    const targetEngineId = engineMigration.toEngineId;
    setEngineMigration(null);
    setSaving(true);
    try {
      // Save the rest of the form first (name / compose / env) so a single user action lands
      // ALL pending edits, then do the engine migration. The migrate-engine endpoint flips
      // engine_id itself — we pre-save with the OLD engine id to avoid a confusing race.
      const envContent = getEnvContent();
      await managedStacksApi.update(Number(id), {
        name, composeContent, envContent,
        engineId: stack?.engineId ?? null,
      });
      const result = await managedStacksApi.migrateEngine(Number(id), { targetEngineId, strategy });
      setStack(result.stack);
      setSelectedEngineId(result.stack.engineId ?? null);
      setDirty(false);
      const stratLabel = strategy === 'just-save' ? 'saved (old containers orphaned)'
        : strategy === 'stop-and-deploy' ? 'stopped on old engine + redeployed'
        : `migrated ${result.migrated.length} volume(s) + redeployed`;
      toast.success(`Engine migration: ${stratLabel}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Migration failed');
    } finally { setSaving(false); }
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

  const handleCancel = async () => {
    if (!stack) return;
    if (!confirm('Cancel this deployment? Any running compose command will be killed.')) return;
    try {
      const { killed } = await managedStacksApi.cancel(stack.id);
      toast.success(killed ? 'Deployment cancelled' : 'Status reset');
      load();
    } catch { toast.error('Cancel failed'); }
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
            onChange={e => { setName(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '-')); setDirty(true); }}
            placeholder="stack-name"
            title="Lowercase letters, digits, - and _ only (Docker project naming rules)"
            className="text-xl font-semibold text-text-primary bg-transparent border-b border-transparent hover:border-border focus:border-accent focus:outline-none pb-0.5 transition-colors"
          />
          {stack && (
            <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[stack.status]}`}>
              {STATUS_LABELS[stack.status]}
            </span>
          )}
          {dirty && <span className="text-[10px] text-status-pending">unsaved</span>}
          {isNew && teams.length > 0 && (
            !isAdmin && teams.length === 1 ? (
              // Non-admin with a single team — team is locked. Show as a readonly badge so the
              // user knows where the stack lands; an admin can reassign later if needed.
              <span
                className="rounded-lg border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-muted"
                title="Team is fixed — only an admin can reassign this stack."
              >
                Team: <span className="text-text-primary">{teams[0].name}</span>
              </span>
            ) : (
              <select value={selectedTeamId || ''} onChange={e => setSelectedTeamId(parseInt(e.target.value) || null)}
                className="rounded-lg border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent">
                {isAdmin && <option value="">No team</option>}
                {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            )
          )}
          {isAdmin && engines.length > 1 && (
            <select value={selectedEngineId || ''} onChange={e => { setSelectedEngineId(parseInt(e.target.value) || null); setDirty(true); }}
              title="Docker engine where this stack will be deployed"
              className="rounded-lg border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent">
              {engines.filter(e => e.enabled).map(e => (
                <option key={e.id} value={e.id} disabled={e.type === 'https-apikey'}>
                  ⚙ {e.name}{e.type === 'https-apikey' ? ' (API key — deploy not supported)' : ''}{e.isDefault ? ' (default)' : ''}
                </option>
              ))}
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
              {stack.status === 'deploying' && (
                <button onClick={handleCancel} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-status-down text-white hover:bg-status-down/80">
                  <XCircle size={14} /> Cancel
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
      {stack && (stack.status === 'deploying' || stack.composeProject) && (
        <DeployLogPanel
          projectName={stack.composeProject}
          isDeploying={stack.status === 'deploying'}
          onCancel={handleCancel}
        />
      )}

      {/* Engine migration modal — opens when handleSave detects a deployed-stack engine change */}
      {engineMigration && stack && (
        <EngineMigrationModal
          stack={stack}
          fromEngineId={engineMigration.fromEngineId}
          toEngineId={engineMigration.toEngineId}
          namedVolumes={engineMigration.namedVolumes}
          bindMounts={engineMigration.bindMounts}
          loading={engineMigration.loading}
          engines={engines}
          onConfirm={confirmEngineMigration}
          onCancel={() => setEngineMigration(null)}
        />
      )}

      {/* Port conflict warning — surfaces ports that another stack/container on this engine is
          already using. Red because deploy WILL fail at `docker compose up` otherwise. */}
      {portConflicts.length > 0 && (
        <div className="rounded-lg border border-status-down/40 bg-status-down/10 p-3 mb-4">
          <div className="text-xs font-semibold text-status-down mb-1 flex items-center gap-1.5">
            <AlertTriangle size={13} /> Port conflict{portConflicts.length > 1 ? 's' : ''} detected
          </div>
          <div className="text-xs text-text-secondary space-y-0.5">
            {portConflicts.map((c, i) => (
              <div key={i}>
                <span className="font-mono text-status-down">Port {c.port}</span>{' '}
                is already used by{' '}
                <span className="font-mono text-text-primary">
                  {c.stackName ? `${c.stackName} / ` : ''}{c.containerName}
                </span>{' '}
                on this Docker host. Deployment will fail until you change this port or stop the other container.
              </div>
            ))}
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

      {/* Source panel — only shown for existing stacks (need an id to upload to) */}
      {stack && (
        <SourcePanel
          stack={stack}
          onStackUpdated={(updated) => { setStack(updated); setSelectedEngineId(updated.engineId ?? null); }}
        />
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
          <ComposePreview composeContent={composeContent} envVars={resolvedEnvVars} onDeletePort={handleDeletePort} portConflicts={portConflicts} />
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

// Live deploy log panel — subscribes to the COMPOSE_LOG socket event for this stack's project
// and renders the streaming stdout/stderr. The big red Cancel button is the user's emergency
// stop when they see a deploy stuck on a slow pull or hung SSH session. Buffer is auto-scrolled
// while deploying; the user can scroll up to inspect history and we won't snap them back.
/**
 * 3-choice modal shown when the operator changes the target engine on an already-deployed
 * stack. Each strategy has a different blast radius — we lay it out plainly so there's no
 * "oh shit" moment after the fact:
 *
 *   1. Just save        — fastest, least safe, orphans containers on the source engine
 *   2. Stop + redeploy  — clean cut, new engine starts with empty volumes (data loss perceived)
 *   3. Migrate data     — full move: stop source → tar-stream every named volume → redeploy
 *
 * Bind mounts are listed but skipped — the host paths can't be read across engines without
 * filesystem access we don't have. The user has to copy those manually if they matter.
 */
function EngineMigrationModal({
  stack,
  fromEngineId,
  toEngineId,
  namedVolumes,
  bindMounts,
  loading,
  engines,
  onConfirm,
  onCancel,
}: {
  stack: ManagedStack;
  fromEngineId: number | null;
  toEngineId: number | null;
  namedVolumes: string[];
  bindMounts: string[];
  loading: boolean;
  engines: { id: number; name: string }[];
  onConfirm: (strategy: 'just-save' | 'stop-and-deploy' | 'migrate-data') => void;
  onCancel: () => void;
}) {
  const [strategy, setStrategy] = useState<'just-save' | 'stop-and-deploy' | 'migrate-data'>('stop-and-deploy');
  const engineName = (id: number | null): string => id == null ? 'Local' : engines.find(e => e.id === id)?.name || `Engine ${id}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onCancel}>
      <div className="rounded-xl border border-border bg-bg-primary w-full max-w-2xl shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-border flex items-center gap-2">
          <AlertTriangle size={16} className="text-status-pending" />
          <h2 className="text-sm font-semibold text-text-primary">Move stack to a different engine</h2>
        </div>
        <div className="p-5 space-y-4 text-sm">
          <p className="text-text-secondary">
            You're moving <strong>{stack.name}</strong> from <strong>{engineName(fromEngineId)}</strong> to{' '}
            <strong>{engineName(toEngineId)}</strong>. This stack is currently <span className="text-status-up font-medium">deployed</span> — pick how you want to handle the existing containers and data.
          </p>

          {/* Volume preview */}
          <div className="rounded-lg border border-border bg-bg-secondary p-3 text-xs">
            <div className="font-semibold text-text-primary mb-1">Detected on source engine:</div>
            {loading ? (
              <div className="text-text-muted italic">Scanning…</div>
            ) : (
              <>
                <div className="text-text-secondary mb-1">
                  <span className="font-mono">{namedVolumes.length}</span> named volume{namedVolumes.length !== 1 ? 's' : ''}
                  {namedVolumes.length > 0 && ' (can be migrated):'}
                </div>
                {namedVolumes.length > 0 && (
                  <ul className="ml-3 space-y-0.5 mb-2">
                    {namedVolumes.map(v => <li key={v} className="font-mono text-text-muted">· {v}</li>)}
                  </ul>
                )}
                {bindMounts.length > 0 && (
                  <>
                    <div className="text-status-pending mb-1">
                      <span className="font-mono">{bindMounts.length}</span> bind mount{bindMounts.length !== 1 ? 's' : ''} — <strong>NOT migrated</strong> (copy these manually):
                    </div>
                    <ul className="ml-3 space-y-0.5 max-h-20 overflow-auto">
                      {bindMounts.map(b => <li key={b} className="font-mono text-text-muted">· {b}</li>)}
                    </ul>
                  </>
                )}
              </>
            )}
          </div>

          {/* Strategy radios */}
          <div className="space-y-2">
            <StrategyOption
              active={strategy === 'just-save'}
              onClick={() => setStrategy('just-save')}
              title="Just save (orphan old containers)"
              tone="muted"
              description={`Update the stack to target ${engineName(toEngineId)} but leave the existing containers running on ${engineName(fromEngineId)}. Fastest — useful when you'll clean up by hand or want to keep the old deploy as backup. The stack won't be deployed on ${engineName(toEngineId)} until you click Deploy manually.`}
            />
            <StrategyOption
              active={strategy === 'stop-and-deploy'}
              onClick={() => setStrategy('stop-and-deploy')}
              title="Stop on source, redeploy on target (no data move)"
              tone="default"
              description={`Run \`docker compose down\` on ${engineName(fromEngineId)}, then deploy fresh on ${engineName(toEngineId)}. Containers are clean on both sides. Named volumes on the new engine will be EMPTY — any database / persistent data is left behind on the source.`}
            />
            <StrategyOption
              active={strategy === 'migrate-data'}
              onClick={() => setStrategy('migrate-data')}
              title="Migrate everything (stop → copy data → redeploy)"
              tone="strong"
              description={`Full move. Stop on ${engineName(fromEngineId)}, tar-stream each named volume to ${engineName(toEngineId)} via temporary alpine helper containers (no SSH/rsync prerequisites), then deploy. Takes time proportional to volume size — progress is streamed live to the deploy log panel.${bindMounts.length > 0 ? ' Bind mounts are SKIPPED — copy host paths yourself.' : ''}`}
            />
          </div>
        </div>
        <div className="px-5 py-3 border-t border-border flex items-center justify-between bg-bg-secondary rounded-b-xl">
          <button onClick={onCancel} className="px-4 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">
            Cancel
          </button>
          <button
            onClick={() => onConfirm(strategy)}
            disabled={loading}
            className={`px-4 py-1.5 text-sm rounded-lg font-medium ${
              strategy === 'migrate-data' ? 'bg-accent text-white hover:bg-accent-hover'
              : strategy === 'stop-and-deploy' ? 'bg-accent text-white hover:bg-accent-hover'
              : 'bg-status-pending text-white hover:bg-status-pending/90'
            } disabled:opacity-50`}
          >
            Confirm — {strategy === 'just-save' ? 'just save' : strategy === 'stop-and-deploy' ? 'stop & redeploy' : 'migrate & redeploy'}
          </button>
        </div>
      </div>
    </div>
  );
}

function StrategyOption({ active, onClick, title, description, tone }: {
  active: boolean; onClick: () => void; title: string; description: string; tone: 'muted' | 'default' | 'strong';
}) {
  const accentByTone = tone === 'muted' ? 'border-status-pending/40' : tone === 'strong' ? 'border-accent' : 'border-border';
  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded-lg border p-3 transition-colors ${
        active ? `bg-accent/10 ${accentByTone}` : 'bg-bg-secondary border-border hover:bg-bg-hover'
      }`}
    >
      <div className="flex items-start gap-2">
        <div className={`mt-0.5 h-3 w-3 rounded-full border-2 flex-shrink-0 ${active ? 'border-accent bg-accent' : 'border-border'}`} />
        <div className="flex-1">
          <div className={`text-xs font-semibold ${active ? 'text-accent' : 'text-text-primary'}`}>{title}</div>
          <div className="text-[11px] text-text-muted mt-1 leading-relaxed">{description}</div>
        </div>
      </div>
    </button>
  );
}

function DeployLogPanel({
  projectName,
  isDeploying,
  onCancel,
}: {
  projectName: string | null | undefined;
  isDeploying: boolean;
  onCancel: () => void;
}) {
  const socket = useSocket();
  const [lines, setLines] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState(!isDeploying);
  const [autoscroll, setAutoscroll] = useState(true);
  const preRef = useRef<HTMLPreElement>(null);

  // Whenever a deploy starts, expand the panel and clear stale history.
  useEffect(() => {
    if (isDeploying) {
      setCollapsed(false);
      setLines([]);
    }
  }, [isDeploying]);

  useEffect(() => {
    if (!projectName) return;
    const onLog = (data: { projectName: string; stream: 'stdout' | 'stderr'; chunk: string }) => {
      if (data.projectName !== projectName) return;
      setLines((prev) => {
        const split = data.chunk.split('\n');
        // Drop the trailing empty string when chunk ends with \n
        if (split[split.length - 1] === '') split.pop();
        const merged = [...prev, ...split];
        // Keep at most 2000 lines client-side — anything older is logged on the server anyway.
        return merged.length > 2000 ? merged.slice(-2000) : merged;
      });
    };
    const onStarted = (data: { projectName: string }) => {
      if (data.projectName !== projectName) return;
      setLines([]);
      setCollapsed(false);
    };
    socket.on(SOCKET_EVENTS.COMPOSE_LOG, onLog);
    socket.on(SOCKET_EVENTS.COMPOSE_STARTED, onStarted);
    return () => {
      socket.off(SOCKET_EVENTS.COMPOSE_LOG, onLog);
      socket.off(SOCKET_EVENTS.COMPOSE_STARTED, onStarted);
    };
  }, [socket, projectName]);

  useEffect(() => {
    if (autoscroll && preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [lines, autoscroll]);

  if (!isDeploying && lines.length === 0 && collapsed) return null;

  return (
    <div className="mb-4 rounded-lg border border-border bg-bg-secondary overflow-hidden">
      <div className="px-3 py-2 border-b border-border flex items-center justify-between gap-2 bg-bg-tertiary/40">
        <div className="flex items-center gap-2 text-xs font-medium">
          {isDeploying && <div className="h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent" />}
          <Terminal size={13} className={isDeploying ? 'text-accent' : 'text-text-muted'} />
          <span className={isDeploying ? 'text-accent' : 'text-text-secondary'}>
            {isDeploying ? 'Deploying — live output' : 'Deploy output'}
          </span>
          {lines.length > 0 && (
            <span className="text-[10px] text-text-muted ml-1">({lines.length} lines)</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <label className="text-[10px] text-text-muted flex items-center gap-1 cursor-pointer">
            <input
              type="checkbox"
              checked={autoscroll}
              onChange={(e) => setAutoscroll(e.target.checked)}
              className="cursor-pointer"
            />
            auto-scroll
          </label>
          <button
            onClick={() => setCollapsed((c) => !c)}
            className="text-[10px] text-text-muted hover:text-text-primary"
          >
            {collapsed ? 'expand' : 'collapse'}
          </button>
          {isDeploying && (
            <button
              onClick={onCancel}
              className="flex items-center gap-1.5 px-3 py-1 text-xs font-semibold rounded-md bg-red-600 hover:bg-red-700 text-white shadow-sm shadow-red-900/30"
              title="Kill the docker compose process — use this if the deploy looks stuck"
            >
              <XCircle size={13} /> Cancel deploy
            </button>
          )}
        </div>
      </div>
      {!collapsed && (
        <pre
          ref={preRef}
          className="text-[11px] leading-relaxed font-mono text-text-secondary whitespace-pre-wrap break-all bg-[#0d1117] p-3 max-h-72 overflow-auto"
        >
          {lines.length === 0
            ? <span className="text-text-muted italic">Waiting for output…</span>
            : lines.join('\n')}
        </pre>
      )}
    </div>
  );
}
