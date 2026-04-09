import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, RefreshCw, Play, Settings2, RotateCcw, Square, Terminal, ScrollText } from 'lucide-react';
import { stacksApi, containersApi, systemApi } from '@/api/stacks.api';
import { ContainerLogs } from '@/components/ContainerLogs';
import { ContainerConsole } from '@/components/ContainerConsole';
import type { Stack, Container, UpdateHistoryEntry } from '@oblihub/shared';
import toast from 'react-hot-toast';

type PanelType = 'logs' | 'console';

export function StackDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [stack, setStack] = useState<Stack | null>(null);
  const [history, setHistory] = useState<UpdateHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [allowConsole, setAllowConsole] = useState(false);
  const [openPanels, setOpenPanels] = useState<Record<number, PanelType | null>>({});

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
    systemApi.getInfo().then(info => setAllowConsole(info.allowConsole)).catch(() => {});
  }, []);

  const togglePanel = (containerId: number, type: PanelType) => {
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
          <button onClick={() => stacksApi.check(stack.id).then(load)} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">
            <RefreshCw size={14} /> Check Now
          </button>
          <button onClick={() => stacksApi.triggerUpdate(stack.id).then(load)} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover">
            <Play size={14} /> Update All
          </button>
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
            </div>
          ))}
        </div>
      </div>

      {/* Config */}
      <div className="rounded-xl border border-border bg-bg-secondary mb-6 p-4">
        <h2 className="text-sm font-semibold text-text-secondary mb-4 flex items-center gap-1.5"><Settings2 size={14} /> Configuration</h2>
        <div className="space-y-4">
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
