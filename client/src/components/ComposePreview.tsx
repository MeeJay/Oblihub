import { useMemo } from 'react';
import yaml from 'js-yaml';
import { Box, Network, HardDrive, Database, Globe, Plug, X } from 'lucide-react';

interface ParsedPort {
  /** Original string as written in compose (may contain ${VAR} refs) */
  raw: string;
  /** Env-substituted display form */
  resolved: string;
}

interface ParsedService {
  name: string;
  image: string | null;
  build: string | null;
  ports: ParsedPort[];
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

// Docker-compose style env substitution: ${VAR}, ${VAR:-default}, ${VAR-default}, $VAR
function substituteEnv(str: string, env: Record<string, string>): string {
  return str
    .replace(/\$\{([A-Z_][A-Z0-9_]*):-([^}]*)\}/gi, (_, name, dflt) => {
      const v = env[name];
      return v !== undefined && v !== '' ? v : dflt;
    })
    .replace(/\$\{([A-Z_][A-Z0-9_]*)-([^}]*)\}/gi, (_, name, dflt) => {
      const v = env[name];
      return v !== undefined ? v : dflt;
    })
    .replace(/\$\{([A-Z_][A-Z0-9_]*)\}/gi, (_, name) => env[name] ?? '')
    .replace(/\$([A-Z_][A-Z0-9_]*)/gi, (_, name) => env[name] ?? '');
}

function portToString(p: unknown): string {
  if (typeof p === 'string' || typeof p === 'number') return String(p);
  if (p && typeof p === 'object') {
    const o = p as { published?: unknown; target?: unknown; protocol?: string };
    if (o.published != null && o.target != null) {
      return o.protocol ? `${o.published}:${o.target}/${o.protocol}` : `${o.published}:${o.target}`;
    }
    if (o.target != null) return String(o.target);
  }
  return String(p);
}

function parseCompose(content: string, env: Record<string, string>): ParsedCompose {
  const result: ParsedCompose = { services: [], networks: [], volumes: [], error: null };
  if (!content.trim()) return result;

  try {
    const doc = yaml.load(content) as Record<string, unknown>;
    if (!doc || typeof doc !== 'object') {
      result.error = 'Invalid YAML';
      return result;
    }

    const services = (doc.services || {}) as Record<string, Record<string, unknown>>;
    for (const [name, svc] of Object.entries(services)) {
      if (!svc || typeof svc !== 'object') continue;

      const ports: ParsedPort[] = Array.isArray(svc.ports)
        ? svc.ports.map((p: unknown) => {
            const raw = portToString(p);
            return { raw, resolved: substituteEnv(raw, env) };
          })
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

    const nets = (doc.networks || {}) as Record<string, Record<string, unknown> | null>;
    for (const [name, cfg] of Object.entries(nets)) {
      result.networks.push({
        name,
        external: !!(cfg?.external),
        driver: typeof cfg?.driver === 'string' ? cfg.driver : null,
      });
    }

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

function Tag({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <span className={`inline-block font-mono text-[10px] px-1.5 py-0.5 rounded bg-bg-secondary ${className}`}>{children}</span>;
}

interface Props {
  composeContent: string;
  envVars?: Record<string, string>;
  onDeletePort?: (serviceName: string, rawPort: string) => void;
}

export function ComposePreview({ composeContent, envVars, onDeletePort }: Props) {
  const parsed = useMemo(() => parseCompose(composeContent, envVars || {}), [composeContent, envVars]);

  if (parsed.error) {
    return (
      <div className="text-xs text-status-down p-3 bg-status-down/5 rounded-lg border border-status-down/20">
        YAML error: {parsed.error}
      </div>
    );
  }

  if (parsed.services.length === 0) {
    return <div className="text-xs text-text-muted p-3">No services defined</div>;
  }

  return (
    <div className="space-y-6">
      {/* Services grid */}
      <div>
        <div className="text-[10px] font-semibold text-text-muted uppercase tracking-wider mb-2 flex items-center gap-1.5">
          <Box size={11} /> Services ({parsed.services.length})
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {parsed.services.map((svc) => (
            <div key={svc.name} className="rounded-lg border border-border bg-bg-tertiary p-3">
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-xs font-semibold text-text-primary">{svc.name}</span>
                {svc.restart && <Tag className="text-text-muted">{svc.restart}</Tag>}
              </div>
              {svc.image && (
                <div className="flex items-center gap-1.5 text-[10px] text-accent font-mono mb-1.5">
                  <HardDrive size={9} className="shrink-0" /> <span className="break-all">{svc.image}</span>
                </div>
              )}
              {svc.build && (
                <div className="flex items-center gap-1.5 text-[10px] text-status-pending font-mono mb-1.5">
                  <Box size={9} className="shrink-0" /> build: {svc.build}
                </div>
              )}
              {svc.ports.length > 0 && (
                <div className="flex items-start gap-1.5 text-[10px] text-text-muted mb-1.5">
                  <Globe size={9} className="shrink-0 mt-0.5" />
                  <div className="flex flex-wrap gap-1">
                    {svc.ports.map((p, i) => (
                      <span key={i} className="inline-flex items-center gap-0.5 font-mono text-[10px] px-1.5 py-0.5 rounded bg-bg-secondary group">
                        <span className="text-text-secondary">{p.resolved}</span>
                        {p.raw !== p.resolved && (
                          <span className="text-text-muted opacity-60" title={`Template: ${p.raw}`}>*</span>
                        )}
                        {onDeletePort && (
                          <button
                            onClick={() => onDeletePort(svc.name, p.raw)}
                            className="ml-0.5 opacity-0 group-hover:opacity-100 text-text-muted hover:text-status-down transition-opacity"
                            title="Remove this port"
                          >
                            <X size={10} />
                          </button>
                        )}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {svc.volumes.length > 0 && (
                <div className="flex items-start gap-1.5 text-[10px] text-text-muted mb-1.5">
                  <Database size={9} className="shrink-0 mt-0.5" />
                  <div className="flex flex-wrap gap-1">
                    {svc.volumes.map((v, i) => <Tag key={i} className={v.startsWith('./') ? 'text-status-pending border border-status-pending/30' : 'text-text-muted'}>{v}</Tag>)}
                  </div>
                </div>
              )}
              {svc.networks.length > 0 && (
                <div className="flex items-start gap-1.5 text-[10px] text-text-muted mb-1.5">
                  <Network size={9} className="shrink-0 mt-0.5" />
                  <div className="flex flex-wrap gap-1">
                    {svc.networks.map((n, i) => <Tag key={i}>{n}</Tag>)}
                  </div>
                </div>
              )}
              {svc.depends_on.length > 0 && (
                <div className="flex items-start gap-1.5 text-[10px] text-text-muted mb-1.5">
                  <Plug size={9} className="shrink-0 mt-0.5" />
                  <div className="flex flex-wrap gap-1">
                    {svc.depends_on.map((d, i) => <Tag key={i}>{d}</Tag>)}
                  </div>
                </div>
              )}
              {svc.environment > 0 && (
                <div className="text-[10px] text-text-muted">{svc.environment} env var{svc.environment > 1 ? 's' : ''}</div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Networks grid */}
      {parsed.networks.length > 0 && (
        <div>
          <div className="text-[10px] font-semibold text-text-muted uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Network size={11} /> Networks ({parsed.networks.length})
          </div>
          <div className="flex flex-wrap gap-2">
            {parsed.networks.map((n) => (
              <div key={n.name} className="flex items-center gap-2 text-[11px] px-3 py-1.5 rounded-lg border border-border bg-bg-tertiary">
                <span className="font-mono font-medium text-text-primary">{n.name}</span>
                {n.external && <span className="px-1.5 py-0.5 rounded bg-status-pending/10 text-status-pending text-[9px] font-medium">external</span>}
                {n.driver && <span className="text-text-muted text-[10px]">{n.driver}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Volumes grid */}
      {parsed.volumes.length > 0 && (
        <div>
          <div className="text-[10px] font-semibold text-text-muted uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Database size={11} /> Volumes ({parsed.volumes.length})
          </div>
          <div className="flex flex-wrap gap-2">
            {parsed.volumes.map((v) => (
              <div key={v.name} className="flex items-center gap-2 text-[11px] px-3 py-1.5 rounded-lg border border-border bg-bg-tertiary">
                <span className="font-mono font-medium text-text-primary">{v.name}</span>
                {v.external && <span className="px-1.5 py-0.5 rounded bg-status-pending/10 text-status-pending text-[9px] font-medium">external</span>}
                {v.driver && <span className="text-text-muted text-[10px]">{v.driver}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
