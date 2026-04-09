import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, RefreshCw, Play, Settings2, RotateCcw, Square, Terminal, ScrollText, FileEdit, Info, Trash2, ExternalLink } from 'lucide-react';
import { stacksApi, containersApi, systemApi } from '@/api/stacks.api';
import { managedStacksApi } from '@/api/managed-stacks.api';
import { ContainerLogs } from '@/components/ContainerLogs';
import { ContainerConsole } from '@/components/ContainerConsole';
import type { Stack, Container, UpdateHistoryEntry, ManagedStack, DockerNetwork } from '@oblihub/shared';
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
  const [stack, setStack] = useState<Stack | null>(null);
  const [history, setHistory] = useState<UpdateHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [allowConsole, setAllowConsole] = useState(false);
  const [allowStack, setAllowStack] = useState(false);
  const [managedStack, setManagedStack] = useState<ManagedStack | null>(null);
  const [openPanels, setOpenPanels] = useState<Record<number, PanelType | null>>({});
  const [inspectData, setInspectData] = useState<Record<number, ContainerInspect | null>>({});

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

  useEffect(() => {
    systemApi.getFeatures().then(f => {
      setAllowConsole(f.allowConsole);
      setAllowStack(f.allowStack);
    }).catch(() => {
      // Fallback: try the full system info
      systemApi.getInfo().then(info => {
        setAllowConsole(info.allowConsole);
        setAllowStack(info.allowStack);
      }).catch(() => {});
    });
  }, []);

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
          <button onClick={() => stacksApi.check(stack.id).then(load)} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">
            <RefreshCw size={14} /> Check Now
          </button>
          <button onClick={() => stacksApi.triggerUpdate(stack.id).then(load)} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover">
            <Play size={14} /> Update All
          </button>
          {allowStack && (
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
                  // TODO: remove discovered stack from DB if needed
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
                  c.status === 'error' ? 'bg-status-down' :
                  c.status === 'updating' ? 'bg-accent animate-pulse' : 'bg-text-muted'
                }`} />
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
                value={stack.url || ''}
                onChange={async (e) => {
                  const updated = await stacksApi.update(stack.id, { url: e.target.value || null });
                  setStack(updated);
                }}
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
