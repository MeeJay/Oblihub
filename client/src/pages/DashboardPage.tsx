import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { RefreshCw, Play, Package, Search, RotateCcw, Plus, ExternalLink, Shield, Cpu, MemoryStick, Globe } from 'lucide-react';
import { stacksApi, systemApi } from '@/api/stacks.api';
import { managedStacksApi } from '@/api/managed-stacks.api';
import { proxyApi } from '@/api/proxy.api';
import { teamsApi } from '@/api/teams.api';
import { useSocket } from '@/hooks/useSocket';
import { Sparkline } from '@/components/Sparkline';
import { SOCKET_EVENTS } from '@oblihub/shared';
import type { Stack, ManagedStack, ContainerStats } from '@oblihub/shared';
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
  const [allowNginx, setAllowNginx] = useState(false);
  const [selfProject, setSelfProject] = useState<string | null>(null);
  const [managedProjects, setManagedProjects] = useState<Set<string>>(new Set());
  const [proxyStackIds, setProxyStackIds] = useState<Set<number>>(new Set());
  const [stackStats, setStackStats] = useState<Record<number, { cpu: number[]; mem: number[]; cpuNow: number; memNow: number }>>({});
  const [stackTeamNames, setStackTeamNames] = useState<Record<number, string[]>>({});
  const [globalTeams, setGlobalTeams] = useState<string[]>([]);
  const socket = useSocket();

  const load = async () => {
    try {
      const data = await stacksApi.list();
      setStacks(data);
    } catch { toast.error('Failed to load stacks'); }
    finally { setLoading(false); }
  };

  // Real-time updates: re-fetch via API on discovery (respects team/permission filters)
  useEffect(() => {
    const onDiscovery = () => { load(); };
    socket.on(SOCKET_EVENTS.DISCOVERY_COMPLETE, onDiscovery);
    return () => { socket.off(SOCKET_EVENTS.DISCOVERY_COMPLETE, onDiscovery); };
  }, [socket]);

  useEffect(() => {
    load();
    systemApi.getFeatures().then(f => {
      setAllowStack(f.allowStack);
      setAllowNginx(f.allowNginx);
      setSelfProject(f.selfProject);
      if (f.allowStack) {
        managedStacksApi.list().then(managed => {
          setManagedProjects(new Set(managed.map(m => m.composeProject)));
        }).catch(() => {});
      }
      if (f.allowNginx) {
        proxyApi.listHosts().then(hosts => {
          setProxyStackIds(new Set(hosts.filter(h => h.stackId).map(h => h.stackId!)));
        }).catch(() => {});
      }
    }).catch(() => {
      systemApi.getInfo().then(info => setAllowStack(info.allowStack)).catch(() => {});
    });
    // Load team labels for stacks
    teamsApi.getStackTeams().then(data => {
      setStackTeamNames(data.stackTeams);
      setGlobalTeams(data.globalTeams);
    }).catch(() => {});
  }, []);

  // Pre-populate sparklines from server-side history on stack load, then poll for fresh samples.
  useEffect(() => {
    if (stacks.length === 0) return;

    const loadHistory = async () => {
      try {
        const { statsApi } = await import('@/api/stats.api');
        const history = await statsApi.getBulkRecent(15);
        setStackStats(prev => {
          const next = { ...prev };
          for (const s of stacks) {
            const containerIds = new Set(s.containers.map(c => c.dockerId));
            const stackRows = history
              .filter(r => containerIds.has(r.dockerId))
              .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
            if (stackRows.length === 0) continue;
            // Bucket rows by second-precision timestamp, average across containers per bucket.
            const buckets = new Map<string, { cpu: number[]; mem: number[] }>();
            for (const r of stackRows) {
              const key = new Date(r.timestamp).toISOString().slice(0, 19);
              const b = buckets.get(key) || { cpu: [], mem: [] };
              b.cpu.push(r.cpuPercent);
              b.mem.push(r.memoryPercent);
              buckets.set(key, b);
            }
            const sortedKeys = [...buckets.keys()].sort();
            const cpu: number[] = [];
            const mem: number[] = [];
            for (const k of sortedKeys) {
              const b = buckets.get(k)!;
              cpu.push(b.cpu.reduce((a, v) => a + v, 0) / b.cpu.length);
              mem.push(b.mem.reduce((a, v) => a + v, 0) / b.mem.length);
            }
            const lastCpu = cpu[cpu.length - 1] || 0;
            const lastMem = mem[mem.length - 1] || 0;
            next[s.id] = {
              cpu: cpu.slice(-20),
              mem: mem.slice(-20),
              cpuNow: Math.round(lastCpu * 10) / 10,
              memNow: Math.round(lastMem * 10) / 10,
            };
          }
          return next;
        });
      } catch { /* ignore */ }
    };

    const fetchLatest = async () => {
      try {
        const { statsApi } = await import('@/api/stats.api');
        const data = await statsApi.getLatest();
        setStackStats(prev => {
          const next = { ...prev };
          for (const s of stacks) {
            const containerIds = new Set(s.containers.map(c => c.dockerId));
            const stackContainerStats = data.filter(d => containerIds.has(d.dockerId));
            if (stackContainerStats.length === 0) continue;
            const avgCpu = stackContainerStats.reduce((sum, c) => sum + c.cpuPercent, 0) / stackContainerStats.length;
            const avgMem = stackContainerStats.reduce((sum, c) => sum + c.memoryPercent, 0) / stackContainerStats.length;
            const existing = next[s.id] || { cpu: [], mem: [], cpuNow: 0, memNow: 0 };
            next[s.id] = {
              cpu: [...existing.cpu, avgCpu].slice(-20),
              mem: [...existing.mem, avgMem].slice(-20),
              cpuNow: Math.round(avgCpu * 10) / 10,
              memNow: Math.round(avgMem * 10) / 10,
            };
          }
          return next;
        });
      } catch { /* ignore */ }
    };

    loadHistory();
    fetchLatest();
    const interval = setInterval(fetchLatest, 15000);
    return () => clearInterval(interval);
  }, [stacks]);

  const getOrigin = (stack: Stack): StackOrigin => {
    if (selfProject && stack.composeProject === selfProject) return 'self';
    if (stack.composeProject && managedProjects.has(stack.composeProject)) return 'managed';
    return 'foreign';
  };

  return (
    <div className="px-6 pt-5 pb-8">
      {/* Page header — spec §4.3: title · meta on the left, actions on the right. */}
      <div className="flex items-end justify-between gap-4 mb-5">
        <div>
          <h1 className="font-display text-[24px] font-semibold tracking-wide text-text-primary leading-tight">
            Docker Stacks
          </h1>
          <div className="mt-1 text-[11px] font-mono uppercase tracking-[0.14em] text-text-muted">
            {stacks.length} stack{stacks.length !== 1 ? 's' : ''} discovered
          </div>
        </div>
        <div className="flex items-center gap-2">
          {allowStack && (
            <button
              onClick={() => navigate('/stack-editor/new')}
              className="flex items-center gap-2 px-3.5 py-2 text-[13px] rounded-md bg-accent text-white hover:bg-accent-hover transition-colors font-medium">
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
            className="flex items-center gap-2 px-3.5 py-2 text-[13px] rounded-md bg-accent/[0.12] text-accent hover:bg-accent/20 transition-colors font-medium">
            <Search size={14} /> Check All
          </button>
          <button onClick={load} className="flex items-center gap-2 px-3.5 py-2 text-[13px] rounded-md bg-bg-secondary text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors font-medium">
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
                className="rounded-xl bg-bg-secondary p-4 shadow-card hover:bg-bg-hover cursor-pointer transition-colors">
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
                  {proxyStackIds.has(stack.id) && (
                    <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-status-up/10 text-status-up">
                      <Shield size={8} /> Proxied
                    </span>
                  )}
                  {stack.containers.some(c => c.image.includes('nginx')) && (
                    <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-accent/10 text-accent">Nginx</span>
                  )}
                  {(stackTeamNames[stack.id] || globalTeams).map(t => (
                    <span key={t} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-[#6366f1]/10 text-[#6366f1] border border-[#6366f1]/20 text-[9px]">{t}</span>
                  ))}
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
                    className="inline-flex items-center gap-1 text-[10px] text-accent hover:text-accent-hover mb-2 truncate w-fit max-w-full"
                    title={stack.url}
                  >
                    <ExternalLink size={10} className="shrink-0" />
                    <span className="truncate">{stack.url.replace(/^https?:\/\//, '')}</span>
                  </a>
                )}
                {(() => {
                  const publishedPorts = new Map<string, { hostPort: number; containerPort: number; protocol: string }>();
                  for (const c of stack.containers) {
                    for (const p of c.ports || []) {
                      if (p.hostPort != null) {
                        const key = `${p.hostPort}:${p.containerPort}/${p.protocol}`;
                        if (!publishedPorts.has(key)) publishedPorts.set(key, { hostPort: p.hostPort, containerPort: p.containerPort, protocol: p.protocol });
                      }
                    }
                  }
                  if (publishedPorts.size === 0) return null;
                  return (
                    <div className="flex flex-wrap gap-1 mb-2">
                      {[...publishedPorts.values()].sort((a, b) => a.hostPort - b.hostPort).map(p => (
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
                <div className="flex flex-wrap gap-1">
                  {stack.containers.map((c) => (
                    <div key={c.id} className={`h-2 w-2 rounded-full ${
                      c.status === 'up_to_date' ? 'bg-status-up' :
                      c.status === 'update_available' ? 'bg-status-pending' :
                      (c.status as string) === 'stopped' ? 'bg-status-down/50' :
                      c.status === 'error' ? 'bg-status-down' :
                      c.status === 'updating' ? 'bg-accent' : 'bg-text-muted'
                    }`} title={`${c.containerName}: ${c.status}`} />
                  ))}
                </div>
                {stackStats[stack.id] && (
                  <div className="flex items-center gap-3 mt-2">
                    <div className="flex items-center gap-1">
                      <Sparkline data={stackStats[stack.id].cpu} width={50} height={16} color="#4a9eff" />
                      <span className="text-[9px] text-text-muted">{stackStats[stack.id].cpuNow}%</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Sparkline data={stackStats[stack.id].mem} width={50} height={16} color="#3fb950" />
                      <span className="text-[9px] text-text-muted">{stackStats[stack.id].memNow}%</span>
                    </div>
                  </div>
                )}
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
