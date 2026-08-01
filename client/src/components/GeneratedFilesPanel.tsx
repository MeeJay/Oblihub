import { useEffect, useState } from 'react';
import { FileCog, ChevronDown, ChevronRight, RefreshCw, Layers } from 'lucide-react';
import { managedStacksApi } from '@/api/managed-stacks.api';
import type { ManagedStack } from '@oblihub/shared';

interface GenFile { name: string; path: string; content: string | null; exists: boolean }

/**
 * Read-only view of files Oblihub auto-generates next to the operator's compose (currently just
 * `docker-compose.override.yml`) plus the merged "effective" compose the CLI actually sees at
 * up time. Answers "why is/isn't this service on the proxy network" without SSH access.
 */
export function GeneratedFilesPanel({ stack }: { stack: ManagedStack }) {
  const [files, setFiles] = useState<GenFile[]>([]);
  const [effective, setEffective] = useState<{ config: string | null; error: string | null } | null>(null);
  const [showOverride, setShowOverride] = useState(false);
  const [showEffective, setShowEffective] = useState(false);
  const [loading, setLoading] = useState(true);
  const [effectiveLoading, setEffectiveLoading] = useState(false);

  const load = () => {
    setLoading(true);
    managedStacksApi.getGeneratedFiles(stack.id)
      .then(setFiles)
      .catch(() => setFiles([]))
      .finally(() => setLoading(false));
  };
  useEffect(load, [stack.id]);

  const loadEffective = () => {
    setEffectiveLoading(true);
    managedStacksApi.getEffectiveConfig(stack.id)
      .then(setEffective)
      .catch(err => setEffective({ config: null, error: err instanceof Error ? err.message : 'Fetch failed' }))
      .finally(() => setEffectiveLoading(false));
  };

  const override = files.find(f => f.name === 'docker-compose.override.yml');

  return (
    <div className="rounded-xl border border-border bg-bg-secondary overflow-hidden">
      <div className="px-4 py-2.5 border-b border-border flex items-center gap-2">
        <FileCog size={14} className="text-text-muted" />
        <h2 className="text-sm font-semibold text-text-secondary">Generated files</h2>
        <span className="text-[11px] text-text-muted ml-auto">
          Auto-written by Oblihub next to your compose — read-only
        </span>
        <button onClick={load} disabled={loading} className="text-text-muted hover:text-text-primary" title="Refresh">
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>
      <div className="p-4 space-y-3">
        {/* Override file */}
        <div>
          <button
            onClick={() => setShowOverride(v => !v)}
            className="flex items-center gap-2 text-xs text-text-secondary hover:text-text-primary"
          >
            {showOverride ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <code className="font-mono">{override?.path || 'docker-compose.override.yml'}</code>
            <span className={`text-[10px] uppercase tracking-wider ${override?.exists ? 'text-status-up' : 'text-text-muted'}`}>
              {override?.exists ? 'present' : 'not generated'}
            </span>
          </button>
          {showOverride && (
            <div className="mt-2">
              {override?.exists && override.content ? (
                <pre className="max-h-64 overflow-auto rounded bg-bg-primary border border-border p-3 font-mono text-[11px] text-text-secondary leading-relaxed">
{override.content}
                </pre>
              ) : (
                <p className="text-xs text-text-muted italic">
                  No override written — either your compose declares its own top-level
                  <code className="bg-bg-tertiary px-1 rounded mx-1">networks: proxy</code>
                  (Oblihub steps aside), or no proxy_host targets any service in this stack.
                </p>
              )}
            </div>
          )}
        </div>

        {/* Effective config */}
        <div className="border-t border-border pt-3">
          <button
            onClick={() => {
              setShowEffective(v => {
                const next = !v;
                if (next && !effective && !effectiveLoading) loadEffective();
                return next;
              });
            }}
            className="flex items-center gap-2 text-xs text-text-secondary hover:text-text-primary"
          >
            {showEffective ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <Layers size={12} />
            <span>Effective compose <span className="text-text-muted">(compose + override + env, resolved)</span></span>
            {effectiveLoading && <RefreshCw size={11} className="animate-spin ml-1" />}
          </button>
          {showEffective && (
            <div className="mt-2">
              {effectiveLoading ? (
                <p className="text-xs text-text-muted italic">Running <code className="bg-bg-tertiary px-1 rounded">docker compose config</code>…</p>
              ) : effective?.config ? (
                <pre className="max-h-96 overflow-auto rounded bg-bg-primary border border-border p-3 font-mono text-[11px] text-text-secondary leading-relaxed">
{effective.config}
                </pre>
              ) : effective?.error ? (
                <p className="text-xs text-status-down italic">Failed: {effective.error}</p>
              ) : null}
              {effective && (
                <button onClick={loadEffective} className="mt-2 text-[11px] text-text-muted hover:text-text-primary inline-flex items-center gap-1">
                  <RefreshCw size={10} /> Reload
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
