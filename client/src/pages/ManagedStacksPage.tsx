import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, RefreshCw, Layers, Play, Square, RotateCcw, Trash2, XCircle, Globe, Server } from 'lucide-react';
import { managedStacksApi } from '@/api/managed-stacks.api';
import { stacksApi } from '@/api/stacks.api';
import { enginesApi } from '@/api/engines.api';
import type { ManagedStack, ManagedStackStatus, Stack, DockerEngine } from '@oblihub/shared';
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

export function ManagedStacksPage() {
  const navigate = useNavigate();
  const [stacks, setStacks] = useState<ManagedStack[]>([]);
  const [liveStacks, setLiveStacks] = useState<Stack[]>([]);
  const [engines, setEngines] = useState<DockerEngine[]>([]);
  const [loading, setLoading] = useState(true);
  // `null` = "all engines" selected. A number = filter to that engine only.
  const [engineFilter, setEngineFilter] = useState<number | null>(null);

  const load = async () => {
    try {
      const [managed, live, eng] = await Promise.all([
        managedStacksApi.list(),
        stacksApi.list().catch(() => [] as Stack[]),
        enginesApi.list().catch(() => [] as DockerEngine[]),
      ]);
      setStacks(managed);
      setLiveStacks(live);
      setEngines(eng);
    } catch { toast.error('Failed to load managed stacks'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const enginesById = useMemo(() => new Map(engines.map(e => [e.id, e])), [engines]);
  // Only show the filter row when there are at least 2 engines — single-engine setups don't
  // need filtering and the row would just take space.
  const showFilter = engines.length >= 2;
  const visibleStacks = useMemo(
    () => engineFilter == null ? stacks : stacks.filter(s => (s.engineId ?? null) === engineFilter),
    [stacks, engineFilter]
  );

  const portsForProject = (composeProject: string) => {
    const live = liveStacks.find(s => s.composeProject === composeProject);
    if (!live) return [] as { hostPort: number; containerPort: number; protocol: string }[];
    const map = new Map<string, { hostPort: number; containerPort: number; protocol: string }>();
    for (const c of live.containers) {
      for (const p of c.ports || []) {
        if (p.hostPort != null) {
          const key = `${p.hostPort}:${p.containerPort}/${p.protocol}`;
          if (!map.has(key)) map.set(key, { hostPort: p.hostPort, containerPort: p.containerPort, protocol: p.protocol });
        }
      }
    }
    return [...map.values()].sort((a, b) => a.hostPort - b.hostPort);
  };

  // Poll while any stack is deploying
  useEffect(() => {
    if (!stacks.some(s => s.status === 'deploying')) return;
    const interval = setInterval(load, 3000);
    return () => clearInterval(interval);
  }, [stacks]);

  const handleDeploy = async (e: React.MouseEvent, s: ManagedStack) => {
    e.stopPropagation();
    try {
      await managedStacksApi.deploy(s.id);
      toast.success(`Deploying ${s.name}...`);
      load();
    } catch { toast.error('Deploy failed'); }
  };

  const handleStop = async (e: React.MouseEvent, s: ManagedStack) => {
    e.stopPropagation();
    try {
      await managedStacksApi.stop(s.id);
      toast.success(`${s.name} stopped`);
      load();
    } catch { toast.error('Stop failed'); }
  };

  const handleRedeploy = async (e: React.MouseEvent, s: ManagedStack) => {
    e.stopPropagation();
    try {
      await managedStacksApi.redeploy(s.id);
      toast.success(`Redeploying ${s.name}...`);
      load();
    } catch { toast.error('Redeploy failed'); }
  };

  const handleCancel = async (e: React.MouseEvent, s: ManagedStack) => {
    e.stopPropagation();
    if (!confirm(`Cancel deployment of "${s.name}"? Any in-progress compose command will be killed.`)) return;
    try {
      const { killed } = await managedStacksApi.cancel(s.id);
      toast.success(killed ? `${s.name} deploy cancelled` : `${s.name} status reset`);
      load();
    } catch { toast.error('Cancel failed'); }
  };

  const handleDelete = async (e: React.MouseEvent, s: ManagedStack) => {
    e.stopPropagation();
    if (!confirm(`Delete "${s.name}"?\n\nThis stops & removes its containers if deployed.`)) return;
    // Second prompt for the destructive step — explicit so a typo on the first dialog never
    // accidentally wipes a database.
    const wipeVolumes = confirm(
      `Also remove "${s.name}"'s volumes ?\n\n` +
      `[OK]     = WIPE all data the stack wrote (databases, uploads, caches…).\n` +
      `[Cancel] = keep volumes orphaned on the engine (you can ` +
      `clean them up later from the Volumes page).`
    );
    try {
      await managedStacksApi.delete(s.id, wipeVolumes);
      toast.success(wipeVolumes ? `${s.name} purged (containers + volumes)` : `${s.name} deleted (volumes preserved)`);
      load();
    } catch { toast.error('Delete failed'); }
  };

  if (loading) return <div className="flex items-center justify-center h-full"><div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" /></div>;

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-text-primary flex items-center gap-2"><Layers size={20} /> Managed Stacks</h1>
        <div className="flex gap-2">
          <button onClick={() => navigate('/stack-editor/new')} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover">
            <Plus size={14} /> New Stack
          </button>
          <button onClick={load} className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      <EngineFilterBar
        engines={engines}
        selected={engineFilter}
        onSelect={setEngineFilter}
        counts={Object.fromEntries(engines.map(e => [e.id, stacks.filter(s => (s.engineId ?? null) === e.id).length]))}
        totalCount={stacks.length}
        visible={showFilter}
      />

      {stacks.length === 0 ? (
        <div className="text-center py-20">
          <Layers size={40} className="mx-auto mb-3 text-text-muted" />
          <p className="text-text-muted">No managed stacks yet</p>
          <p className="text-xs text-text-muted mt-1">Create one with a docker-compose.yml</p>
          <button onClick={() => navigate('/stack-editor/new')} className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover">
            <Plus size={14} /> Create Stack
          </button>
        </div>
      ) : (
        visibleStacks.length === 0 ? (
          <div className="text-center py-16 text-text-muted text-sm">
            No managed stacks on this engine.
          </div>
        ) : (
        <div className="grid gap-4 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
          {visibleStacks.map(s => {
            const engine = s.engineId != null ? enginesById.get(s.engineId) : null;
            return (
            <div key={s.id} onClick={() => navigate(`/stack-editor/${s.id}`)}
              className="rounded-xl border border-border bg-bg-secondary p-4 hover:border-accent/30 cursor-pointer transition-colors">
              <div className="flex items-center justify-between mb-2 gap-2">
                <h3 className="text-sm font-semibold text-text-primary truncate">{s.name}</h3>
                <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[s.status]} flex-shrink-0`}>
                  {STATUS_LABELS[s.status]}
                </span>
              </div>
              <div className="flex items-center gap-1.5 mb-2 flex-wrap">
                {engine && (
                  <span
                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium bg-bg-tertiary text-text-secondary border border-border"
                    title={engine.isDefault ? 'Local Docker engine' : `Remote engine — ${engine.host || engine.tailscaleHostname || engine.type}`}
                  >
                    <Server size={9} /> {engine.name}
                  </span>
                )}
              </div>
              <div className="text-xs text-text-muted mb-2">
                Project: <code className="bg-bg-tertiary px-1 py-0.5 rounded">{s.composeProject}</code>
              </div>
              {(() => {
                const ports = portsForProject(s.composeProject);
                if (ports.length === 0) return null;
                return (
                  <div className="flex flex-wrap gap-1 mb-2">
                    {ports.map(p => (
                      <span key={`${p.hostPort}:${p.containerPort}/${p.protocol}`}
                        className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-bg-tertiary text-text-secondary text-[10px] font-mono"
                        title={`Host :${p.hostPort} → container :${p.containerPort}/${p.protocol}`}>
                        <Globe size={8} className="opacity-60" />
                        {p.hostPort}<span className="opacity-50">→{p.containerPort}{p.protocol !== 'tcp' && `/${p.protocol}`}</span>
                      </span>
                    ))}
                  </div>
                );
              })()}
              <div className="flex items-center gap-2 mt-2">
                {(s.status === 'draft' || s.status === 'stopped' || s.status === 'error') && (
                  <button onClick={e => handleDeploy(e, s)} className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-status-up/10 text-status-up hover:bg-status-up/20">
                    <Play size={10} /> Deploy
                  </button>
                )}
                {s.status === 'deploying' && (
                  <button onClick={e => handleCancel(e, s)} className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-status-down/10 text-status-down hover:bg-status-down/20">
                    <XCircle size={10} /> Cancel
                  </button>
                )}
                {s.status === 'deployed' && (
                  <>
                    <button onClick={e => handleRedeploy(e, s)} className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-accent/10 text-accent hover:bg-accent/20">
                      <RotateCcw size={10} /> Redeploy
                    </button>
                    <button onClick={e => handleStop(e, s)} className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-border text-text-muted hover:text-status-pending">
                      <Square size={10} /> Stop
                    </button>
                  </>
                )}
                <button onClick={e => handleDelete(e, s)} className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-border text-text-muted hover:text-status-down ml-auto">
                  <Trash2 size={10} />
                </button>
              </div>
              <p className="text-[10px] text-text-muted mt-2">Updated: {new Date(s.updatedAt).toLocaleString()}</p>
            </div>
            );
          })}
        </div>
        )
      )}
    </div>
  );
}

// Engine filter — a row of toggle buttons "All / Local / Remote1 / Remote2…". Selecting a
// button narrows the visible stacks to that engine. Shared visual treatment with the dashboard
// version so the two pages feel consistent.
function EngineFilterBar({
  engines,
  selected,
  onSelect,
  counts,
  totalCount,
  visible,
}: {
  engines: DockerEngine[];
  selected: number | null;
  onSelect: (id: number | null) => void;
  counts: Record<number, number>;
  totalCount: number;
  visible: boolean;
}) {
  if (!visible) return null;
  const btn = (id: number | null, label: string, count: number) => {
    const active = selected === id;
    return (
      <button
        key={id ?? 'all'}
        onClick={() => onSelect(id)}
        className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-medium border transition-colors ${
          active
            ? 'border-accent bg-accent/10 text-accent'
            : 'border-border bg-bg-secondary text-text-secondary hover:bg-bg-hover hover:text-text-primary'
        }`}
      >
        {id != null && <Server size={11} />}
        {label}
        <span className={`text-[10px] ${active ? 'text-accent/70' : 'text-text-muted'}`}>({count})</span>
      </button>
    );
  };
  return (
    <div className="flex flex-wrap gap-2 mb-4">
      {btn(null, 'All', totalCount)}
      {engines.map((e) => btn(e.id, e.name, counts[e.id] ?? 0))}
    </div>
  );
}
