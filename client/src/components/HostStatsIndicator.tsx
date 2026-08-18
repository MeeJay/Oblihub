import { useHostStats } from '@/hooks/useHostStats';
import { Cpu, MemoryStick, HardDrive } from 'lucide-react';

function fmtBytes(n: number): string {
  if (!isFinite(n) || n <= 0) return '0';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n, u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v.toFixed(v >= 10 || u === 0 ? 0 : 1)} ${units[u]}`;
}

/**
 * Return the accent color for a percentage — green/orange/red bands. Kept in one place so any
 * future indicator (dashboard tile, log line, etc.) can reuse the same thresholds.
 *   < 70%  → green   (nominal)
 *   70-90% → orange  (heads up — a big build might tip it)
 *   ≥ 90%  → red    (critical — stop and free something)
 * Fixed thresholds are fine here: RAM/disk/CPU all agree that 90%+ is the danger zone in
 * practice, and 70% is the classic "start paying attention" threshold.
 */
function colorFor(pct: number | null): { fill: string; text: string; ring: string; label: 'ok' | 'warn' | 'crit' | 'na' } {
  if (pct == null) return { fill: 'bg-text-muted/40', text: 'text-text-muted', ring: 'ring-text-muted/20', label: 'na' };
  if (pct >= 90) return { fill: 'bg-status-critical', text: 'text-status-critical', ring: 'ring-status-critical/40', label: 'crit' };
  if (pct >= 70) return { fill: 'bg-status-warning', text: 'text-status-warning', ring: 'ring-status-warning/40', label: 'warn' };
  return { fill: 'bg-status-up', text: 'text-status-up', ring: 'ring-status-up/20', label: 'ok' };
}

/** Compact bar with percent label. Clickable-looking, tooltip carries the raw numbers. */
function Bar({ icon: Icon, pct, tooltip }: { icon: typeof Cpu; pct: number | null; tooltip: string }) {
  const c = colorFor(pct);
  const displayPct = pct == null ? '—' : `${Math.round(pct)}%`;
  const pulseWhenCrit = c.label === 'crit' ? 'animate-pulse' : '';
  return (
    <div
      title={tooltip}
      className={`flex items-center gap-1.5 px-2 py-1 rounded-md bg-bg-hover ring-1 ${c.ring} ${pulseWhenCrit}`}
    >
      <Icon size={12} className={c.text} />
      <div className="flex flex-col leading-tight">
        <span className={`text-[11px] font-semibold ${c.text}`}>{displayPct}</span>
        <div className="w-10 h-1 rounded-full bg-bg-tertiary overflow-hidden">
          <div className={`h-full ${c.fill} transition-all`} style={{ width: `${Math.min(100, pct ?? 0)}%` }} />
        </div>
      </div>
    </div>
  );
}

/**
 * Header widget: CPU / RAM / Disk of the Oblihub host. Refreshes every 5s. Colors turn amber
 * >70% and red >90% (with a subtle pulse animation on red) so a runaway build screams for
 * attention no matter which page the operator happens to be on.
 *
 * Deliberately compact: fits between the app-switcher and the notification bell without
 * crowding the topbar. Full details are in the hover tooltip on each bar.
 */
export function HostStatsIndicator() {
  const stats = useHostStats(5000);
  if (!stats) return null;
  const { cpu, ram, disk } = stats;
  return (
    <div className="hidden md:flex items-center gap-1.5">
      <Bar
        icon={Cpu}
        pct={cpu.percent}
        tooltip={`CPU: ${cpu.percent == null ? 'n/a' : `${cpu.percent.toFixed(1)}%`} of ${cpu.cores} core${cpu.cores === 1 ? '' : 's'}\nLoad avg: ${stats.loadAvg.map(l => l.toFixed(2)).join(' / ')}`}
      />
      <Bar
        icon={MemoryStick}
        pct={ram.percent}
        tooltip={`RAM: ${fmtBytes(ram.used)} / ${fmtBytes(ram.total)}${ram.percent == null ? '' : ` (${ram.percent.toFixed(1)}%)`}`}
      />
      <Bar
        icon={HardDrive}
        pct={disk.percent}
        tooltip={`Disk (${disk.path}): ${fmtBytes(disk.used)} / ${fmtBytes(disk.total)}${disk.percent == null ? '' : ` (${disk.percent.toFixed(1)}%)`}\nWatch during builds — build cache lives here.`}
      />
    </div>
  );
}
