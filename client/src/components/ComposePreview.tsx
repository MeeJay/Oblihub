import { useMemo } from 'react';
import yaml from 'js-yaml';
import { Box, Network, HardDrive, Database, Globe, Plug } from 'lucide-react';

interface ParsedService {
  name: string;
  image: string | null;
  build: string | null;
  ports: string[];
  volumes: string[];
  networks: string[];
  depends_on: string[];
  restart: string | null;
  environment: number;
}

interface ParsedCompose {
  services: ParsedService[];
  networks: { name: string; external: boolean; driver: string | null }[];
  volumes: { name: string; external: boolean; driver: string | null }[];
  error: string | null;
}

function parseCompose(content: string): ParsedCompose {
  const result: ParsedCompose = { services: [], networks: [], volumes: [], error: null };
  if (!content.trim()) return result;

  try {
    const doc = yaml.load(content) as Record<string, unknown>;
    if (!doc || typeof doc !== 'object') {
      result.error = 'Invalid YAML';
      return result;
    }

    // Services
    const services = (doc.services || {}) as Record<string, Record<string, unknown>>;
    for (const [name, svc] of Object.entries(services)) {
      if (!svc || typeof svc !== 'object') continue;

      const ports = Array.isArray(svc.ports)
        ? svc.ports.map((p: unknown) => String(p))
        : [];

      const volumes = Array.isArray(svc.volumes)
        ? svc.volumes.map((v: unknown) => typeof v === 'string' ? v : (v as { source?: string; target?: string })?.source ? `${(v as { source: string }).source}:${(v as { target: string }).target}` : String(v))
        : [];

      const networks = Array.isArray(svc.networks)
        ? svc.networks.map((n: unknown) => String(n))
        : typeof svc.networks === 'object' && svc.networks
          ? Object.keys(svc.networks as Record<string, unknown>)
          : [];

      const depends = Array.isArray(svc.depends_on)
        ? svc.depends_on.map((d: unknown) => String(d))
        : typeof svc.depends_on === 'object' && svc.depends_on
          ? Object.keys(svc.depends_on as Record<string, unknown>)
          : [];

      const envCount = Array.isArray(svc.environment)
        ? svc.environment.length
        : typeof svc.environment === 'object' && svc.environment
          ? Object.keys(svc.environment as Record<string, unknown>).length
          : 0;

      result.services.push({
        name,
        image: typeof svc.image === 'string' ? svc.image : null,
        build: svc.build ? (typeof svc.build === 'string' ? svc.build : 'custom') : null,
        ports,
        volumes,
        networks,
        depends_on: depends,
        restart: typeof svc.restart === 'string' ? svc.restart : null,
        environment: envCount,
      });
    }

    // Networks
    const nets = (doc.networks || {}) as Record<string, Record<string, unknown> | null>;
    for (const [name, cfg] of Object.entries(nets)) {
      result.networks.push({
        name,
        external: !!(cfg?.external),
        driver: typeof cfg?.driver === 'string' ? cfg.driver : null,
      });
    }

    // Volumes
    const vols = (doc.volumes || {}) as Record<string, Record<string, unknown> | null>;
    for (const [name, cfg] of Object.entries(vols)) {
      result.volumes.push({
        name,
        external: !!(cfg?.external),
        driver: typeof cfg?.driver === 'string' ? cfg.driver : null,
      });
    }
  } catch (e) {
    result.error = e instanceof Error ? e.message : 'Parse error';
  }

  return result;
}

interface Props {
  composeContent: string;
}

export function ComposePreview({ composeContent }: Props) {
  const parsed = useMemo(() => parseCompose(composeContent), [composeContent]);

  if (parsed.error) {
    return (
      <div className="text-xs text-status-down p-2 bg-status-down/5 rounded">
        YAML error: {parsed.error}
      </div>
    );
  }

  if (parsed.services.length === 0) {
    return <div className="text-xs text-text-muted p-2">No services defined</div>;
  }

  return (
    <div className="space-y-3">
      {/* Services */}
      <div>
        <div className="text-[10px] font-semibold text-text-muted uppercase tracking-wider mb-1.5 flex items-center gap-1">
          <Box size={10} /> Services ({parsed.services.length})
        </div>
        <div className="space-y-2">
          {parsed.services.map((svc) => (
            <div key={svc.name} className="rounded-lg border border-border bg-bg-tertiary p-2.5">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs font-semibold text-text-primary">{svc.name}</span>
                {svc.restart && <span className="text-[9px] px-1 py-0.5 rounded bg-bg-secondary text-text-muted">{svc.restart}</span>}
              </div>
              {svc.image && (
                <div className="flex items-center gap-1 text-[10px] text-accent font-mono mb-1">
                  <HardDrive size={9} /> {svc.image}
                </div>
              )}
              {svc.build && (
                <div className="flex items-center gap-1 text-[10px] text-status-pending font-mono mb-1">
                  <Box size={9} /> build: {svc.build}
                </div>
              )}
              {svc.ports.length > 0 && (
                <div className="flex items-center gap-1 text-[10px] text-text-muted mb-0.5">
                  <Globe size={9} />
                  {svc.ports.map((p, i) => <span key={i} className="font-mono bg-bg-secondary px-1 rounded">{p}</span>)}
                </div>
              )}
              {svc.volumes.length > 0 && (
                <div className="flex items-center gap-1 text-[10px] text-text-muted mb-0.5 flex-wrap">
                  <Database size={9} className="shrink-0" />
                  {svc.volumes.map((v, i) => <span key={i} className="font-mono bg-bg-secondary px-1 rounded truncate max-w-[180px]" title={v}>{v}</span>)}
                </div>
              )}
              {svc.networks.length > 0 && (
                <div className="flex items-center gap-1 text-[10px] text-text-muted mb-0.5">
                  <Network size={9} />
                  {svc.networks.map((n, i) => <span key={i} className="font-mono bg-bg-secondary px-1 rounded">{n}</span>)}
                </div>
              )}
              {svc.depends_on.length > 0 && (
                <div className="flex items-center gap-1 text-[10px] text-text-muted">
                  <Plug size={9} />
                  {svc.depends_on.map((d, i) => <span key={i} className="font-mono">{d}</span>)}
                </div>
              )}
              {svc.environment > 0 && (
                <div className="text-[10px] text-text-muted">{svc.environment} env var{svc.environment > 1 ? 's' : ''}</div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Networks */}
      {parsed.networks.length > 0 && (
        <div>
          <div className="text-[10px] font-semibold text-text-muted uppercase tracking-wider mb-1 flex items-center gap-1">
            <Network size={10} /> Networks ({parsed.networks.length})
          </div>
          <div className="space-y-1">
            {parsed.networks.map((n) => (
              <div key={n.name} className="flex items-center gap-2 text-[10px] px-2 py-1 rounded border border-border bg-bg-tertiary">
                <span className="font-mono text-text-primary">{n.name}</span>
                {n.external && <span className="px-1 py-0.5 rounded bg-status-pending/10 text-status-pending text-[9px]">external</span>}
                {n.driver && <span className="text-text-muted">{n.driver}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Volumes */}
      {parsed.volumes.length > 0 && (
        <div>
          <div className="text-[10px] font-semibold text-text-muted uppercase tracking-wider mb-1 flex items-center gap-1">
            <Database size={10} /> Volumes ({parsed.volumes.length})
          </div>
          <div className="space-y-1">
            {parsed.volumes.map((v) => (
              <div key={v.name} className="flex items-center gap-2 text-[10px] px-2 py-1 rounded border border-border bg-bg-tertiary">
                <span className="font-mono text-text-primary">{v.name}</span>
                {v.external && <span className="px-1 py-0.5 rounded bg-status-pending/10 text-status-pending text-[9px]">external</span>}
                {v.driver && <span className="text-text-muted">{v.driver}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
