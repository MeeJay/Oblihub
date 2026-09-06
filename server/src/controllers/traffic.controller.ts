import type { Request, Response, NextFunction } from 'express';
import { db } from '../db';
import { geoipService } from '../services/geoip.service';
import { AppError } from '../middleware/errorHandler';

/**
 * Traffic controller. Every read is scoped to the caller's visibility (own teams + global) —
 * a user in team "Alpha" only sees the traffic for the proxy_hosts stacked to team "Alpha".
 * Admins see everything.
 *
 * Time-range convention: `range` query param is one of `1h | 6h | 24h | 7d | 30d | 90d`. Any
 * range up to 7d reads from `proxy_traffic_1m`, wider ranges read from `proxy_traffic_1h`
 * (downsampled hourly rollup).
 *
 * All time series responses are pre-bucketed on the SERVER side (no aggregation in the client),
 * so charts just plot the array directly.
 */

interface RangeSpec { fromMs: number; bucket: 'minute' | 'hour' }

function parseRange(raw: string | undefined): RangeSpec {
  const now = Date.now();
  switch (raw) {
    case '1h':  return { fromMs: now - 60 * 60 * 1000,             bucket: 'minute' };
    case '6h':  return { fromMs: now - 6 * 60 * 60 * 1000,         bucket: 'minute' };
    case '24h': return { fromMs: now - 24 * 60 * 60 * 1000,        bucket: 'minute' };
    case '7d':  return { fromMs: now - 7 * 24 * 60 * 60 * 1000,    bucket: 'minute' };
    case '30d': return { fromMs: now - 30 * 24 * 60 * 60 * 1000,   bucket: 'hour' };
    case '90d': return { fromMs: now - 90 * 24 * 60 * 60 * 1000,   bucket: 'hour' };
    default:    return { fromMs: now - 24 * 60 * 60 * 1000,        bucket: 'minute' };
  }
}

async function visibleHostIdsForUser(req: Request): Promise<number[]> {
  const user = (req as unknown as { user?: { id: number; role?: string } }).user;
  if (!user) throw new AppError(401, 'Not authenticated');
  if (user.role === 'admin') {
    const rows = await db('proxy_hosts').select('id');
    return rows.map(r => r.id as number);
  }
  const teamIds = (await db('team_members').where({ user_id: user.id }).pluck('team_id')) as number[];
  if (teamIds.length === 0) return [];
  // proxy_hosts.stack_id → stacks.team_id.
  // A proxy_host without a stack_id is considered orphan; only admin sees those.
  const rows = await db('proxy_hosts')
    .join('stacks', 'proxy_hosts.stack_id', 'stacks.id')
    .whereIn('stacks.team_id', teamIds)
    .select('proxy_hosts.id');
  return rows.map(r => r.id as number);
}

async function assertHostVisible(req: Request, hostId: number): Promise<void> {
  const visible = await visibleHostIdsForUser(req);
  if (!visible.includes(hostId)) throw new AppError(403, 'Not authorized for this proxy host');
}

// ── /traffic/proxy-host/:id ──

export const trafficController = {
  /** Time-series (req_count, bytes, latency, error rate) for one proxy_host. */
  async hostTimeSeries(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      await assertHostVisible(req, id);
      const { fromMs, bucket } = parseRange(req.query.range as string);
      const table = bucket === 'minute' ? 'proxy_traffic_1m' : 'proxy_traffic_1h';
      const rows = await db(table)
        .where({ proxy_host_id: id })
        .where('ts', '>=', new Date(fromMs))
        .orderBy('ts')
        .select('ts', 'req_count', 'bytes_out', 'bytes_in',
                'status_2xx', 'status_3xx', 'status_4xx', 'status_5xx',
                'latency_ms_sum', 'latency_ms_max', 'unique_ips');
      const points = rows.map(r => ({
        ts: (r.ts as Date).toISOString(),
        reqCount: Number(r.req_count) || 0,
        bytesOut: Number(r.bytes_out) || 0,
        bytesIn: Number(r.bytes_in) || 0,
        status2xx: Number(r.status_2xx) || 0,
        status3xx: Number(r.status_3xx) || 0,
        status4xx: Number(r.status_4xx) || 0,
        status5xx: Number(r.status_5xx) || 0,
        // Emit average latency (sum/count) — max is already there for the p95 approximation.
        avgLatencyMs: r.req_count ? Math.round(Number(r.latency_ms_sum) / Number(r.req_count)) : 0,
        maxLatencyMs: Number(r.latency_ms_max) || 0,
        uniqueIps: Number(r.unique_ips) || 0,
      }));
      res.json({ success: true, data: { bucket, points } });
    } catch (err) { next(err); }
  },

  /** Top IPs for one proxy_host over the range, aggregated. */
  async hostTopIps(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      await assertHostVisible(req, id);
      const { fromMs } = parseRange(req.query.range as string);
      const rows = await db('proxy_traffic_top_ips_1h')
        .where({ proxy_host_id: id })
        .where('ts', '>=', new Date(fromMs))
        .select('ip', db.raw('SUM(req_count)::bigint AS req_count'), db.raw('SUM(bytes_out)::bigint AS bytes_out'))
        .groupBy('ip')
        .orderBy('req_count', 'desc')
        .limit(50);
      // Enrich with geo — dedup, single service call, small round-trips.
      const geoMap = await geoipService.lookupMany(rows.map(r => r.ip as string));
      const enriched = rows.map(r => ({
        ip: r.ip as string,
        reqCount: Number(r.req_count) || 0,
        bytesOut: Number(r.bytes_out) || 0,
        geo: geoMap.get(r.ip as string) || null,
      }));
      res.json({ success: true, data: enriched });
    } catch (err) { next(err); }
  },

  /** Top URIs for one proxy_host over the range. */
  async hostTopUris(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      await assertHostVisible(req, id);
      const { fromMs } = parseRange(req.query.range as string);
      const rows = await db('proxy_traffic_top_uris_1h')
        .where({ proxy_host_id: id })
        .where('ts', '>=', new Date(fromMs))
        .select('uri',
          db.raw('SUM(req_count)::bigint AS req_count'),
          db.raw('SUM(req_count * avg_latency_ms) / GREATEST(1, SUM(req_count)) AS avg_latency_ms'))
        .groupBy('uri')
        .orderBy('req_count', 'desc')
        .limit(50);
      res.json({ success: true, data: rows.map(r => ({
        uri: r.uri as string,
        reqCount: Number(r.req_count) || 0,
        avgLatencyMs: Math.round(Number(r.avg_latency_ms) || 0),
      })) });
    } catch (err) { next(err); }
  },

  /**
   * Team cumul — same time-series shape as hostTimeSeries but summed across every proxy_host
   * the caller can see (own teams for regular users, everything for admins). Used by the global
   * Traffic dashboard.
   */
  async teamCumul(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const visible = await visibleHostIdsForUser(req);
      const { fromMs, bucket } = parseRange(req.query.range as string);
      if (visible.length === 0) { res.json({ success: true, data: { bucket, points: [] } }); return; }
      const table = bucket === 'minute' ? 'proxy_traffic_1m' : 'proxy_traffic_1h';
      const rows = await db(table)
        .whereIn('proxy_host_id', visible)
        .where('ts', '>=', new Date(fromMs))
        .select('ts',
          db.raw('SUM(req_count)::bigint AS req_count'),
          db.raw('SUM(bytes_out)::bigint AS bytes_out'),
          db.raw('SUM(bytes_in)::bigint AS bytes_in'),
          db.raw('SUM(status_2xx)::bigint AS status_2xx'),
          db.raw('SUM(status_3xx)::bigint AS status_3xx'),
          db.raw('SUM(status_4xx)::bigint AS status_4xx'),
          db.raw('SUM(status_5xx)::bigint AS status_5xx'),
          db.raw('SUM(latency_ms_sum)::bigint AS latency_ms_sum'),
          db.raw('MAX(latency_ms_max)::bigint AS latency_ms_max'),
          db.raw('SUM(unique_ips)::bigint AS unique_ips'))
        .groupBy('ts')
        .orderBy('ts');
      const points = rows.map(r => ({
        ts: (r.ts as Date).toISOString(),
        reqCount: Number(r.req_count) || 0,
        bytesOut: Number(r.bytes_out) || 0,
        bytesIn: Number(r.bytes_in) || 0,
        status2xx: Number(r.status_2xx) || 0,
        status3xx: Number(r.status_3xx) || 0,
        status4xx: Number(r.status_4xx) || 0,
        status5xx: Number(r.status_5xx) || 0,
        avgLatencyMs: r.req_count ? Math.round(Number(r.latency_ms_sum) / Number(r.req_count)) : 0,
        maxLatencyMs: Number(r.latency_ms_max) || 0,
        uniqueIps: Number(r.unique_ips) || 0,
      }));
      res.json({ success: true, data: { bucket, points } });
    } catch (err) { next(err); }
  },

  /**
   * Per-host summary card data for the global dashboard: last-24h stats for every visible host,
   * used for the "Top hosts" table + geo widget input.
   */
  async hostsSummary(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const visible = await visibleHostIdsForUser(req);
      if (visible.length === 0) { res.json({ success: true, data: [] }); return; }
      const from = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const rows = await db('proxy_traffic_1m')
        .join('proxy_hosts', 'proxy_traffic_1m.proxy_host_id', 'proxy_hosts.id')
        .whereIn('proxy_host_id', visible)
        .where('ts', '>=', from)
        .select('proxy_host_id',
          db.raw('MIN(proxy_hosts.domain_names) AS domain_names'),
          db.raw('SUM(req_count)::bigint AS req_count'),
          db.raw('SUM(bytes_out)::bigint AS bytes_out'),
          db.raw('SUM(status_4xx + status_5xx)::bigint AS error_count'))
        .groupBy('proxy_host_id')
        .orderBy('req_count', 'desc');
      res.json({ success: true, data: rows.map(r => ({
        proxyHostId: Number(r.proxy_host_id),
        domain: Array.isArray(r.domain_names) ? (r.domain_names[0] as string) : String(r.domain_names || '').split(',')[0],
        reqCount: Number(r.req_count) || 0,
        bytesOut: Number(r.bytes_out) || 0,
        errorCount: Number(r.error_count) || 0,
      })) });
    } catch (err) { next(err); }
  },

  /**
   * Aggregated geo points for the visible scope — one row per unique country over the range,
   * with total request count. Fed into the worldmap widget.
   */
  async geoAggregated(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const visible = await visibleHostIdsForUser(req);
      if (visible.length === 0) { res.json({ success: true, data: [] }); return; }
      const { fromMs } = parseRange(req.query.range as string);
      const rows = await db('proxy_traffic_top_ips_1h')
        .whereIn('proxy_host_id', visible)
        .where('ts', '>=', new Date(fromMs))
        .select('ip', db.raw('SUM(req_count)::bigint AS req_count'))
        .groupBy('ip')
        .orderBy('req_count', 'desc')
        .limit(500);
      const geoMap = await geoipService.lookupMany(rows.map(r => r.ip as string));
      // Aggregate by country_code.
      const byCountry = new Map<string, { code: string; name: string; reqCount: number; lat: number; lon: number; sampleIps: number }>();
      for (const r of rows) {
        const geo = geoMap.get(r.ip as string);
        if (!geo || !geo.countryCode) continue;
        const existing = byCountry.get(geo.countryCode);
        if (existing) {
          existing.reqCount += Number(r.req_count) || 0;
          existing.sampleIps++;
        } else {
          byCountry.set(geo.countryCode, {
            code: geo.countryCode,
            name: geo.countryName || geo.countryCode,
            reqCount: Number(r.req_count) || 0,
            lat: geo.latitude || 0,
            lon: geo.longitude || 0,
            sampleIps: 1,
          });
        }
      }
      res.json({ success: true, data: [...byCountry.values()].sort((a, b) => b.reqCount - a.reqCount) });
    } catch (err) { next(err); }
  },
};
