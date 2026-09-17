import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Cpu, MemoryStick, Zap, RefreshCw, Activity, Pause, Play, Ban, ExternalLink, Save } from 'lucide-react';
import toast from 'react-hot-toast';
import { resourcesApi, type ResourcesDashboardResponse, type DashStack } from '@/api/resources.api';
import type { StackPriority, GpuInfo } from '@oblihub/shared';

const POLL_MS = 5000;

function priorityBadge(p: StackPriority) {
  const styles: Record<StackPriority, string> = {
    critical: 'bg-status-up/15 text-status-up border-status-up/30',
    normal: 'bg-accent/15 text-accent border-accent/30',
    opportunistic: 'bg-status-warning/15 text-status-warning border-status-warning/30',
  };
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider ${styles[p]}`}>
      {p}
    </span>
  );
}

function stateBadge(state: DashStack['state']) {
  const map: Record<DashStack['state'], { label: string; cls: string; icon: React.ReactNode }> = {
    running:              { label: 'Running',            cls: 'bg-status-up/10 text-status-up',           icon: <Play size={11} /> },
    'paused-by-watchdog': { label: 'Paused (watchdog)',  cls: 'bg-status-warning/15 text-status-warning', icon: <Pause size={11} /> },
    stopped:              { label: 'Stopped',            cls: 'bg-status-down/10 text-status-down',       icon: <Ban size={11} /> },
    mixed:                { label: 'Partial',            cls: 'bg-bg-tertiary text-text-muted',           icon: <Activity size={11} /> },
  };
  const m = map[state];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${m.cls}`}>
      {m.icon}
      {m.label}
    </span>
  );
}

function Bar({ value, max = 100, tone = 'accent' }: { value: number; max?: number; tone?: 'accent' | 'up' | 'warning' | 'down' }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const toneMap: Record<string, string> = {
    accent: 'bg-accent',
    up: 'bg-status-up',
    warning: 'bg-status-warning',
    down: 'bg-status-down',
  };
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-tertiary">
      <div className={`h-full ${toneMap[tone]} transition-[width] duration-500 ease-out`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function GpuChip({ id }: { id: string }) {
  return (
    <span className="inline-flex items-center rounded border border-border bg-bg-tertiary px-1.5 py-[1px] font-mono text-[10px] text-text-secondary">
      GPU {id}
    </span>
  );
}

function fmtBytes(n: number): string {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function ResourcesDashboardPage() {
  const [data, setData] = useState<ResourcesDashboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastAt, setLastAt] = useState<number | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    const load = async () => {
      try {
        const d = await resourcesApi.getResourcesDashboard();
        if (cancelled || !mounted.current) return;
        setData(d);
        setError(null);
        setLastAt(Date.now());
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load dashboard');
      }
    };
    load();
    const t = setInterval(load, POLL_MS);
    return () => { cancelled = true; mounted.current = false; clearInterval(t); };
  }, []);

  // Manual reload trigger — fired after a host-wide power-limit save so the UI reflects the
  // applied value without waiting for the next poll tick.
  const forceReload = async () => {
    try {
      const d = await resourcesApi.getResourcesDashboard();
      if (!mounted.current) return;
      setData(d);
      setLastAt(Date.now());
    } catch { /* soft — next poll will retry */ }
  };

  const stacksSorted = useMemo(() => {
    if (!data) return [];
    // Sort: Critical > Opportunistic > Normal, then busy first, then name.
    const rank: Record<StackPriority, number> = { critical: 0, opportunistic: 1, normal: 2 };
    return [...data.stacks].sort((a, b) => {
      const r = rank[a.priority] - rank[b.priority];
      if (r !== 0) return r;
      if (!!b.isBusyNow !== !!a.isBusyNow) return (b.isBusyNow ? 1 : 0) - (a.isBusyNow ? 1 : 0);
      return a.name.localeCompare(b.name);
    });
  }, [data]);

  if (!data && !error) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1400px] space-y-6 p-6">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-text-primary">Resources</h1>
          <p className="text-sm text-text-muted">Live view of what's running, on which GPUs, and who's currently yielded.</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <RefreshCw size={12} className="animate-spin-slow" />
          Auto-refresh every {POLL_MS / 1000}s
          {lastAt && <span className="ml-2 font-mono">· {new Date(lastAt).toLocaleTimeString()}</span>}
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-status-down/40 bg-status-down/10 p-3 text-sm text-status-down">
          {error}
        </div>
      )}

      {data && (
        <>
          <HostSummary data={data} />
          <StacksTable stacks={stacksSorted} />
          <GpuUtilization data={data} onSaved={forceReload} />
        </>
      )}
    </div>
  );
}

function HostSummary({ data }: { data: ResourcesDashboardResponse }) {
  const { host } = data;
  return (
    <section>
      <h2 className="mb-3 text-sm font-mono uppercase tracking-[0.14em] text-text-muted">Host</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border border-border bg-bg-secondary p-4">
          <div className="mb-1 flex items-center gap-2 text-xs text-text-muted"><Cpu size={13} /> CPU cores</div>
          <div className="flex items-baseline gap-2">
            <div className="text-2xl font-semibold text-text-primary">{host.cpuCount}</div>
            {host.cpuTemperatureCelsius != null && (
              <div className={`font-mono text-sm ${
                host.cpuTemperatureCelsius >= 85 ? 'text-status-down'
                : host.cpuTemperatureCelsius >= 75 ? 'text-status-warning'
                : 'text-text-muted'
              }`}>
                🌡 {host.cpuTemperatureCelsius.toFixed(0)}°C
              </div>
            )}
          </div>
          <div className="mt-1 font-mono text-[11px] text-text-muted truncate" title={host.cpuModel || undefined}>
            {host.cpuModel || `${host.arch} · ${host.platform}`}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-bg-secondary p-4">
          <div className="mb-1 flex items-center gap-2 text-xs text-text-muted"><MemoryStick size={13} /> Total RAM</div>
          <div className="text-2xl font-semibold text-text-primary">{host.ramGb} GB</div>
          <div className="mt-1 font-mono text-[11px] text-text-muted">{fmtBytes(host.ramBytes)}</div>
        </div>
        <div className="rounded-lg border border-border bg-bg-secondary p-4">
          <div className="mb-1 flex items-center gap-2 text-xs text-text-muted"><Zap size={13} /> GPUs detected</div>
          <div className="text-2xl font-semibold text-text-primary">{host.gpus.length}</div>
          <div className="mt-1 truncate font-mono text-[11px] text-text-muted">
            {host.gpus.length > 0 ? host.gpus[0].name : 'nvidia-smi unavailable'}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-bg-secondary p-4">
          <div className="mb-1 flex items-center gap-2 text-xs text-text-muted"><Activity size={13} /> Running stacks</div>
          <div className="text-2xl font-semibold text-text-primary">
            {data.stacks.filter(s => s.state === 'running').length}
            <span className="ml-1 text-base font-normal text-text-muted">/ {data.stacks.length}</span>
          </div>
          <div className="mt-1 font-mono text-[11px] text-text-muted">
            {data.stacks.filter(s => s.state === 'paused-by-watchdog').length} yielded
          </div>
        </div>
      </div>
    </section>
  );
}

function StacksTable({ stacks }: { stacks: DashStack[] }) {
  return (
    <section>
      <h2 className="mb-3 text-sm font-mono uppercase tracking-[0.14em] text-text-muted">Stacks</h2>
      <div className="overflow-x-auto rounded-lg border border-border bg-bg-secondary">
        <table className="w-full min-w-[1100px] text-sm">
          <thead>
            <tr className="border-b border-border bg-bg-tertiary/50 text-left">
              <Th>Stack</Th>
              <Th>Priority</Th>
              <Th>State</Th>
              <Th className="text-right">CPU cap</Th>
              <Th className="text-right">RAM cap</Th>
              <Th>GPUs</Th>
              <Th>Signal</Th>
              <Th>Busy</Th>
              <Th className="min-w-[180px]">Live conso</Th>
            </tr>
          </thead>
          <tbody>
            {stacks.length === 0 && (
              <tr>
                <td colSpan={9} className="p-8 text-center text-text-muted">No stacks discovered.</td>
              </tr>
            )}
            {stacks.map(s => <StackRow key={s.id} s={s} />)}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <th className={`px-3 py-2 text-[11px] font-mono uppercase tracking-wider text-text-muted ${className}`}>{children}</th>;
}

function StackRow({ s }: { s: DashStack }) {
  return (
    <tr className="border-b border-border last:border-b-0 hover:bg-bg-hover/40">
      <td className="px-3 py-2">
        <Link to={`/stack/${s.id}`} className="group inline-flex items-center gap-1.5 text-text-primary hover:text-accent">
          <span className="font-medium">{s.name}</span>
          <ExternalLink size={11} className="opacity-0 transition-opacity group-hover:opacity-100" />
        </Link>
        <div className="font-mono text-[10px] text-text-muted">
          {s.runningContainerCount}/{s.containerCount} containers
        </div>
      </td>
      <td className="px-3 py-2">{priorityBadge(s.priority)}</td>
      <td className="px-3 py-2">{stateBadge(s.state)}</td>
      <td className="px-3 py-2 text-right font-mono text-[12px] text-text-secondary">
        {s.cpuCapPercent != null ? `${s.cpuCapPercent}%` : <span className="text-text-muted">—</span>}
      </td>
      <td className="px-3 py-2 text-right font-mono text-[12px] text-text-secondary">
        {s.ramCapPercent != null ? `${s.ramCapPercent}%` : <span className="text-text-muted">—</span>}
      </td>
      <td className="px-3 py-2">
        {s.visibleGpuIds == null && <span className="text-[11px] text-text-muted">all</span>}
        {s.visibleGpuIds && s.visibleGpuIds.length === 0 && <span className="text-[11px] text-text-muted">none</span>}
        {s.visibleGpuIds && s.visibleGpuIds.length > 0 && (
          <div className="flex flex-wrap gap-1">{s.visibleGpuIds.map(id => <GpuChip key={id} id={id} />)}</div>
        )}
      </td>
      <td className="px-3 py-2">
        {s.priority === 'opportunistic' && s.yieldSignalSource ? (
          <span className="font-mono text-[11px] text-text-secondary">{s.yieldSignalSource}</span>
        ) : (
          <span className="text-text-muted">—</span>
        )}
      </td>
      <td className="px-3 py-2">
        {s.isBusyNow === true && (
          <span className="inline-flex items-center gap-1 rounded-full bg-status-up/15 px-2 py-0.5 text-[11px] font-medium text-status-up">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-status-up" /> Busy
          </span>
        )}
        {s.isBusyNow === false && <span className="text-[11px] text-text-muted">Idle</span>}
        {s.isBusyNow == null && <span className="text-text-muted">—</span>}
      </td>
      <td className="px-3 py-2">
        <ConsoBars s={s} />
      </td>
    </tr>
  );
}

function ConsoBars({ s }: { s: DashStack }) {
  const cpuUsed = s.conso.cpuPercentOfHost;
  const ramUsed = s.conso.ramPercentOfHost;
  const cpuOfCap = s.conso.cpuPercentOfCap;
  const ramOfCap = s.conso.ramPercentOfCap;
  const cpuTone = cpuOfCap != null && cpuOfCap > 90 ? 'down' : cpuOfCap != null && cpuOfCap > 70 ? 'warning' : 'accent';
  const ramTone = ramOfCap != null && ramOfCap > 90 ? 'down' : ramOfCap != null && ramOfCap > 70 ? 'warning' : 'accent';
  return (
    <div className="space-y-1.5">
      <div>
        <div className="mb-0.5 flex justify-between font-mono text-[10px] text-text-muted">
          <span>CPU</span>
          <span>
            {cpuUsed.toFixed(1)}% of host
            {cpuOfCap != null && <span className="ml-1 text-accent">· {cpuOfCap.toFixed(0)}% of cap</span>}
          </span>
        </div>
        <Bar value={cpuOfCap ?? cpuUsed} tone={cpuTone} />
      </div>
      <div>
        <div className="mb-0.5 flex justify-between font-mono text-[10px] text-text-muted">
          <span>RAM</span>
          <span>
            {fmtBytes(s.conso.ramBytes)}
            {ramOfCap != null && <span className="ml-1 text-accent">· {ramOfCap.toFixed(0)}% of cap</span>}
          </span>
        </div>
        <Bar value={ramOfCap ?? ramUsed} tone={ramTone} />
      </div>
    </div>
  );
}

/** Per-GPU card. Kept as its own component because it holds local state for the editable
 *  power-limit slider (pending wattage before Save + saving-in-flight flag). */
function GpuCard({
  gpu,
  live,
  appliedWatts,
  onSaved,
}: {
  gpu: GpuInfo;
  live: ResourcesDashboardResponse['host']['gpuLive'][number] | undefined;
  appliedWatts: number;
  onSaved: () => void;
}) {
  const minW = Math.max(1, Math.round(gpu.powerLimitMinWatts));
  const maxW = Math.max(minW + 1, Math.round(gpu.powerLimitMaxWatts));
  const [pending, setPending] = useState<number>(Math.round(appliedWatts));
  const [saving, setSaving] = useState(false);

  // Re-sync pending whenever the applied wattage moves (fresh poll or external change).
  const lastApplied = useRef<number>(Math.round(appliedWatts));
  useEffect(() => {
    if (Math.round(appliedWatts) !== lastApplied.current) {
      lastApplied.current = Math.round(appliedWatts);
      setPending(Math.round(appliedWatts));
    }
  }, [appliedWatts]);

  const dirty = pending !== Math.round(appliedWatts);

  const save = async () => {
    setSaving(true);
    try {
      const { watts } = await resourcesApi.setGpuPowerLimit(gpu.index, pending);
      toast.success(`GPU ${gpu.index} power limit set to ${Math.round(watts)}W`);
      onSaved();
    } catch (e) {
      toast.error(`Failed to set power limit: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const util = live?.utilizationGpuPercent ?? 0;
  const memUsed = live?.memoryUsedMb ?? 0;
  const memTotal = live?.memoryTotalMb ?? gpu.memoryTotalMb;
  const memPct = memTotal > 0 ? (memUsed / memTotal) * 100 : 0;
  const powerDraw = live?.powerDrawWatts ?? 0;
  const powerPct = appliedWatts > 0 ? (powerDraw / appliedWatts) * 100 : 0;
  const utilTone: 'accent' | 'warning' | 'down' = util > 90 ? 'down' : util > 60 ? 'warning' : 'accent';

  return (
    <div className="rounded-lg border border-border bg-bg-secondary p-4">
      <div className="mb-3 flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <GpuChip id={gpu.index} />
            <span className="text-sm font-medium text-text-primary">{gpu.name}</span>
          </div>
          <div className="mt-1 font-mono text-[11px] text-text-muted">
            {memTotal} MB VRAM · applied {appliedWatts.toFixed(0)}W ({gpu.powerLimitMinWatts.toFixed(0)}–{gpu.powerLimitMaxWatts.toFixed(0)}W range)
          </div>
          {/* Temp + fan on their own line — only shown when nvidia-smi returned a value. Passive
           *  L40S/A100 cards show temp but no fan (null), silently omitted. */}
          {(live?.temperatureCelsius != null || live?.fanSpeedPercent != null) && (
            <div className="mt-1 flex items-center gap-3 font-mono text-[11px]">
              {live?.temperatureCelsius != null && (
                <span className={
                  live.temperatureCelsius >= 85 ? 'text-status-down'
                  : live.temperatureCelsius >= 75 ? 'text-status-warning'
                  : 'text-text-muted'
                }>
                  🌡 {live.temperatureCelsius.toFixed(0)}°C
                </span>
              )}
              {live?.fanSpeedPercent != null && (
                <span className="text-text-muted">🌀 {live.fanSpeedPercent.toFixed(0)}%</span>
              )}
            </div>
          )}
        </div>
        <div className="text-right">
          <div className={`text-2xl font-semibold ${util > 90 ? 'text-status-down' : util > 60 ? 'text-status-warning' : 'text-accent'}`}>
            {util.toFixed(0)}%
          </div>
          <div className="text-[10px] font-mono text-text-muted">GPU util</div>
        </div>
      </div>

      <div className="space-y-2">
        <div>
          <div className="mb-0.5 flex justify-between font-mono text-[10px] text-text-muted">
            <span>Compute</span><span>{util.toFixed(0)}%</span>
          </div>
          <Bar value={util} tone={utilTone} />
        </div>
        <div>
          <div className="mb-0.5 flex justify-between font-mono text-[10px] text-text-muted">
            <span>VRAM</span><span>{memUsed}/{memTotal} MB · {memPct.toFixed(0)}%</span>
          </div>
          <Bar value={memPct} tone={memPct > 90 ? 'warning' : 'accent'} />
        </div>
        <div>
          <div className="mb-0.5 flex justify-between font-mono text-[10px] text-text-muted">
            <span>Power draw</span><span>{powerDraw.toFixed(0)}W / {appliedWatts.toFixed(0)}W · {powerPct.toFixed(0)}%</span>
          </div>
          <Bar value={powerPct} tone={powerPct > 95 ? 'down' : powerPct > 80 ? 'warning' : 'up'} />
        </div>
      </div>

      {/* Editable host-wide power limit. Live throughout the app: any container using this GPU
       *  is throttled the moment nvidia-smi -pl returns. Discourage micro-tuning by requiring
       *  an explicit Save (avoids driver spam during slider drag). */}
      <div className="mt-4 border-t border-border pt-3">
        <div className="mb-1.5 flex items-center justify-between text-[11px] font-mono uppercase tracking-wider text-text-muted">
          <span>Host-wide power limit</span>
          <span className="text-text-primary">
            {pending}W {dirty && <span className="text-status-warning">(unsaved)</span>}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={minW}
            max={maxW}
            step={5}
            value={pending}
            onChange={e => setPending(parseInt(e.target.value, 10))}
            disabled={saving}
            className="flex-1"
          />
          <button
            type="button"
            onClick={save}
            disabled={!dirty || saving}
            className="inline-flex items-center gap-1 rounded-md border border-accent/40 bg-accent/10 px-2 py-1 text-[11px] text-accent hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-40"
            title="Apply via nvidia-smi -pl on the host"
          >
            <Save size={11} /> {saving ? 'Applying…' : 'Save'}
          </button>
        </div>
        <div className="mt-1 text-[10px] text-text-muted">
          Range {minW}–{maxW}W. Affects any container using this GPU — including stacks not managed by Oblihub.
        </div>
      </div>
    </div>
  );
}

function GpuUtilization({ data, onSaved }: { data: ResourcesDashboardResponse; onSaved: () => void }) {
  const { host } = data;
  if (host.gpus.length === 0) {
    return (
      <section>
        <h2 className="mb-3 text-sm font-mono uppercase tracking-[0.14em] text-text-muted">GPU utilization</h2>
        <div className="rounded-lg border border-border bg-bg-secondary p-6 text-center text-sm text-text-muted">
          No NVIDIA GPUs detected — either no GPU or <code className="font-mono text-xs">nvidia-smi</code> not available inside the oblihub-server container.
        </div>
      </section>
    );
  }

  const liveByIdx = new Map(host.gpuLive.map(g => [g.index, g]));

  return (
    <section>
      <h2 className="mb-3 text-sm font-mono uppercase tracking-[0.14em] text-text-muted">GPU utilization</h2>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {host.gpus.map(g => {
          const applied = host.currentPowerLimits[g.index] ?? g.powerLimitCurrentWatts;
          return (
            <GpuCard
              key={g.index}
              gpu={g}
              live={liveByIdx.get(g.index)}
              appliedWatts={applied}
              onSaved={onSaved}
            />
          );
        })}
      </div>
    </section>
  );
}
