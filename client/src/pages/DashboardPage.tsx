import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { RefreshCw, Play, Package, Search, RotateCcw, Plus, ExternalLink } from 'lucide-react';
import { stacksApi, systemApi } from '@/api/stacks.api';
import { managedStacksApi } from '@/api/managed-stacks.api';
import type { Stack, ManagedStack } from '@oblihub/shared';
import toast from 'react-hot-toast';

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    up_to_date: 'bg-status-up/10 text-status-up',
    update_available: 'bg-status-pending/10 text-status-pending',
    updating: 'bg-accent/10 text-accent',
    error: 'bg-status-down/10 text-status-down',
    unknown: 'bg-bg-tertiary text-text-muted',
    checking: 'bg-bg-tertiary text-text-muted',
    excluded: 'bg-bg-tertiary text-text-muted',
    stopped: 'bg-status-down/10 text-status-down',
  };
  const labels: Record<string, string> = {
    up_to_date: 'Up to date',
    update_available: 'Update available',
    updating: 'Updating...',
    error: 'Error',
    unknown: 'Unknown',
    checking: 'Checking...',
    excluded: 'Excluded',
    stopped: 'Stopped',
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${styles[status] || styles.unknown}`}>
      {labels[status] || status}
    </span>
  );
}

type StackOrigin = 'self' | 'managed' | 'foreign';

function OriginBadge({ origin }: { origin: StackOrigin }) {
  if (origin === 'self') {
    return <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium bg-accent/15 text-accent border border-accent/30">Oblihub</span>;
  }
  if (origin === 'managed') {
    return <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium bg-status-up/10 text-status-up border border-status-up/30">Managed</span>;
  }
  return <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium bg-status-down/10 text-status-down border border-status-down/30">Foreign</span>;
}

function getStackStatus(stack: Stack): string {
  if (!stack.containers.length) return 'unknown';
  if (stack.containers.every(c => c.status === 'stopped')) return 'stopped';
  if (stack.containers.some(c => c.status === 'updating')) return 'updating';
  if (stack.containers.some(c => c.status === 'error')) return 'error';
  if (stack.containers.some(c => c.status === 'update_available')) return 'update_available';
  if (stack.containers.some(c => c.status === 'checking')) return 'checking';
  if (stack.containers.every(c => c.status === 'up_to_date' || c.status === 'excluded')) return 'up_to_date';
  return 'unknown';
}

export function DashboardPage() {
  const navigate = useNavigate();
  const [stacks, setStacks] = useState<Stack[]>([]);
  const [loading, setLoading] = useState(true);
  const [allowStack, setAllowStack] = useState(false);
  const [selfProject, setSelfProject] = useState<string | null>(null);
  const [managedProjects, setManagedProjects] = useState<Set<string>>(new Set());

  const load = async () => {
    try {
      const data = await stacksApi.list();
      setStacks(data);
    } catch { toast.error('Failed to load stacks'); }
    finally { setLoading(false); }
  };

  useEffect(() => {
    load();
    systemApi.getFeatures().then(f => {
      setAllowStack(f.allowStack);
      setSelfProject(f.selfProject);
      // Only load managed stacks if allowStack is enabled
      if (f.allowStack) {
        managedStacksApi.list().then(managed => {
          setManagedProjects(new Set(managed.map(m => m.composeProject)));
        }).catch(() => {});
      }
    }).catch(() => {
      systemApi.getInfo().then(info => setAllowStack(info.allowStack)).catch(() => {});
    });
  }, []);

  const getOrigin = (stack: Stack): StackOrigin => {
    if (selfProject && stack.composeProject === selfProject) return 'self';
    if (stack.composeProject && managedProjects.has(stack.composeProject)) return 'managed';
    return 'foreign';
  };

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-text-primary">Docker Stacks</h1>
        <div className="flex items-center gap-2">
          {allowStack && (
            <button
              onClick={() => navigate('/stack-editor/new')}
              className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover transition-colors">
              <Plus size={14} /> New Stack
            </button>
          )}
          <button
            onClick={async () => {
              toast.loading('Checking all stacks...', { id: 'check-all' });
              try {
                for (const s of stacks) { await stacksApi.check(s.id); }
                toast.success('All checks started', { id: 'check-all' });
                setTimeout(load, 3000);
              } catch { toast.error('Check failed', { id: 'check-all' }); }
            }}
            className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg bg-accent/10 text-accent hover:bg-accent/20 transition-colors">
            <Search size={14} /> Check All
          </button>
          <button onClick={load} className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover transition-colors">
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
        </div>
      ) : stacks.length === 0 ? (
        <div className="text-center py-20">
          <Package size={40} className="mx-auto mb-3 text-text-muted" />
          <p className="text-text-muted">No Docker stacks discovered yet</p>
          <p className="text-xs text-text-muted mt-1">Make sure Docker socket is mounted</p>
        </div>
      ) : (
        <div className="grid gap-4 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
          {stacks.map((stack) => {
            const status = getStackStatus(stack);
            const origin = getOrigin(stack);
            return (
              <div key={stack.id} onClick={() => navigate(`/stack/${stack.id}`)}
                className="rounded-xl border border-border bg-bg-secondary p-4 hover:border-accent/30 cursor-pointer transition-colors">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <h3 className="text-sm font-semibold text-text-primary truncate">{stack.name}</h3>
                    <OriginBadge origin={origin} />
                  </div>
                  <StatusBadge status={status} />
                </div>
                <div className="text-xs text-text-muted mb-2">
                  {stack.containers.length} container{stack.containers.length !== 1 ? 's' : ''}
                  {stack.composeProject && <span className="ml-2">({stack.composeProject})</span>}
                </div>
                <div className="flex flex-wrap items-center gap-1.5 mb-3 text-[10px]">
                  <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded ${stack.enabled ? 'bg-status-up/10 text-status-up' : 'bg-bg-tertiary text-text-muted'}`}>
                    {stack.enabled ? 'Monitoring' : 'Paused'}
                  </span>
                  {stack.autoUpdate && (
                    <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-accent/10 text-accent">
                      Auto-update
                    </span>
                  )}
                  <span className="text-text-muted">{stack.checkInterval}s</span>
                </div>
                {stack.url && (
                  <a
                    href={stack.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={e => e.stopPropagation()}
                    className="flex items-center gap-1 text-[10px] text-accent hover:text-accent-hover mb-2 truncate"
                    title={stack.url}
                  >
                    <ExternalLink size={10} className="shrink-0" />
                    <span className="truncate">{stack.url.replace(/^https?:\/\//, '')}</span>
                  </a>
                )}
                <div className="flex flex-wrap gap-1">
                  {stack.containers.map((c) => (
                    <div key={c.id} className={`h-2 w-2 rounded-full ${
                      c.status === 'up_to_date' ? 'bg-status-up' :
                      c.status === 'update_available' ? 'bg-status-pending' :
                      c.status === 'error' ? 'bg-status-down' :
                      c.status === 'stopped' ? 'bg-status-down/50' :
                      c.status === 'updating' ? 'bg-accent' : 'bg-text-muted'
                    }`} title={`${c.containerName}: ${c.status}`} />
                  ))}
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <button onClick={(e) => { e.stopPropagation(); stacksApi.check(stack.id).then(() => setTimeout(load, 2000)).catch(() => toast.error('Check failed')); }}
                    className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-border text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors">
                    <RefreshCw size={10} /> Check
                  </button>
                  <button onClick={(e) => { e.stopPropagation(); stacksApi.restart(stack.id).then(() => { toast.success(`${stack.name} restarted`); load(); }).catch(() => toast.error('Restart failed')); }}
                    className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-border text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors">
                    <RotateCcw size={10} /> Restart
                  </button>
                  {status === 'update_available' && (
                    <button onClick={(e) => { e.stopPropagation(); stacksApi.triggerUpdate(stack.id).then(load).catch(() => toast.error('Update failed')); }}
                      className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-accent/10 text-accent hover:bg-accent/20 transition-colors">
                      <Play size={10} /> Update
                    </button>
                  )}
                </div>
                {stack.lastCheckedAt && (
                  <p className="text-[10px] text-text-muted mt-2">Last checked: {new Date(stack.lastCheckedAt).toLocaleString()}</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
