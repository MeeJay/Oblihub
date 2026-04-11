import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, RefreshCw, Play, Settings2, RotateCcw, Square, Terminal, ScrollText, FileEdit, Info, Trash2, ExternalLink, Globe, Plus, Power, PowerOff, Shield } from 'lucide-react';
import { stacksApi, containersApi, systemApi } from '@/api/stacks.api';
import { managedStacksApi } from '@/api/managed-stacks.api';
import { proxyApi } from '@/api/proxy.api';
import { useSocket } from '@/hooks/useSocket';
import { Sparkline } from '@/components/Sparkline';
import { SOCKET_EVENTS } from '@oblihub/shared';
import type { ContainerStats as ContainerStatsType } from '@oblihub/shared';
import { ContainerLogs } from '@/components/ContainerLogs';
import { ContainerConsole } from '@/components/ContainerConsole';
import { NotificationBindingsPanel } from '@/components/NotificationBindingsPanel';
import type { Stack, Container, UpdateHistoryEntry, ManagedStack, ProxyHost } from '@oblihub/shared';
import toast from 'react-hot-toast';

type PanelType = 'logs' | 'console' | 'inspect';

interface ContainerInspect {
  env: string[];
  ports: Record<string, { HostIp: string; HostPort: string }[]>;
  mounts: { Type: string; Source: string; Destination: string; Mode: string }[];
  networks: Record<string, { IPAddress: string; Gateway: string; NetworkID: string }>;
}

export function StackDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const socket = useSocket();
  const [stack, setStack] = useState<Stack | null>(null);
  const [history, setHistory] = useState<UpdateHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [allowConsole, setAllowConsole] = useState(false);
  const [allowStack, setAllowStack] = useState(false);
  const [selfProject, setSelfProject] = useState<string | null>(null);
  const [managedStack, setManagedStack] = useState<ManagedStack | null>(null);
  const [allowNginx, setAllowNginx] = useState(false);
  const [openPanels, setOpenPanels] = useState<Record<number, PanelType | null>>({});
  const [inspectData, setInspectData] = useState<Record<number, ContainerInspect | null>>({});
  const [proxyHosts, setProxyHosts] = useState<ProxyHost[]>([]);
  const [showQuickSetup, setShowQuickSetup] = useState(false);
  const [quickSetup, setQuickSetup] = useState({ containerId: 0, domainInput: '', domains: [] as string[], forwardPort: 80, requestCert: false, acmeEmail: localStorage.getItem('oblihub_acme_email') || '' });
  const [containerStats, setContainerStats] = useState<Record<string, { cpu: number[]; mem: number[]; cpuNow: number; memNow: number }>>({});

  const load = async () => {
    if (!id) return;
    try {
      const [s, h] = await Promise.all([
        stacksApi.getById(Number(id)),
        stacksApi.getHistory(Number(id)),
      ]);
      setStack(s);
      setHistory(h);
    } catch { toast.error('Failed to load stack'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [id]);

  // Real-time updates via Socket.io
  useEffect(() => {
    const onStacksUpdated = (data: Stack[]) => {
      if (!id) return;
      const updated = data.find(s => s.id === Number(id));
      if (updated) setStack(updated);
    };
    socket.on(SOCKET_EVENTS.STACKS_UPDATED, onStacksUpdated);
    return () => { socket.off(SOCKET_EVENTS.STACKS_UPDATED, onStacksUpdated); };
  }, [socket, id]);

  // Real-time container stats
  useEffect(() => {
    const onStats = (data: ContainerStatsType[]) => {
      if (!stack) return;
      const stackDockerIds = new Set(stack.containers.map(c => c.dockerId));
      setContainerStats(prev => {
        const next = { ...prev };
        for (const s of data) {
          if (!stackDockerIds.has(s.dockerId)) continue;
          const existing = next[s.dockerId] || { cpu: [], mem: [], cpuNow: 0, memNow: 0 };
          const cpu = [...existing.cpu, s.cpuPercent].slice(-30);
          const mem = [...existing.mem, s.memoryPercent].slice(-30);
          next[s.dockerId] = { cpu, mem, cpuNow: s.cpuPercent, memNow: s.memoryPercent };
        }
        return next;
      });
    };
    socket.on(SOCKET_EVENTS.CONTAINER_STATS_UPDATE, onStats);
    return () => { socket.off(SOCKET_EVENTS.CONTAINER_STATS_UPDATE, onStats); };
  }, [socket, stack?.containers]);

  useEffect(() => {
    systemApi.getFeatures().then(f => {
      setAllowConsole(f.allowConsole);
      setAllowStack(f.allowStack);
      setAllowNginx(f.allowNginx);
      setSelfProject(f.selfProject);
    }).catch(() => {
      // Fallback: try the full system info
      systemApi.getInfo().then(info => {
        setAllowConsole(info.allowConsole);
        setAllowStack(info.allowStack);
      }).catch(() => {});
    });
  }, []);

  // Load proxy hosts linked to this stack + auto-refresh while certs pending
  useEffect(() => {
    if (!stack || !allowNginx) return;
    const refresh = () => proxyApi.getHostsByStack(stack.id).then(setProxyHosts).catch(() => {});
    refresh();
    const hasPending = proxyHosts.some(h => h.certificate && h.certificate.status === 'pending');
    if (hasPending) {
      const interval = setInterval(refresh, 5000);
      return () => clearInterval(interval);
    }
  }, [stack?.id, allowNginx, proxyHosts.some(h => h.certificate?.status === 'pending')]);

  // Try to find linked managed stack
  useEffect(() => {
    if (!stack?.composeProject || !allowStack) return;
    managedStacksApi.list().then(managed => {
      const match = managed.find(m => m.composeProject === stack.composeProject);
      setManagedStack(match || null);
    }).catch(() => {});
  }, [stack?.composeProject, allowStack]);

  const togglePanel = (containerId: number, type: PanelType) => {
    if (type === 'inspect' && openPanels[containerId] !== 'inspect') {
      // Load inspect data if not loaded
      if (!inspectData[containerId]) {
        containersApi.inspect(containerId).then(data => {
          setInspectData(prev => ({ ...prev, [containerId]: data }));
        }).catch(() => toast.error('Failed to inspect container'));
      }
    }
    setOpenPanels(prev => ({
      ...prev,
      [containerId]: prev[containerId] === type ? null : type,
    }));
  };

  const handleRestart = async (c: Container) => {
    try {
      await containersApi.restart(c.id);
      toast.success(`Restarting ${c.containerName}`);
      setTimeout(load, 3000);
    } catch { toast.error(`Failed to restart ${c.containerName}`); }
  };

  const handleStop = async (c: Container) => {
    try {
      await containersApi.stop(c.id);
      toast.success(`Stopping ${c.containerName}`);
      setTimeout(load, 3000);
    } catch { toast.error(`Failed to stop ${c.containerName}`); }
  };

  const handleStart = async (c: Container) => {
    try {
      await containersApi.start(c.id);
      toast.success(`Starting ${c.containerName}`);
      setTimeout(load, 3000);
    } catch { toast.error(`Failed to start ${c.containerName}`); }
  };

  if (loading) return <div className="flex items-center justify-center h-full"><div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" /></div>;
  if (!stack) return <div className="p-6 text-text-muted">Stack not found</div>;

  return (
    <div className="p-6 max-w-5xl">
      <button onClick={() => navigate('/')} className="flex items-center gap-1 text-sm text-text-muted hover:text-text-primary mb-4">
        <ArrowLeft size={14} /> Back
      </button>

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">{stack.name}</h1>
          {stack.composeProject && <p className="text-xs text-text-muted mt-1">Compose project: {stack.composeProject}</p>}
        </div>
        <div className="flex gap-2">
          {allowStack && managedStack && (
            <button onClick={() => navigate(`/stack-editor/${managedStack.id}`)} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-accent/50 text-accent hover:bg-accent/10">
              <FileEdit size={14} /> Edit Compose
            </button>
          )}
          {allowStack && !managedStack && stack.composeProject && (
            <button
              onClick={async () => {
                try {
                  const created = await managedStacksApi.create({
                    name: stack.name,
                    composeContent: `# Stack: ${stack.name}\n# Paste your docker-compose.yml content here\n\nservices:\n  # app:\n  #   image: your-image:latest\n  #   ports:\n  #     - "8080:80"\n`,
                  });
                  toast.success('Paste your docker-compose.yml content in the editor');
                  navigate(`/stack-editor/${created.id}`);
                } catch { toast.error('Failed to create managed stack'); }
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover"
            >
              <FileEdit size={14} /> Manage Stack
            </button>
          )}
          <button onClick={() => stacksApi.check(stack.id).then(load)} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">
            <RefreshCw size={14} /> Check Now
          </button>
          <button onClick={() => stacksApi.triggerUpdate(stack.id).then(load)} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover">
            <Play size={14} /> Update All
          </button>
          {allowStack && !(selfProject && stack.composeProject === selfProject) && (
            <button
              onClick={async () => {
                const msg = managedStack
                  ? 'Delete this managed stack? This will run "docker compose down" and remove all containers.'
                  : 'Remove this stack from Oblihub? The containers will keep running but won\'t be tracked anymore.';
                if (!confirm(msg)) return;
                try {
                  if (managedStack) {
                    await managedStacksApi.delete(managedStack.id);
                  }
                  await stacksApi.delete(stack.id);
                  toast.success('Stack deleted');
                  navigate('/');
                } catch { toast.error('Failed to delete stack'); }
              }}
              className="p-1.5 rounded-lg text-text-muted hover:text-status-down hover:bg-bg-hover"
              title="Delete stack"
            >
              <Trash2 size={16} />
            </button>
          )}
        </div>
      </div>

      {/* Containers */}
      <div className="rounded-xl border border-border bg-bg-secondary mb-6">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-text-secondary">Containers</h2>
        </div>
        <div className="divide-y divide-border">
          {stack.containers.map((c) => (
            <div key={c.id}>
              <div className="px-4 py-3 flex items-center gap-4">
                <div className={`h-2.5 w-2.5 rounded-full shrink-0 ${
                  c.status === 'up_to_date' ? 'bg-status-up' :
                  c.status === 'update_available' ? 'bg-status-pending' :
                  (c.status as string) === 'stopped' ? 'bg-status-down/50' :
                  c.status === 'error' ? 'bg-status-down' :
                  c.status === 'updating' ? 'bg-accent animate-pulse' : 'bg-text-muted'
                }`} />
                {c.status === 'stopped' && <span className="text-[10px] text-status-down/70 font-medium">Stopped</span>}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-text-primary">{c.containerName}</div>
                  <div className="text-xs text-text-muted">{c.image}:{c.imageTag}</div>
                </div>
                <div className="text-right shrink-0">
                  {c.currentDigest && (
                    <div className="text-[10px] font-mono text-text-muted" title={c.currentDigest}>
                      {c.currentDigest.slice(7, 19)}
                    </div>
                  )}
                  {c.latestDigest && c.latestDigest !== c.currentDigest && (
                    <div className="text-[10px] font-mono text-status-pending" title={c.latestDigest}>
                      &rarr; {c.latestDigest.slice(7, 19)}
                    </div>
                  )}
                </div>
                {/* Stats sparklines */}
                {containerStats[c.dockerId] && (
                  <div className="flex items-center gap-2 shrink-0">
                    <div className="text-center">
                      <Sparkline data={containerStats[c.dockerId].cpu} width={60} height={20} color="#4a9eff" />
                      <div className="text-[9px] text-text-muted">{containerStats[c.dockerId].cpuNow.toFixed(1)}% CPU</div>
                    </div>
                    <div className="text-center">
                      <Sparkline data={containerStats[c.dockerId].mem} width={60} height={20} color="#3fb950" />
                      <div className="text-[9px] text-text-muted">{containerStats[c.dockerId].memNow.toFixed(1)}% RAM</div>
                    </div>
                  </div>
                )}
                {c.excluded && <span className="text-[10px] text-text-muted bg-bg-tertiary px-1.5 py-0.5 rounded">Excluded</span>}

                {/* Action buttons */}
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => togglePanel(c.id, 'logs')}
                    className={`p-1.5 rounded-md transition-colors ${openPanels[c.id] === 'logs' ? 'bg-accent/20 text-accent' : 'text-text-muted hover:text-text-primary hover:bg-bg-hover'}`}
                    title="Logs"
                  >
                    <ScrollText size={14} />
                  </button>
                  <button
                    onClick={() => togglePanel(c.id, 'inspect')}
                    className={`p-1.5 rounded-md transition-colors ${openPanels[c.id] === 'inspect' ? 'bg-accent/20 text-accent' : 'text-text-muted hover:text-text-primary hover:bg-bg-hover'}`}
                    title="Inspect"
                  >
                    <Info size={14} />
                  </button>
                  {allowConsole && (
                    <button
                      onClick={() => togglePanel(c.id, 'console')}
                      className={`p-1.5 rounded-md transition-colors ${openPanels[c.id] === 'console' ? 'bg-accent/20 text-accent' : 'text-text-muted hover:text-text-primary hover:bg-bg-hover'}`}
                      title="Console"
                    >
                      <Terminal size={14} />
                    </button>
                  )}
                  <button
                    onClick={() => handleRestart(c)}
                    className="p-1.5 rounded-md text-text-muted hover:text-status-pending hover:bg-bg-hover transition-colors"
                    title="Restart"
                  >
                    <RotateCcw size={14} />
                  </button>
                  <button
                    onClick={() => handleStop(c)}
                    className="p-1.5 rounded-md text-text-muted hover:text-status-down hover:bg-bg-hover transition-colors"
                    title="Stop"
                  >
                    <Square size={14} />
                  </button>
                  <button
                    onClick={() => handleStart(c)}
                    className="p-1.5 rounded-md text-text-muted hover:text-status-up hover:bg-bg-hover transition-colors"
                    title="Start"
                  >
                    <Play size={14} />
                  </button>
                </div>
              </div>

              {/* Expandable panels */}
              {openPanels[c.id] === 'logs' && (
                <div className="px-4 pb-3">
                  <ContainerLogs dockerId={c.dockerId} onClose={() => togglePanel(c.id, 'logs')} />
                </div>
              )}
              {openPanels[c.id] === 'console' && (
                <div className="px-4 pb-3">
                  <ContainerConsole dockerId={c.dockerId} onClose={() => togglePanel(c.id, 'console')} />
                </div>
              )}
              {openPanels[c.id] === 'inspect' && (
                <div className="px-4 pb-3">
                  <div className="rounded-lg border border-border bg-bg-tertiary overflow-hidden">
                    <div className="flex items-center justify-between px-3 py-1.5 bg-bg-secondary border-b border-border">
                      <span className="text-xs font-medium text-text-secondary">Inspect</span>
                      <button onClick={() => togglePanel(c.id, 'inspect')} className="p-1 rounded hover:bg-bg-hover text-text-muted text-xs">&times;</button>
                    </div>
                    {inspectData[c.id] ? (
                      <div className="p-3 space-y-4 text-xs max-h-80 overflow-auto">
                        {/* Ports */}
                        {Object.keys(inspectData[c.id]!.ports).length > 0 && (
                          <div>
                            <div className="font-semibold text-text-secondary mb-1.5">Ports</div>
                            <div className="space-y-0.5">
                              {Object.entries(inspectData[c.id]!.ports).map(([port, bindings]) => (
                                <div key={port} className="flex gap-2 font-mono text-text-primary">
                                  <span className="text-text-muted">{(bindings[0]?.HostIp || '0.0.0.0')}:{bindings[0]?.HostPort}</span>
                                  <span className="text-text-muted">&rarr;</span>
                                  <span>{port}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {/* Networks */}
                        {Object.keys(inspectData[c.id]!.networks).length > 0 && (
                          <div>
                            <div className="font-semibold text-text-secondary mb-1.5">Networks</div>
                            <div className="space-y-0.5">
                              {Object.entries(inspectData[c.id]!.networks).map(([name, net]) => (
                                <div key={name} className="flex gap-3 font-mono text-text-primary">
                                  <span className="text-accent">{name}</span>
                                  <span className="text-text-muted">IP: {net.IPAddress || '-'}</span>
                                  <span className="text-text-muted">GW: {net.Gateway || '-'}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {/* Mounts */}
                        {inspectData[c.id]!.mounts.length > 0 && (
                          <div>
                            <div className="font-semibold text-text-secondary mb-1.5">Mounts</div>
                            <div className="space-y-0.5">
                              {inspectData[c.id]!.mounts.map((m, i) => (
                                <div key={i} className="font-mono text-text-primary">
                                  <span className="text-text-muted">{m.Source}</span>
                                  <span className="text-text-muted mx-1">&rarr;</span>
                                  <span>{m.Destination}</span>
                                  <span className="text-text-muted ml-2">({m.Type}{m.Mode ? `, ${m.Mode}` : ''})</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {/* Env */}
                        <div>
                          <div className="font-semibold text-text-secondary mb-1.5">Environment</div>
                          <div className="space-y-0.5 max-h-40 overflow-auto">
                            {inspectData[c.id]!.env.map((e, i) => {
                              const idx = e.indexOf('=');
                              const key = idx >= 0 ? e.substring(0, idx) : e;
                              const val = idx >= 0 ? e.substring(idx + 1) : '';
                              return (
                                <div key={i} className="font-mono text-text-primary">
                                  <span className="text-accent">{key}</span>
                                  <span className="text-text-muted">=</span>
                                  <span>{val}</span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="p-4 text-center text-text-muted text-xs">Loading...</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Proxy Hosts */}
      {allowNginx && (
        <div className="rounded-xl border border-border bg-bg-secondary mb-6">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <h2 className="text-sm font-semibold text-text-secondary flex items-center gap-1.5"><Globe size={14} /> Proxy Hosts</h2>
            <button onClick={() => {
              const prefillDomains: string[] = [];
              if (stack.url) {
                try { prefillDomains.push(new URL(stack.url).hostname); } catch { /* ignore */ }
              }
              setShowQuickSetup(true);
              setQuickSetup(q => ({ ...q, containerId: stack.containers[0]?.id || 0, domains: prefillDomains, domainInput: '' }));
            }}
              className="flex items-center gap-1 px-2 py-1 text-xs rounded-lg bg-accent text-white hover:bg-accent-hover">
              <Plus size={12} /> Add Proxy Host
            </button>
          </div>
          {proxyHosts.length > 0 ? (
            <div className="divide-y divide-border">
              {proxyHosts.map(ph => (
                <div key={ph.id} className="px-4 py-2.5 flex items-center gap-3">
                  <div className={`h-2 w-2 rounded-full shrink-0 ${ph.enabled ? (ph.certificate?.status === 'valid' ? 'bg-status-up' : 'bg-status-pending') : 'bg-text-muted'}`} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-text-primary">{ph.domainNames.join(', ')}</div>
                    <div className="text-[10px] text-text-muted">{ph.forwardScheme}://{ph.forwardHost}:{ph.forwardPort}</div>
                  </div>
                  <div className="flex items-center gap-1">
                    {ph.sslForced && <span className="text-[9px] px-1 py-0.5 rounded bg-status-up/10 text-status-up">SSL</span>}
                    {ph.websocketSupport && <span className="text-[9px] px-1 py-0.5 rounded bg-accent/10 text-accent">WS</span>}
                    {ph.certificate && <span className={`text-[9px] px-1 py-0.5 rounded ${ph.certificate.status === 'valid' ? 'bg-status-up/10 text-status-up' : 'bg-status-pending/10 text-status-pending'}`}><Shield size={8} className="inline mr-0.5" />{ph.certificate.status}</span>}
                  </div>
                  <div className="flex items-center gap-1">
                    <button onClick={async () => { await proxyApi.toggleHost(ph.id); proxyApi.getHostsByStack(stack.id).then(setProxyHosts); }}
                      className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover" title={ph.enabled ? 'Disable' : 'Enable'}>
                      {ph.enabled ? <Power size={12} /> : <PowerOff size={12} />}
                    </button>
                    <button onClick={async () => { if (confirm('Delete this proxy host?')) { await proxyApi.deleteHost(ph.id); toast.success('Deleted'); proxyApi.getHostsByStack(stack.id).then(setProxyHosts); } }}
                      className="p-1 rounded text-text-muted hover:text-status-down hover:bg-bg-hover">
                      <Trash2 size={12} />
                    </button>
                    <a href={`https://${ph.domainNames[0]}`} target="_blank" rel="noopener noreferrer" className="p-1 rounded text-text-muted hover:text-accent hover:bg-bg-hover">
                      <ExternalLink size={12} />
                    </a>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="px-4 py-6 text-center text-xs text-text-muted">No proxy hosts linked to this stack</div>
          )}
        </div>
      )}

      {/* Quick Setup Modal */}
      {showQuickSetup && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-16 bg-black/50" onClick={() => setShowQuickSetup(false)}>
          <div className="rounded-xl border border-border bg-bg-primary w-full max-w-lg shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-border">
              <h2 className="text-sm font-semibold text-text-primary">Quick Proxy Setup</h2>
              <p className="text-xs text-text-muted mt-0.5">Link a domain to a container in this stack</p>
            </div>
            <div className="p-6 space-y-4">
              {/* Container picker */}
              <div>
                <label className="text-xs font-medium text-text-secondary block mb-1.5">Container</label>
                <select value={quickSetup.containerId} onChange={e => setQuickSetup(q => ({ ...q, containerId: parseInt(e.target.value) }))}
                  className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent">
                  {stack.containers.map(c => (
                    <option key={c.id} value={c.id}>{c.containerName} ({c.image}:{c.imageTag})</option>
                  ))}
                </select>
              </div>

              {/* Port */}
              <div>
                <label className="text-xs font-medium text-text-secondary block mb-1.5">Forward Port</label>
                <input type="number" value={quickSetup.forwardPort} onChange={e => setQuickSetup(q => ({ ...q, forwardPort: parseInt(e.target.value) || 80 }))}
                  placeholder="80" className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
              </div>

              {/* Domain names */}
              <div>
                <label className="text-xs font-medium text-text-secondary block mb-1.5">Domain Names</label>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {quickSetup.domains.map(d => (
                    <span key={d} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-accent/10 text-accent text-xs font-mono">
                      {d} <button onClick={() => setQuickSetup(q => ({ ...q, domains: q.domains.filter(x => x !== d) }))} className="hover:text-status-down">&times;</button>
                    </span>
                  ))}
                </div>
                <div className="flex gap-2">
                  <input value={quickSetup.domainInput} onChange={e => setQuickSetup(q => ({ ...q, domainInput: e.target.value }))}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); const d = quickSetup.domainInput.trim().toLowerCase(); if (d && !quickSetup.domains.includes(d)) setQuickSetup(q => ({ ...q, domains: [...q.domains, d], domainInput: '' })); } }}
                    placeholder="app.example.com" className="flex-1 rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
                  <button onClick={() => { const d = quickSetup.domainInput.trim().toLowerCase(); if (d && !quickSetup.domains.includes(d)) setQuickSetup(q => ({ ...q, domains: [...q.domains, d], domainInput: '' })); }}
                    className="px-3 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">Add</button>
                </div>
              </div>

              {/* Let's Encrypt */}
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
                  <input type="checkbox" checked={quickSetup.requestCert} onChange={e => setQuickSetup(q => ({ ...q, requestCert: e.target.checked }))} className="rounded" />
                  <Shield size={12} /> Request Let's Encrypt SSL certificate
                </label>
                {quickSetup.requestCert && (
                  <input value={quickSetup.acmeEmail} onChange={e => setQuickSetup(q => ({ ...q, acmeEmail: e.target.value }))}
                    placeholder="admin@example.com" type="email"
                    className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
                )}
              </div>

              {/* Preview */}
              {quickSetup.domains.length > 0 && quickSetup.containerId > 0 && (
                <div className="rounded-lg bg-bg-tertiary p-3 text-xs">
                  <div className="text-text-muted mb-1">Preview:</div>
                  <div className="font-mono text-text-primary">
                    {quickSetup.domains[0]} &rarr; http://{stack.containers.find(c => c.id === quickSetup.containerId)?.containerName}:{quickSetup.forwardPort}
                  </div>
                  <div className="text-text-muted mt-1">WebSocket: on, Block Exploits: on{quickSetup.requestCert ? ', SSL: on, HTTP/2: on' : ''}</div>
                </div>
              )}
            </div>
            <div className="px-6 py-4 border-t border-border flex justify-end gap-2">
              <button onClick={() => setShowQuickSetup(false)} className="px-4 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">Cancel</button>
              <button
                onClick={async () => {
                  if (!quickSetup.domains.length) { toast.error('Enter at least one domain'); return; }
                  if (quickSetup.requestCert) localStorage.setItem('oblihub_acme_email', quickSetup.acmeEmail);
                  try {
                    await proxyApi.quickSetup({
                      stackId: stack.id,
                      containerId: quickSetup.containerId,
                      domainNames: quickSetup.domains,
                      forwardPort: quickSetup.forwardPort,
                      requestCertificate: quickSetup.requestCert,
                      acmeEmail: quickSetup.acmeEmail || undefined,
                    });
                    toast.success('Proxy host created!');
                    setShowQuickSetup(false);
                    proxyApi.getHostsByStack(stack.id).then(setProxyHosts);
                    // Auto-fill Stack URL if empty
                    if (!stack.url && quickSetup.domains.length > 0) {
                      const scheme = quickSetup.requestCert ? 'https' : 'http';
                      const autoUrl = `${scheme}://${quickSetup.domains[0]}`;
                      stacksApi.update(stack.id, { url: autoUrl }).then(updated => {
                        setStack(updated);
                        toast.success(`Stack URL set to ${autoUrl}`);
                      }).catch(() => {});
                    }
                  } catch { toast.error('Failed to create proxy host'); }
                }}
                className="px-4 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover"
              >
                Create Proxy Host
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Config */}
      <div className="rounded-xl border border-border bg-bg-secondary mb-6 p-4">
        <h2 className="text-sm font-semibold text-text-secondary mb-4 flex items-center gap-1.5"><Settings2 size={14} /> Configuration</h2>
        <div className="space-y-4">
          {/* Stack URL */}
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-text-primary">Stack URL</div>
              <div className="text-xs text-text-muted">Quick access link shown on dashboard</div>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="url"
                defaultValue={stack.url || ''}
                onBlur={async (e) => {
                  const val = e.target.value.trim() || null;
                  if (val !== (stack.url || null)) {
                    const updated = await stacksApi.update(stack.id, { url: val });
                    setStack(updated);
                    toast.success(val ? 'URL saved' : 'URL removed');
                  }
                }}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                placeholder="https://..."
                className="w-64 rounded-lg border border-border bg-bg-tertiary px-2 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
              />
              {stack.url && (
                <a href={stack.url} target="_blank" rel="noopener noreferrer" className="p-1.5 rounded-md text-accent hover:bg-accent/10" title="Open">
                  <ExternalLink size={14} />
                </a>
              )}
            </div>
          </div>

          {/* Check Interval */}
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-text-primary">Check Interval</div>
              <div className="text-xs text-text-muted">How often to check for updates</div>
            </div>
            <div className="flex items-center gap-2">
              <input type="number" min={10} max={86400} value={stack.checkInterval}
                onChange={async (e) => {
                  const val = parseInt(e.target.value, 10);
                  if (val >= 10) {
                    const updated = await stacksApi.update(stack.id, { checkInterval: val });
                    setStack(updated);
                  }
                }}
                onBlur={load}
                className="w-24 rounded-lg border border-border bg-bg-tertiary px-2 py-1.5 text-sm text-text-primary text-right focus:outline-none focus:ring-1 focus:ring-accent" />
              <span className="text-xs text-text-muted">seconds</span>
            </div>
          </div>

          {/* Auto-Update toggle */}
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-text-primary">Auto-Update</div>
              <div className="text-xs text-text-muted">Automatically pull and recreate containers when updates are detected</div>
            </div>
            <button
              onClick={async () => {
                const updated = await stacksApi.update(stack.id, { autoUpdate: !stack.autoUpdate });
                setStack(updated);
                toast.success(updated.autoUpdate ? 'Auto-update enabled' : 'Auto-update disabled');
              }}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${stack.autoUpdate ? 'bg-accent' : 'bg-bg-tertiary border border-border'}`}>
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${stack.autoUpdate ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
          </div>

          {/* Monitoring toggle */}
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-text-primary">Monitoring</div>
              <div className="text-xs text-text-muted">Enable or pause update checks for this stack</div>
            </div>
            <button
              onClick={async () => {
                const updated = await stacksApi.update(stack.id, { enabled: !stack.enabled });
                setStack(updated);
                toast.success(updated.enabled ? 'Monitoring enabled' : 'Monitoring paused');
              }}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${stack.enabled ? 'bg-status-up' : 'bg-bg-tertiary border border-border'}`}>
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${stack.enabled ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
          </div>
          {/* Notification overrides */}
          <div className="border-t border-border pt-4 mt-4">
            <div className="text-xs font-medium text-text-muted uppercase tracking-wider mb-3">Notification Overrides</div>
            <div className="space-y-3">
              {/* Notify update available */}
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium text-text-primary">Notify: Update Available</div>
                  <div className="text-xs text-text-muted">{stack.notifyUpdateAvailable === null ? 'Using global setting' : 'Overridden for this stack'}</div>
                </div>
                <div className="flex items-center gap-2">
                  {stack.notifyUpdateAvailable === null ? (
                    <button onClick={async () => { const updated = await stacksApi.update(stack.id, { notifyUpdateAvailable: true }); setStack(updated); }}
                      className="px-2.5 py-1 text-[10px] rounded-md border border-border text-text-muted hover:bg-bg-hover">Override</button>
                  ) : (
                    <>
                      <button onClick={async () => { const updated = await stacksApi.update(stack.id, { notifyUpdateAvailable: !stack.notifyUpdateAvailable }); setStack(updated); }}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${stack.notifyUpdateAvailable ? 'bg-status-up' : 'bg-status-down'}`}>
                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${stack.notifyUpdateAvailable ? 'translate-x-6' : 'translate-x-1'}`} />
                      </button>
                      <button onClick={async () => { const updated = await stacksApi.update(stack.id, { notifyUpdateAvailable: null }); setStack(updated); toast.success('Reset to global'); }}
                        className="px-2.5 py-1 text-[10px] rounded-md border border-accent/30 text-accent hover:bg-accent/10">Reset</button>
                    </>
                  )}
                </div>
              </div>

              {/* Notify update applied */}
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium text-text-primary">Notify: Update Applied</div>
                  <div className="text-xs text-text-muted">{stack.notifyUpdateApplied === null ? 'Using global setting' : 'Overridden for this stack'}</div>
                </div>
                <div className="flex items-center gap-2">
                  {stack.notifyUpdateApplied === null ? (
                    <button onClick={async () => { const updated = await stacksApi.update(stack.id, { notifyUpdateApplied: true }); setStack(updated); }}
                      className="px-2.5 py-1 text-[10px] rounded-md border border-border text-text-muted hover:bg-bg-hover">Override</button>
                  ) : (
                    <>
                      <button onClick={async () => { const updated = await stacksApi.update(stack.id, { notifyUpdateApplied: !stack.notifyUpdateApplied }); setStack(updated); }}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${stack.notifyUpdateApplied ? 'bg-status-up' : 'bg-status-down'}`}>
                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${stack.notifyUpdateApplied ? 'translate-x-6' : 'translate-x-1'}`} />
                      </button>
                      <button onClick={async () => { const updated = await stacksApi.update(stack.id, { notifyUpdateApplied: null }); setStack(updated); toast.success('Reset to global'); }}
                        className="px-2.5 py-1 text-[10px] rounded-md border border-accent/30 text-accent hover:bg-accent/10">Reset</button>
                    </>
                  )}
                </div>
              </div>

              {/* Notify delay */}
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium text-text-primary">Notification Delay</div>
                  <div className="text-xs text-text-muted">{stack.notifyDelay === null ? 'Using global setting' : `${stack.notifyDelay}s (overridden)`}</div>
                </div>
                <div className="flex items-center gap-2">
                  {stack.notifyDelay === null ? (
                    <button onClick={async () => { const updated = await stacksApi.update(stack.id, { notifyDelay: 300 }); setStack(updated); }}
                      className="px-2.5 py-1 text-[10px] rounded-md border border-border text-text-muted hover:bg-bg-hover">Override</button>
                  ) : (
                    <>
                      <input type="number" min={0} max={86400} value={stack.notifyDelay}
                        onBlur={async (e) => { const updated = await stacksApi.update(stack.id, { notifyDelay: parseInt(e.target.value) || 300 }); setStack(updated); }}
                        onChange={e => setStack(s => s ? { ...s, notifyDelay: parseInt(e.target.value) || 0 } : null)}
                        className="w-20 rounded-lg border border-border bg-bg-tertiary px-2 py-1.5 text-sm text-text-primary text-right focus:outline-none focus:ring-1 focus:ring-accent" />
                      <span className="text-xs text-text-muted">sec</span>
                      <button onClick={async () => { const updated = await stacksApi.update(stack.id, { notifyDelay: null }); setStack(updated); toast.success('Reset to global'); }}
                        className="px-2.5 py-1 text-[10px] rounded-md border border-accent/30 text-accent hover:bg-accent/10">Reset</button>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* History */}
      {history.length > 0 && (
        <div className="rounded-xl border border-border bg-bg-secondary">
          <div className="px-4 py-3 border-b border-border">
            <h2 className="text-sm font-semibold text-text-secondary">Update History</h2>
          </div>
          <div className="divide-y divide-border">
            {history.map((h) => (
              <div key={h.id} className="px-4 py-2.5 flex items-center gap-3 text-xs">
                <div className={`h-2 w-2 rounded-full shrink-0 ${
                  h.status === 'success' ? 'bg-status-up' : h.status === 'failed' ? 'bg-status-down' : 'bg-status-pending'
                }`} />
                <span className="text-text-primary font-medium">{h.containerName}</span>
                <span className="text-text-muted">{h.image}</span>
                <span className={`ml-auto ${h.status === 'success' ? 'text-status-up' : h.status === 'failed' ? 'text-status-down' : 'text-text-muted'}`}>
                  {h.status}
                </span>
                <span className="text-text-muted">{new Date(h.startedAt).toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
