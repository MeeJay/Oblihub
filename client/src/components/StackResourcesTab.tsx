import { useEffect, useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { Cpu, MemoryStick, Zap, AlertTriangle, Trash2, Save, RefreshCw } from 'lucide-react';
import { stacksApi, type StackResourcesResponse } from '@/api/stacks.api';
import type { ResourceLimits, StackPriority, YieldMode, YieldSignalSource } from '@oblihub/shared';

interface Props { stackId: number }

const PRIORITY_DESCRIPTIONS: Record<StackPriority, string> = {
  critical: 'Always up. First pick on CPU / GPU. Yields nothing.',
  normal: 'Always up. Reduces CPU share when a Critical is contending, never paused.',
  opportunistic: 'Pauses or stops when a Critical you yield to becomes busy. Resumes after idle timeout.',
};

function defaultLimits(): ResourceLimits {
  return {
    priority: 'normal',
    cpuPercent: null,
    ramPercent: null,
    cpuShares: null,
    visibleGpuIds: null,
    powerLimitWatts: null,
    yieldsToStackIds: null,
    yieldSignalSource: 'nginx-traffic',
    yieldIdleTimeoutSeconds: 30,
    yieldMode: 'stop',
  };
}

export function StackResourcesTab({ stackId }: Props) {
  const [state, setState] = useState<StackResourcesResponse | null>(null);
  const [limits, setLimits] = useState<ResourceLimits>(defaultLimits());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshingGpus, setRefreshingGpus] = useState(false);

  const load = useCallback(async (): Promise<StackResourcesResponse | null> => {
    try {
      const r = await stacksApi.getStackResources(stackId);
      setState(r);
      setLimits(r.limits || defaultLimits());
      return r;
    } catch {
      toast.error('Failed to load resources');
      return null;
    }
  }, [stackId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await load();
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [load]);

  const refreshGpus = async () => {
    setRefreshingGpus(true);
    try {
      await load();
      toast.success('GPU detection refreshed');
    } finally {
      setRefreshingGpus(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const { powerLimitErrors } = await stacksApi.setStackResources(stackId, limits);
      if (powerLimitErrors.length === 0) {
        toast.success('Resource limits applied');
      } else {
        const msg = powerLimitErrors.map(e => `GPU ${e.gpuIndex} → ${e.watts}W: ${e.error}`).join('; ');
        toast.error(`Saved, but ${powerLimitErrors.length} GPU power limit${powerLimitErrors.length > 1 ? 's' : ''} failed: ${msg}`, { duration: 8000 });
      }
      await load();
    } catch { toast.error('Failed to save limits'); }
    finally { setSaving(false); }
  };

  const clear = async () => {
    if (!confirm('Clear the override and revert to the plain docker-compose.yml? Containers will be recreated.')) return;
    setSaving(true);
    try {
      await stacksApi.clearStackResources(stackId);
      toast.success('Override cleared');
      await load();
    } catch { toast.error('Failed to clear'); }
    finally { setSaving(false); }
  };

  const toggleGpuVisible = (idx: string, checked: boolean) => {
    const cur = limits.visibleGpuIds == null
      ? (state?.hostGpus.map(g => g.index) ?? [])
      : [...limits.visibleGpuIds];
    const next = checked
      ? Array.from(new Set([...cur, idx]))
      : cur.filter(i => i !== idx);
    setLimits({ ...limits, visibleGpuIds: next });
  };

  const setPowerWatts = (idx: string, watts: number) => {
    const cur = { ...(limits.powerLimitWatts ?? {}) };
    cur[idx] = watts;
    setLimits({ ...limits, powerLimitWatts: cur });
  };

  const clearPowerWatts = (idx: string) => {
    if (!limits.powerLimitWatts) return;
    const cur = { ...limits.powerLimitWatts };
    delete cur[idx];
    setLimits({ ...limits, powerLimitWatts: Object.keys(cur).length === 0 ? null : cur });
  };

  if (loading || !state) {
    return <div className="rounded-xl border border-border bg-bg-secondary p-6 text-center text-xs text-text-muted">Loading resources…</div>;
  }

  const cpuPercent = limits.cpuPercent ?? 100;
  const ramPercent = limits.ramPercent ?? 100;
  const absoluteCpus = Math.round((cpuPercent / 100) * state.hostCpuCount * 10) / 10;
  const absoluteRamGb = Math.round((ramPercent / 100) * state.hostRamGb * 10) / 10;

  return (
    <div className="rounded-xl border border-border bg-bg-secondary p-4 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-text-secondary flex items-center gap-1.5">
            <Zap size={14} /> Resource Limits
          </h2>
          <p className="text-xs text-text-muted mt-0.5">
            Managed via <code className="font-mono">docker-compose.override.oblihub.yml</code> — your base compose file is never modified.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={clear}
            disabled={saving || !state.limits}
            className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-lg border border-status-down/40 text-status-down hover:bg-status-down/10 disabled:opacity-40 disabled:cursor-not-allowed"
            title="Remove the override and revert to plain docker-compose.yml"
          >
            <Trash2 size={12} /> Clear
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-lg bg-accent text-white hover:bg-accent-hover disabled:opacity-40"
          >
            <Save size={12} /> {saving ? 'Applying…' : 'Save & Apply'}
          </button>
        </div>
      </div>

      {/* Priority */}
      <div>
        <div className="text-xs font-medium text-text-muted uppercase tracking-wider mb-2">Priority</div>
        <div className="space-y-1.5">
          {(['critical', 'normal', 'opportunistic'] as StackPriority[]).map(p => (
            <label key={p} className={`block rounded-lg border p-3 cursor-pointer transition-colors ${limits.priority === p ? 'border-accent bg-accent/5' : 'border-border hover:bg-bg-hover'}`}>
              <div className="flex items-start gap-2.5">
                <input
                  type="radio"
                  name="priority"
                  checked={limits.priority === p}
                  onChange={() => setLimits({ ...limits, priority: p })}
                  className="mt-0.5"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-text-primary capitalize">{p}</div>
                  <div className="text-xs text-text-muted mt-0.5">{PRIORITY_DESCRIPTIONS[p]}</div>
                </div>
              </div>
            </label>
          ))}
        </div>
      </div>

      {/* CPU */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs font-medium text-text-muted uppercase tracking-wider flex items-center gap-1.5">
            <Cpu size={12} /> CPU cap
          </div>
          <div className="text-xs font-mono text-text-primary">
            {absoluteCpus} / {state.hostCpuCount} vCPU <span className="text-text-muted">({cpuPercent}%)</span>
          </div>
        </div>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={cpuPercent}
          onChange={e => setLimits({ ...limits, cpuPercent: parseInt(e.target.value, 10) })}
          className="w-full"
        />
        <button
          onClick={() => setLimits({ ...limits, cpuPercent: null })}
          className="text-[10px] text-text-muted hover:text-text-primary mt-1"
        >
          {limits.cpuPercent === null ? 'No cap (uncapped)' : 'Reset to uncapped'}
        </button>
      </div>

      {/* RAM */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs font-medium text-text-muted uppercase tracking-wider flex items-center gap-1.5">
            <MemoryStick size={12} /> RAM cap
          </div>
          <div className="text-xs font-mono text-text-primary">
            {absoluteRamGb} / {state.hostRamGb} GB <span className="text-text-muted">({ramPercent}%)</span>
          </div>
        </div>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={ramPercent}
          onChange={e => setLimits({ ...limits, ramPercent: parseInt(e.target.value, 10) })}
          className="w-full"
        />
        <button
          onClick={() => setLimits({ ...limits, ramPercent: null })}
          className="text-[10px] text-text-muted hover:text-text-primary mt-1"
        >
          {limits.ramPercent === null ? 'No cap (uncapped)' : 'Reset to uncapped'}
        </button>
      </div>

      {/* GPU visibility + power limits */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs font-medium text-text-muted uppercase tracking-wider">GPU visibility &amp; power</div>
          <button
            onClick={refreshGpus}
            disabled={refreshingGpus}
            className="flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-border text-text-muted hover:text-text-primary hover:bg-bg-hover disabled:opacity-40"
            title="Re-query nvidia-smi on the host"
          >
            <RefreshCw size={11} className={refreshingGpus ? 'animate-spin' : ''} /> Refresh detection
          </button>
        </div>

        {state.hostGpus.length === 0 ? (
          <div className="rounded-lg border border-border bg-bg-tertiary p-3 text-xs text-text-muted">
            No NVIDIA GPUs found on host — either no GPU or <code className="font-mono">nvidia-smi</code> missing from the
            oblihub-server container image.
          </div>
        ) : (
          <>
            <div className="text-[11px] text-text-muted mb-2 leading-relaxed">
              Sets <code className="font-mono">NVIDIA_VISIBLE_DEVICES</code> for every service in the stack.
              Leave <span className="text-text-primary">all checked</span> for full visibility (default).
              Leave <span className="text-text-primary">all unchecked</span> to expose no GPUs to the container.
            </div>
            <div className="rounded-lg border border-border bg-bg-tertiary p-3 space-y-3">
              {state.hostGpus.map(g => {
                const checked = limits.visibleGpuIds == null || limits.visibleGpuIds.includes(g.index);
                const configuredWatts = limits.powerLimitWatts?.[g.index];
                const sliderValue = configuredWatts ?? g.powerLimitCurrentWatts;
                const appliedWatts = state.currentPowerLimits?.[g.index];
                const minW = Math.max(1, Math.round(g.powerLimitMinWatts));
                const maxW = Math.max(minW + 1, Math.round(g.powerLimitMaxWatts));
                return (
                  <div key={g.index} className="pb-3 last:pb-0 border-b border-border last:border-0 space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={e => toggleGpuVisible(g.index, e.target.checked)}
                        />
                        <span className="font-mono text-accent">GPU {g.index}</span>
                        <span className="text-text-primary">{g.name}</span>
                      </label>
                      <div className="font-mono text-text-muted">
                        {(g.memoryTotalMb / 1024).toFixed(1)} GB · range {minW}–{maxW}W
                        {appliedWatts != null && (
                          <span className="ml-2">
                            · applied <span className="text-text-primary">{Math.round(appliedWatts)}W</span>
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min={minW}
                        max={maxW}
                        step={5}
                        value={Math.max(minW, Math.min(maxW, Math.round(sliderValue)))}
                        onChange={e => setPowerWatts(g.index, parseInt(e.target.value, 10))}
                        className="flex-1"
                      />
                      <div className="w-16 text-right font-mono text-xs text-text-primary">
                        {configuredWatts != null ? Math.round(configuredWatts) : Math.round(g.powerLimitCurrentWatts)}W
                      </div>
                      <button
                        onClick={() => clearPowerWatts(g.index)}
                        disabled={configuredWatts == null}
                        className="text-[10px] text-text-muted hover:text-text-primary disabled:opacity-40"
                        title="Don't set a power limit from this stack"
                      >
                        reset
                      </button>
                    </div>
                    <div className="flex items-start gap-1.5 text-[10px] text-text-muted">
                      <AlertTriangle size={10} className="shrink-0 mt-0.5" />
                      <span>Host-wide — affects any container using this GPU.</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* Opportunistic-only settings */}
      {limits.priority === 'opportunistic' && (
        <div className="rounded-lg border border-border bg-bg-tertiary p-3 space-y-4">
          <div className="text-xs font-medium text-text-muted uppercase tracking-wider">Yield behavior</div>

          {/* Yields to */}
          <div>
            <div className="text-xs font-medium text-text-primary mb-1.5">Yields to</div>
            {state.criticalStacks.length === 0 ? (
              <div className="text-xs text-text-muted italic">No Critical stacks configured yet — set another stack's priority to Critical first.</div>
            ) : (
              <div className="space-y-1">
                {state.criticalStacks.map(cs => {
                  const checked = (limits.yieldsToStackIds || []).includes(cs.id);
                  return (
                    <label key={cs.id} className="flex items-center gap-2 text-xs cursor-pointer">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={e => {
                          const cur = limits.yieldsToStackIds || [];
                          setLimits({
                            ...limits,
                            yieldsToStackIds: e.target.checked
                              ? [...cur, cs.id]
                              : cur.filter(id => id !== cs.id),
                          });
                        }}
                      />
                      <span className="text-text-primary">{cs.name}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          {/* Signal source */}
          <div>
            <div className="text-xs font-medium text-text-primary mb-1.5">Busy-signal source</div>
            <div className="flex gap-3 text-xs">
              {(['nginx-traffic', 'gpu-util', 'webhook'] as YieldSignalSource[]).map(src => (
                <label key={src} className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="signal-source"
                    checked={limits.yieldSignalSource === src}
                    onChange={() => setLimits({ ...limits, yieldSignalSource: src })}
                  />
                  <span className="text-text-primary">{src}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Idle timeout */}
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs font-medium text-text-primary">Idle timeout</div>
              <div className="text-[10px] text-text-muted">Resume this stack after the Critical is quiet for this long.</div>
            </div>
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                min={1}
                max={86400}
                value={limits.yieldIdleTimeoutSeconds ?? 30}
                onChange={e => setLimits({ ...limits, yieldIdleTimeoutSeconds: parseInt(e.target.value, 10) || 30 })}
                className="w-20 rounded border border-border bg-bg-primary px-2 py-1 text-xs text-text-primary text-right focus:outline-none focus:ring-1 focus:ring-accent"
              />
              <span className="text-xs text-text-muted">sec</span>
            </div>
          </div>

          {/* Yield mode */}
          <div>
            <div className="text-xs font-medium text-text-primary mb-1.5">Yield mode</div>
            <div className="flex gap-3 text-xs">
              {(['pause', 'stop'] as YieldMode[]).map(m => (
                <label key={m} className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="yield-mode"
                    checked={limits.yieldMode === m}
                    onChange={() => setLimits({ ...limits, yieldMode: m })}
                  />
                  <span className="text-text-primary">{m}</span>
                </label>
              ))}
            </div>
            {limits.yieldMode === 'pause' && (
              <div className="mt-2 flex items-start gap-1.5 rounded border border-status-warning/40 bg-status-warning/10 p-2 text-[11px] text-status-warning">
                <AlertTriangle size={12} className="shrink-0 mt-0.5" />
                <span>Pause keeps GPU VRAM allocated. If the Critical shares the same GPU, use <code>stop</code> instead.</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
