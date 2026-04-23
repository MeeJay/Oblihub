import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, RefreshCw, Layers, Play, Square, RotateCcw, Trash2, XCircle, Globe } from 'lucide-react';
import { managedStacksApi } from '@/api/managed-stacks.api';
import { stacksApi } from '@/api/stacks.api';
import type { ManagedStack, ManagedStackStatus, Stack } from '@oblihub/shared';
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
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const [managed, live] = await Promise.all([
        managedStacksApi.list(),
        stacksApi.list().catch(() => [] as Stack[]),
      ]);
      setStacks(managed);
      setLiveStacks(live);
    } catch { toast.error('Failed to load managed stacks'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

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
    if (!confirm(`Delete "${s.name}"? This will also remove its containers if deployed.`)) return;
    try {
      await managedStacksApi.delete(s.id);
      toast.success(`${s.name} deleted`);
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
        <div className="grid gap-4 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
          {stacks.map(s => (
            <div key={s.id} onClick={() => navigate(`/stack-editor/${s.id}`)}
              className="rounded-xl border border-border bg-bg-secondary p-4 hover:border-accent/30 cursor-pointer transition-colors">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-semibold text-text-primary truncate">{s.name}</h3>
                <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[s.status]}`}>
                  {STATUS_LABELS[s.status]}
                </span>
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
          ))}
        </div>
      )}
    </div>
  );
}
