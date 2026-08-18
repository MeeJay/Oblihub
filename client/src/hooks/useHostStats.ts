import { useEffect, useState } from 'react';

export interface HostStats {
  cpu: { percent: number | null; cores: number };
  ram: { used: number; total: number; percent: number | null };
  disk: { used: number; total: number; percent: number | null; path: string };
  loadAvg: [number, number, number];
  measuredAt: string;
}

/**
 * Poll `/api/system/host-stats` every N seconds. Shared across every component that consumes
 * it (there's only one, the header indicator, but keeping the pattern for future dashboards).
 * Failures are swallowed silently — the indicator just shows dashes and moves on.
 */
export function useHostStats(intervalMs = 5000): HostStats | null {
  const [stats, setStats] = useState<HostStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchOnce = () => {
      fetch('/api/system/host-stats', { credentials: 'include' })
        .then(r => r.json())
        .then((d: { success: boolean; data?: HostStats }) => {
          if (!cancelled && d.success && d.data) setStats(d.data);
        })
        .catch(() => { /* soft failure */ });
    };
    fetchOnce();
    const id = setInterval(fetchOnce, intervalMs);
    return () => { cancelled = true; clearInterval(id); };
  }, [intervalMs]);

  return stats;
}
