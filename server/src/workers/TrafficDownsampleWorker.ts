import { db } from '../db';
import { logger } from '../utils/logger';

/**
 * Downsample + retention worker for traffic time-series.
 *
 * Cadence: hourly. Runs on start once (in case the app was stopped for a while) then every hour.
 *
 * Policy:
 *   - Rows in `proxy_traffic_1m` older than 7 days are rolled into `proxy_traffic_1h` (SUM of
 *     counters, MAX of latency_ms_max, SUM of unique_ips as an approximation — good enough for
 *     dashboard rendering, we're not trying to reconstruct exact percentiles).
 *   - After the roll succeeds, source 1m rows are deleted.
 *   - `proxy_traffic_1h` rows older than 90 days are dropped.
 *   - `proxy_traffic_top_ips_1h` / `_uris_1h` rows older than 90 days are dropped (no downsample,
 *     they're already at hour granularity).
 *
 * Idempotent: re-runs on the same window are safe thanks to the UNIQUE constraint on
 * (proxy_host_id, ts) — the INSERT ... ON CONFLICT merges instead of duplicating.
 */

const RUN_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const MS_1M_RETENTION = 7 * 24 * 60 * 60 * 1000;
const MS_1H_RETENTION = 90 * 24 * 60 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;

async function sweep(): Promise<void> {
  const cutoff1m = new Date(Date.now() - MS_1M_RETENTION);
  const cutoff1h = new Date(Date.now() - MS_1H_RETENTION);

  try {
    // (1) Downsample 1m → 1h: aggregate everything below the cutoff into hour-aligned rows.
    // GROUP BY (proxy_host_id, date_trunc('hour', ts)) — postgres native, no client-side loop.
    const rolled = await db.raw(`
      INSERT INTO proxy_traffic_1h
        (proxy_host_id, ts, req_count, bytes_out, bytes_in,
         status_2xx, status_3xx, status_4xx, status_5xx,
         latency_ms_sum, latency_ms_max, unique_ips)
      SELECT
        proxy_host_id,
        date_trunc('hour', ts) AS ts_h,
        SUM(req_count), SUM(bytes_out), SUM(bytes_in),
        SUM(status_2xx), SUM(status_3xx), SUM(status_4xx), SUM(status_5xx),
        SUM(latency_ms_sum), MAX(latency_ms_max),
        SUM(unique_ips)
      FROM proxy_traffic_1m
      WHERE ts < ?
      GROUP BY proxy_host_id, date_trunc('hour', ts)
      ON CONFLICT (proxy_host_id, ts) DO UPDATE SET
        req_count      = proxy_traffic_1h.req_count      + EXCLUDED.req_count,
        bytes_out      = proxy_traffic_1h.bytes_out      + EXCLUDED.bytes_out,
        bytes_in       = proxy_traffic_1h.bytes_in       + EXCLUDED.bytes_in,
        status_2xx     = proxy_traffic_1h.status_2xx     + EXCLUDED.status_2xx,
        status_3xx     = proxy_traffic_1h.status_3xx     + EXCLUDED.status_3xx,
        status_4xx     = proxy_traffic_1h.status_4xx     + EXCLUDED.status_4xx,
        status_5xx     = proxy_traffic_1h.status_5xx     + EXCLUDED.status_5xx,
        latency_ms_sum = proxy_traffic_1h.latency_ms_sum + EXCLUDED.latency_ms_sum,
        latency_ms_max = GREATEST(proxy_traffic_1h.latency_ms_max, EXCLUDED.latency_ms_max),
        unique_ips     = proxy_traffic_1h.unique_ips     + EXCLUDED.unique_ips
      RETURNING id
    `, [cutoff1m]);

    // (2) Drop the source 1m rows we just rolled up.
    const deleted1m = await db('proxy_traffic_1m').where('ts', '<', cutoff1m).delete();

    // (3) Drop 1h rows past the long retention.
    const deleted1h = await db('proxy_traffic_1h').where('ts', '<', cutoff1h).delete();
    const deletedIps = await db('proxy_traffic_top_ips_1h').where('ts', '<', cutoff1h).delete();
    const deletedUris = await db('proxy_traffic_top_uris_1h').where('ts', '<', cutoff1h).delete();

    logger.info({
      rolled: (rolled as { rowCount: number }).rowCount ?? 0,
      deleted1m, deleted1h, deletedIps, deletedUris,
    }, 'Traffic downsample sweep done');
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Traffic downsample sweep failed');
  }
}

export function startTrafficDownsampleWorker(): void {
  if (timer) return;
  logger.info('Starting traffic downsample worker (hourly)');
  // First run soon after boot so an install that was down for hours catches up quickly.
  setTimeout(() => sweep().catch(() => {}), 30_000);
  timer = setInterval(() => sweep().catch(() => {}), RUN_INTERVAL_MS);
}

export function stopTrafficDownsampleWorker(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
