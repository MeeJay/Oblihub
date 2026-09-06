import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';
import { db } from '../db';
import { logger } from '../utils/logger';

/**
 * TrafficLogWorker — tails /var/log/nginx/oblihub_traffic.log, aggregates in-memory into
 * per-(proxy_host, minute) buckets, flushes to `proxy_traffic_1m` + top-K tables every 60s.
 *
 * Log line format (pipe-separated, defined in nginx.service.ts main config):
 *   $proxy_host_id|$msec|$status|$body_bytes_sent|$request_length|$request_time|
 *   $upstream_response_time|$remote_addr|$request_uri
 *
 * We keep 3 in-memory maps flushed atomically:
 *   - buckets[key] = 1-minute stat aggregation (counts, sums, max, unique IP set)
 *   - topIps[key][ip] = { count, bytesOut }  (bucketed at hour granularity for the top-IPs table)
 *   - topUris[key][uri] = { count, latencyMsSum }  (idem for top-URIs)
 *
 * On flush, we UPSERT the 1m row (increment counters) and UPSERT top-N entries per hour bucket.
 * "top" means top-K by request_count — we keep everything hot in memory during the hour and
 * emit only the top 20 IPs / URIs per host per hour at flush time.
 */

const LOG_PATH = path.join(config.stacksDir, '_proxy', 'oblihub_traffic.log');
// Alternate mount inside the container. If the primary path doesn't exist yet (fresh install),
// we fall back to the standard nginx location so the worker doesn't crash.
const ALT_LOG_PATH = '/var/log/nginx/oblihub_traffic.log';
const POLL_INTERVAL_MS = 1_000;
const FLUSH_INTERVAL_MS = 60_000;
const TOP_K = 20;

interface BucketStats {
  reqCount: number;
  bytesOut: number;
  bytesIn: number;
  status2xx: number;
  status3xx: number;
  status4xx: number;
  status5xx: number;
  latencyMsSum: number;
  latencyMsMax: number;
  uniqueIps: Set<string>;
}

interface TopStat {
  count: number;
  bytesOut: number;
  latencyMsSum: number;
}

const buckets = new Map<string, BucketStats>();    // key: `${hostId}|${minuteEpoch}`
const topIps = new Map<string, Map<string, TopStat>>();  // key: `${hostId}|${hourEpoch}`, inner key: ip
const topUris = new Map<string, Map<string, TopStat>>(); // key: `${hostId}|${hourEpoch}`, inner key: uri

let lastSize = 0;
let watching = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let activeLogPath: string | null = null;

function resolveLogPath(): string | null {
  for (const p of [LOG_PATH, ALT_LOG_PATH]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function bucketKey(hostId: number, tsMs: number, granularity: 'minute' | 'hour'): string {
  const align = granularity === 'minute' ? 60_000 : 3_600_000;
  const bucketTs = Math.floor(tsMs / align) * align;
  return `${hostId}|${bucketTs}`;
}

function getOrInitBucket(key: string): BucketStats {
  let b = buckets.get(key);
  if (!b) {
    b = {
      reqCount: 0, bytesOut: 0, bytesIn: 0,
      status2xx: 0, status3xx: 0, status4xx: 0, status5xx: 0,
      latencyMsSum: 0, latencyMsMax: 0,
      uniqueIps: new Set(),
    };
    buckets.set(key, b);
  }
  return b;
}

function bumpTop(map: Map<string, Map<string, TopStat>>, key: string, ident: string, bytesOut: number, latencyMs: number): void {
  let inner = map.get(key);
  if (!inner) { inner = new Map(); map.set(key, inner); }
  let s = inner.get(ident);
  if (!s) { s = { count: 0, bytesOut: 0, latencyMsSum: 0 }; inner.set(ident, s); }
  s.count++;
  s.bytesOut += bytesOut;
  s.latencyMsSum += latencyMs;
}

function processLine(line: string): void {
  if (!line || line[0] === '#') return;
  const parts = line.split('|');
  if (parts.length < 9) return;
  const hostId = parseInt(parts[0], 10);
  if (!hostId || isNaN(hostId)) return;
  // $msec = epoch-seconds.milliseconds
  const msec = parseFloat(parts[1]);
  const tsMs = isNaN(msec) ? Date.now() : Math.floor(msec * 1000);
  const status = parseInt(parts[2], 10) || 0;
  const bytesOut = parseInt(parts[3], 10) || 0;
  const bytesIn = parseInt(parts[4], 10) || 0;
  // $request_time is nginx-side time in seconds (e.g. "0.024"). Non-parseable = 0.
  const reqTimeSec = parseFloat(parts[5]);
  const latencyMs = isNaN(reqTimeSec) ? 0 : Math.round(reqTimeSec * 1000);
  const ip = parts[7] || '';
  const uri = (parts[8] || '').split('?')[0].slice(0, 512); // strip querystring, cap length

  const minKey = bucketKey(hostId, tsMs, 'minute');
  const hourKey = bucketKey(hostId, tsMs, 'hour');
  const b = getOrInitBucket(minKey);
  b.reqCount++;
  b.bytesOut += bytesOut;
  b.bytesIn += bytesIn;
  if (status >= 200 && status < 300) b.status2xx++;
  else if (status >= 300 && status < 400) b.status3xx++;
  else if (status >= 400 && status < 500) b.status4xx++;
  else if (status >= 500) b.status5xx++;
  b.latencyMsSum += latencyMs;
  if (latencyMs > b.latencyMsMax) b.latencyMsMax = latencyMs;
  if (ip) b.uniqueIps.add(ip);

  if (ip) bumpTop(topIps, hourKey, ip, bytesOut, latencyMs);
  if (uri) bumpTop(topUris, hourKey, uri, bytesOut, latencyMs);
}

async function pollFile(): Promise<void> {
  if (!activeLogPath) {
    activeLogPath = resolveLogPath();
    if (!activeLogPath) return; // nginx hasn't written yet — retry next tick
    try { lastSize = fs.statSync(activeLogPath).size; } catch { lastSize = 0; }
  }
  let stat: fs.Stats;
  try { stat = fs.statSync(activeLogPath); }
  catch { return; }
  if (stat.size === lastSize) return;
  if (stat.size < lastSize) { lastSize = 0; } // rotated / truncated
  const fd = fs.openSync(activeLogPath, 'r');
  try {
    const toRead = stat.size - lastSize;
    if (toRead > 0) {
      const buf = Buffer.alloc(toRead);
      fs.readSync(fd, buf, 0, toRead, lastSize);
      lastSize = stat.size;
      const text = buf.toString('utf8');
      for (const line of text.split('\n')) {
        if (line.trim()) processLine(line);
      }
    }
  } finally { fs.closeSync(fd); }
}

async function flushBuckets(): Promise<void> {
  if (buckets.size === 0 && topIps.size === 0 && topUris.size === 0) return;
  // Snapshot + swap so new events keep flowing during the flush.
  const bucketSnap = new Map(buckets);
  const ipsSnap = new Map(topIps);
  const urisSnap = new Map(topUris);
  buckets.clear();
  topIps.clear();
  topUris.clear();

  try {
    // Flush 1m stats
    for (const [key, b] of bucketSnap) {
      const [hostIdStr, tsStr] = key.split('|');
      const hostId = parseInt(hostIdStr, 10);
      const ts = new Date(parseInt(tsStr, 10));
      await db('proxy_traffic_1m')
        .insert({
          proxy_host_id: hostId, ts,
          req_count: b.reqCount, bytes_out: b.bytesOut, bytes_in: b.bytesIn,
          status_2xx: b.status2xx, status_3xx: b.status3xx, status_4xx: b.status4xx, status_5xx: b.status5xx,
          latency_ms_sum: b.latencyMsSum, latency_ms_max: b.latencyMsMax,
          unique_ips: b.uniqueIps.size,
        })
        .onConflict(['proxy_host_id', 'ts'])
        .merge({
          req_count: db.raw('proxy_traffic_1m.req_count + ?', [b.reqCount]),
          bytes_out: db.raw('proxy_traffic_1m.bytes_out + ?', [b.bytesOut]),
          bytes_in: db.raw('proxy_traffic_1m.bytes_in + ?', [b.bytesIn]),
          status_2xx: db.raw('proxy_traffic_1m.status_2xx + ?', [b.status2xx]),
          status_3xx: db.raw('proxy_traffic_1m.status_3xx + ?', [b.status3xx]),
          status_4xx: db.raw('proxy_traffic_1m.status_4xx + ?', [b.status4xx]),
          status_5xx: db.raw('proxy_traffic_1m.status_5xx + ?', [b.status5xx]),
          latency_ms_sum: db.raw('proxy_traffic_1m.latency_ms_sum + ?', [b.latencyMsSum]),
          latency_ms_max: db.raw('GREATEST(proxy_traffic_1m.latency_ms_max, ?)', [b.latencyMsMax]),
          unique_ips: db.raw('proxy_traffic_1m.unique_ips + ?', [b.uniqueIps.size]),
        });
    }

    // Flush top IPs — keep TOP_K per (host, hour)
    for (const [key, ipMap] of ipsSnap) {
      const [hostIdStr, tsStr] = key.split('|');
      const hostId = parseInt(hostIdStr, 10);
      const ts = new Date(parseInt(tsStr, 10));
      const sorted = [...ipMap.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, TOP_K);
      for (const [ip, s] of sorted) {
        await db('proxy_traffic_top_ips_1h')
          .insert({ proxy_host_id: hostId, ts, ip, req_count: s.count, bytes_out: s.bytesOut })
          .onConflict(['proxy_host_id', 'ts', 'ip'])
          .merge({
            req_count: db.raw('proxy_traffic_top_ips_1h.req_count + ?', [s.count]),
            bytes_out: db.raw('proxy_traffic_top_ips_1h.bytes_out + ?', [s.bytesOut]),
          });
      }
    }

    // Flush top URIs
    for (const [key, uriMap] of urisSnap) {
      const [hostIdStr, tsStr] = key.split('|');
      const hostId = parseInt(hostIdStr, 10);
      const ts = new Date(parseInt(tsStr, 10));
      const sorted = [...uriMap.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, TOP_K);
      for (const [uri, s] of sorted) {
        const avg = Math.round(s.latencyMsSum / Math.max(1, s.count));
        await db('proxy_traffic_top_uris_1h')
          .insert({ proxy_host_id: hostId, ts, uri, req_count: s.count, avg_latency_ms: avg })
          .onConflict(['proxy_host_id', 'ts', 'uri'])
          .merge({
            req_count: db.raw('proxy_traffic_top_uris_1h.req_count + ?', [s.count]),
            avg_latency_ms: db.raw('((proxy_traffic_top_uris_1h.avg_latency_ms * proxy_traffic_top_uris_1h.req_count) + ?) / (proxy_traffic_top_uris_1h.req_count + ?)', [s.latencyMsSum, s.count]),
          });
      }
    }
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'TrafficLogWorker flush failed');
  }
}

export function startTrafficLogWorker(): void {
  if (watching) return;
  watching = true;
  logger.info({ logPath: LOG_PATH }, 'Starting traffic log worker (1s poll, 60s flush)');
  pollTimer = setInterval(() => { pollFile().catch(err => logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'TrafficLogWorker poll failed')); }, POLL_INTERVAL_MS);
  flushTimer = setInterval(() => { flushBuckets().catch(err => logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'TrafficLogWorker flush failed')); }, FLUSH_INTERVAL_MS);
}

export function stopTrafficLogWorker(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  watching = false;
}
