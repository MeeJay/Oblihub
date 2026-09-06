import { useEffect, useMemo, useState } from 'react';
import { Activity, TrendingUp, AlertTriangle, Globe, RefreshCw } from 'lucide-react';
import { LineChart, formatBytes, formatShortNumber } from '@/components/LineChart';
import { Sparkline } from '@/components/Sparkline';
import { trafficApi, type TrafficRange, type TrafficPoint, type TopIp, type TopUri, type HostSummary, type GeoCountry, type TrafficSeries } from '@/api/traffic.api';
import { proxyApi } from '@/api/proxy.api';
import type { ProxyHost } from '@oblihub/shared';

const RANGES: { key: TrafficRange; label: string }[] = [
  { key: '1h', label: '1h' },
  { key: '6h', label: '6h' },
  { key: '24h', label: '24h' },
  { key: '7d', label: '7d' },
  { key: '30d', label: '30d' },
  { key: '90d', label: '90d' },
];

/**
 * Global Traffic dashboard. Shows the cumul across every proxy host the user can see + a
 * per-host summary + a geographic distribution. Deliberately dense — the user asked for
 * "en foutre plein les yeux".
 *
 * Per-host drill-down happens through the "View" link on each row → opens the per-host tab.
 */
export function TrafficPage() {
  const [range, setRange] = useState<TrafficRange>('24h');
  const [series, setSeries] = useState<TrafficSeries | null>(null);
  const [hosts, setHosts] = useState<ProxyHost[]>([]);
  const [summary, setSummary] = useState<HostSummary[]>([]);
  const [geo, setGeo] = useState<GeoCountry[]>([]);
  const [selectedHostId, setSelectedHostId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const [s, sm, g, h] = await Promise.all([
        trafficApi.teamCumul(range),
        trafficApi.summary(),
        trafficApi.geo(range),
        proxyApi.listHosts().catch(() => []),
      ]);
      setSeries(s); setSummary(sm); setGeo(g); setHosts(h);
    } catch { /* silent — page shows empty state */ }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [range]);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-text-primary flex items-center gap-2">
          <Activity size={20} /> Traffic
        </h1>
        <div className="flex items-center gap-2">
          <RangeSwitcher range={range} onChange={setRange} />
          <button onClick={load} className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover">
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
        </div>
      ) : (
        <>
          <StatCards series={series} />
          <CumulChart series={series} />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <HostsTable summary={summary} onSelect={setSelectedHostId} />
            <GeoWidget geo={geo} />
          </div>
          {selectedHostId != null && (
            <HostDrilldown
              host={hosts.find(h => h.id === selectedHostId) || null}
              range={range}
              onClose={() => setSelectedHostId(null)}
            />
          )}
        </>
      )}
    </div>
  );
}

function RangeSwitcher({ range, onChange }: { range: TrafficRange; onChange: (r: TrafficRange) => void }) {
  return (
    <div className="flex gap-0.5 rounded-lg border border-border bg-bg-tertiary p-0.5">
      {RANGES.map(r => (
        <button
          key={r.key}
          onClick={() => onChange(r.key)}
          className={`px-2.5 py-1 text-xs rounded ${range === r.key ? 'bg-accent text-white' : 'text-text-muted hover:text-text-primary'}`}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

function StatCards({ series }: { series: TrafficSeries | null }) {
  const stats = useMemo(() => {
    const points = series?.points || [];
    const total = points.reduce((acc, p) => ({
      req: acc.req + p.reqCount,
      out: acc.out + p.bytesOut,
      errs: acc.errs + p.status4xx + p.status5xx,
      latSum: acc.latSum + p.avgLatencyMs * p.reqCount,
      latN: acc.latN + p.reqCount,
    }), { req: 0, out: 0, errs: 0, latSum: 0, latN: 0 });
    return {
      reqCount: total.req,
      bytesOut: total.out,
      errRate: total.req ? total.errs / total.req : 0,
      avgLatency: total.latN ? Math.round(total.latSum / total.latN) : 0,
      reqSpark: points.map(p => p.reqCount),
      bwSpark: points.map(p => p.bytesOut),
      errSpark: points.map(p => p.reqCount ? (p.status4xx + p.status5xx) / p.reqCount * 100 : 0),
      latSpark: points.map(p => p.avgLatencyMs),
    };
  }, [series]);
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      <StatCard label="Requests" value={formatShortNumber(stats.reqCount)} icon={TrendingUp} spark={stats.reqSpark} color="#4a9eff" />
      <StatCard label="Bandwidth" value={formatBytes(stats.bytesOut)} icon={Activity} spark={stats.bwSpark} color="#22c55e" />
      <StatCard label="Error rate" value={`${(stats.errRate * 100).toFixed(2)}%`} icon={AlertTriangle} spark={stats.errSpark} color="#ef4444" />
      <StatCard label="Avg latency" value={`${stats.avgLatency}ms`} icon={Activity} spark={stats.latSpark} color="#f59e0b" />
    </div>
  );
}

function StatCard({ label, value, icon: Icon, spark, color }: { label: string; value: string; icon: typeof TrendingUp; spark: number[]; color: string }) {
  return (
    <div className="rounded-xl border border-border bg-bg-secondary p-4">
      <div className="flex items-center gap-2 text-xs text-text-muted mb-1">
        <Icon size={12} /> {label}
      </div>
      <div className="text-2xl font-semibold text-text-primary mb-2 font-mono">{value}</div>
      {spark.length >= 2 && <Sparkline data={spark} width={180} height={30} color={color} />}
    </div>
  );
}

function CumulChart({ series }: { series: TrafficSeries | null }) {
  const points = series?.points || [];
  const labels = points.map(p => new Date(p.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  return (
    <div>
      <h2 className="text-sm font-medium text-text-primary mb-2">Requests over time</h2>
      <LineChart
        labels={labels}
        series={[
          { name: '2xx', color: '#22c55e', values: points.map(p => p.status2xx) },
          { name: '3xx', color: '#4a9eff', values: points.map(p => p.status3xx) },
          { name: '4xx', color: '#f59e0b', values: points.map(p => p.status4xx) },
          { name: '5xx', color: '#ef4444', values: points.map(p => p.status5xx) },
        ]}
        yLabel="req / bucket"
      />
      <h2 className="text-sm font-medium text-text-primary mt-4 mb-2">Bandwidth &amp; latency</h2>
      <LineChart
        labels={labels}
        series={[
          { name: 'Bytes out', color: '#22c55e', values: points.map(p => p.bytesOut), format: formatBytes },
          { name: 'Avg latency (ms)', color: '#f59e0b', values: points.map(p => p.avgLatencyMs) },
        ]}
        yLabel="bytes / ms"
      />
    </div>
  );
}

function HostsTable({ summary, onSelect }: { summary: HostSummary[]; onSelect: (id: number) => void }) {
  const maxReq = Math.max(1, ...summary.map(s => s.reqCount));
  return (
    <div className="rounded-xl border border-border bg-bg-secondary p-4">
      <h2 className="text-sm font-medium text-text-primary mb-3 flex items-center gap-2">
        <TrendingUp size={14} /> Top proxy hosts (24h)
      </h2>
      {summary.length === 0 ? (
        <div className="text-xs text-text-muted text-center py-8">No data yet</div>
      ) : (
        <div className="space-y-1.5 max-h-96 overflow-auto">
          {summary.map(s => (
            <button
              key={s.proxyHostId}
              onClick={() => onSelect(s.proxyHostId)}
              className="w-full text-left flex items-center gap-3 p-2 rounded hover:bg-bg-tertiary text-xs"
            >
              <div className="flex-1 min-w-0">
                <div className="font-mono text-text-primary truncate">{s.domain}</div>
                <div className="mt-1 h-1.5 rounded-full bg-bg-tertiary overflow-hidden">
                  <div className="h-full bg-accent" style={{ width: `${(s.reqCount / maxReq) * 100}%` }} />
                </div>
              </div>
              <div className="text-right shrink-0 min-w-[80px]">
                <div className="font-mono text-text-primary">{formatShortNumber(s.reqCount)}</div>
                <div className="text-[10px] text-text-muted">{formatBytes(s.bytesOut)}</div>
              </div>
              {s.errorCount > 0 && (
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-status-down/10 text-status-down">
                  {formatShortNumber(s.errorCount)} err
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function GeoWidget({ geo }: { geo: GeoCountry[] }) {
  const total = geo.reduce((a, g) => a + g.reqCount, 0) || 1;
  return (
    <div className="rounded-xl border border-border bg-bg-secondary p-4">
      <h2 className="text-sm font-medium text-text-primary mb-3 flex items-center gap-2">
        <Globe size={14} /> Requests by country
      </h2>
      {geo.length === 0 ? (
        <div className="text-xs text-text-muted text-center py-8">No geo data yet — either no traffic in this range or all IPs are private/local.</div>
      ) : (
        <div className="space-y-1.5 max-h-96 overflow-auto">
          {geo.map(g => (
            <div key={g.code} className="flex items-center gap-3 p-2 rounded hover:bg-bg-tertiary text-xs">
              <span className="text-lg">{countryFlag(g.code)}</span>
              <div className="flex-1 min-w-0">
                <div className="text-text-primary">{g.name}</div>
                <div className="mt-1 h-1.5 rounded-full bg-bg-tertiary overflow-hidden">
                  <div className="h-full bg-accent" style={{ width: `${(g.reqCount / total) * 100}%` }} />
                </div>
              </div>
              <div className="text-right shrink-0 min-w-[70px]">
                <div className="font-mono text-text-primary">{formatShortNumber(g.reqCount)}</div>
                <div className="text-[10px] text-text-muted">{((g.reqCount / total) * 100).toFixed(1)}%</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function HostDrilldown({ host, range, onClose }: { host: ProxyHost | null; range: TrafficRange; onClose: () => void }) {
  const [ips, setIps] = useState<TopIp[]>([]);
  const [uris, setUris] = useState<TopUri[]>([]);
  const [series, setSeries] = useState<TrafficSeries | null>(null);

  useEffect(() => {
    if (!host) return;
    (async () => {
      const [i, u, s] = await Promise.all([
        trafficApi.hostTopIps(host.id, range).catch(() => []),
        trafficApi.hostTopUris(host.id, range).catch(() => []),
        trafficApi.hostTimeSeries(host.id, range).catch(() => null),
      ]);
      setIps(i); setUris(u); setSeries(s);
    })();
  }, [host, range]);

  if (!host) return null;
  const points = series?.points || [];
  const labels = points.map(p => new Date(p.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-10 bg-black/50" onClick={onClose}>
      <div className="rounded-xl border border-border bg-bg-primary w-full max-w-5xl max-h-[90vh] overflow-auto shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-border flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text-primary">{host.domainNames[0]}</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary">&times;</button>
        </div>
        <div className="p-6 space-y-6">
          <LineChart labels={labels}
            series={[
              { name: 'Requests', color: '#4a9eff', values: points.map(p => p.reqCount) },
              { name: 'Bytes out', color: '#22c55e', values: points.map(p => p.bytesOut), format: formatBytes },
              { name: 'Avg latency (ms)', color: '#f59e0b', values: points.map(p => p.avgLatencyMs) },
            ]}
          />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div>
              <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">Top IPs</h3>
              <div className="space-y-1 max-h-72 overflow-auto">
                {ips.map(ip => (
                  <div key={ip.ip} className="flex items-center gap-3 text-xs p-2 rounded hover:bg-bg-tertiary">
                    {ip.geo && <span>{countryFlag(ip.geo.countryCode || '')}</span>}
                    <div className="flex-1 min-w-0">
                      <div className="font-mono text-text-primary truncate">{ip.ip}</div>
                      {ip.geo && (
                        <div className="text-[10px] text-text-muted truncate">{[ip.geo.city, ip.geo.countryName, ip.geo.org].filter(Boolean).join(' · ')}</div>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-mono text-text-primary">{formatShortNumber(ip.reqCount)}</div>
                      <div className="text-[10px] text-text-muted">{formatBytes(ip.bytesOut)}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">Top URIs</h3>
              <div className="space-y-1 max-h-72 overflow-auto">
                {uris.map(u => (
                  <div key={u.uri} className="flex items-center gap-3 text-xs p-2 rounded hover:bg-bg-tertiary">
                    <div className="flex-1 min-w-0">
                      <div className="font-mono text-text-primary truncate">{u.uri}</div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-mono text-text-primary">{formatShortNumber(u.reqCount)}</div>
                      <div className="text-[10px] text-text-muted">{u.avgLatencyMs}ms</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Country code → emoji flag. Wraps each ASCII letter into its regional indicator (U+1F1E6-1F1FF)
 * pair; browsers with color-emoji fonts render the flag. Falls back to a neutral placeholder
 * for empty / invalid inputs.
 */
function countryFlag(code: string): string {
  if (!code || code.length !== 2) return '🏳️';
  const A = 0x1F1E6;
  return String.fromCodePoint(A + (code.charCodeAt(0) - 65), A + (code.charCodeAt(1) - 65));
}
