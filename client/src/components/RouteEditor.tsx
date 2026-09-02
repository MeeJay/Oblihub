import { Plus, Trash2, ChevronDown, ChevronRight, ArrowUp, ArrowDown } from 'lucide-react';
import { useState } from 'react';
import type { ProxyHostRoute, AzureAuthProvider, AccessList } from '@oblihub/shared';
import { ContainerPicker } from './ContainerPicker';

/**
 * Sub-route editor for a proxy host. Each route becomes its own nginx `location` block matched
 * before the host's default `location /`. Enables:
 *   - split traffic across containers (`/api/` → backend, `/` → frontend)
 *   - exempt a path from forward-auth or access lists (webhooks, healthchecks)
 *   - rewrite the URI prefix at the boundary (`/api/` → `/apiv3/` on the upstream)
 *
 * Reorder is purely cosmetic — nginx matches by prefix longest-first regardless of our order.
 */
export function RouteEditor({
  routes,
  onChange,
  defaults,
  azureProviders,
  accessLists,
}: {
  routes: ProxyHostRoute[];
  onChange: (routes: ProxyHostRoute[]) => void;
  defaults: { forwardScheme: 'http' | 'https'; forwardHost: string; forwardPort: number };
  azureProviders: AzureAuthProvider[];
  accessLists: AccessList[];
}) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const add = () => {
    const next: ProxyHostRoute = {
      id: -Date.now(), // negative sentinel — server replaces with real id on save
      proxyHostId: 0,
      sortOrder: routes.length,
      pathIn: '/api/',
      pathRewrite: null,
      forwardScheme: defaults.forwardScheme,
      forwardHost: defaults.forwardHost,
      forwardPort: defaults.forwardPort,
      authMode: 'inherit',
      azureAuthProviderOverrideId: null,
      accessListMode: 'inherit',
      accessListOverrideIds: [],
      websocketSupport: null,
      proxyBuffering: null,
      createdAt: '',
      updatedAt: '',
    };
    onChange([...routes, next]);
    setExpanded(new Set([...expanded, next.id]));
  };

  const patch = (idx: number, delta: Partial<ProxyHostRoute>) => {
    onChange(routes.map((r, i) => i === idx ? { ...r, ...delta } : r));
  };

  const remove = (idx: number) => {
    onChange(routes.filter((_, i) => i !== idx));
  };

  const move = (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= routes.length) return;
    const next = [...routes];
    [next[idx], next[j]] = [next[j], next[idx]];
    onChange(next.map((r, i) => ({ ...r, sortOrder: i })));
  };

  return (
    <div className="space-y-3">
      <div>
        <div className="text-sm font-medium text-text-primary mb-1">Sub-routes</div>
        <p className="text-[11px] text-text-muted">
          Match specific paths to send them to a different backend, exempt them from forward-auth or access lists, or rewrite the URI prefix. nginx picks the most-specific prefix first, so <code>/api/v3/</code> wins over <code>/api/</code> wins over <code>/</code> (the host&#39;s default target).
        </p>
      </div>

      {routes.length === 0 && (
        <div className="text-xs text-text-muted italic rounded-lg border border-border bg-bg-tertiary px-3 py-4 text-center">
          No sub-routes. All traffic goes to the host&#39;s main forward target (General tab).
        </div>
      )}

      {routes.map((r, idx) => {
        const isOpen = expanded.has(r.id);
        return (
          <div key={r.id} className="rounded-lg border border-border bg-bg-tertiary/40">
            <div className="flex items-center gap-2 px-3 py-2">
              <button
                onClick={() => {
                  const next = new Set(expanded);
                  if (isOpen) next.delete(r.id); else next.add(r.id);
                  setExpanded(next);
                }}
                className="text-text-muted hover:text-text-primary"
              >
                {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
              <code className="text-xs font-mono text-accent">{r.pathIn || '(empty)'}</code>
              <span className="text-[10px] text-text-muted">→</span>
              <span className="text-xs text-text-primary truncate">
                {r.forwardScheme}://{r.forwardHost || '?'}:{r.forwardPort}
                {r.pathRewrite ? <span className="text-text-muted">{r.pathRewrite}</span> : null}
              </span>
              <div className="ml-auto flex items-center gap-1">
                {r.authMode !== 'inherit' && <span className={`text-[9px] px-1 py-0.5 rounded ${r.authMode === 'none' ? 'bg-status-down/10 text-status-down' : 'bg-accent/10 text-accent'}`}>auth: {r.authMode}</span>}
                {r.accessListMode !== 'inherit' && <span className={`text-[9px] px-1 py-0.5 rounded ${r.accessListMode === 'none' ? 'bg-status-down/10 text-status-down' : 'bg-accent/10 text-accent'}`}>ACL: {r.accessListMode}</span>}
                <button onClick={() => move(idx, -1)} disabled={idx === 0} className="p-1 rounded text-text-muted hover:text-text-primary disabled:opacity-30"><ArrowUp size={12} /></button>
                <button onClick={() => move(idx, 1)} disabled={idx === routes.length - 1} className="p-1 rounded text-text-muted hover:text-text-primary disabled:opacity-30"><ArrowDown size={12} /></button>
                <button onClick={() => remove(idx)} className="p-1 rounded text-text-muted hover:text-status-down"><Trash2 size={12} /></button>
              </div>
            </div>
            {isOpen && (
              <div className="px-3 pb-3 border-t border-border space-y-3">
                <div className="grid grid-cols-2 gap-3 mt-3">
                  <div>
                    <label className="text-[10px] text-text-muted block mb-1">Path in (URI prefix)</label>
                    <input
                      value={r.pathIn}
                      onChange={e => patch(idx, { pathIn: e.target.value })}
                      placeholder="/api/"
                      className="w-full rounded border border-border bg-bg-tertiary px-2 py-1 text-xs font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-text-muted block mb-1">
                      Path rewrite <span className="text-text-muted">(optional)</span>
                    </label>
                    <input
                      value={r.pathRewrite || ''}
                      onChange={e => patch(idx, { pathRewrite: e.target.value || null })}
                      placeholder="empty = passthrough"
                      className="w-full rounded border border-border bg-bg-tertiary px-2 py-1 text-xs font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                    />
                    <p className="text-[10px] text-text-muted mt-0.5">
                      {r.pathRewrite ? <>Strips <code>{r.pathIn}</code> from URI and prefixes <code>{r.pathRewrite}</code>.</> : 'Empty = URI unchanged.'}
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-[80px_1fr_100px] gap-3">
                  <div>
                    <label className="text-[10px] text-text-muted block mb-1">Scheme</label>
                    <select value={r.forwardScheme} onChange={e => patch(idx, { forwardScheme: e.target.value as 'http' | 'https' })}
                      className="w-full rounded border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent">
                      <option value="http">http</option>
                      <option value="https">https</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] text-text-muted block mb-1">Forward host</label>
                    <ContainerPicker value={r.forwardHost} onChange={(v) => patch(idx, { forwardHost: v })} />
                  </div>
                  <div>
                    <label className="text-[10px] text-text-muted block mb-1">Port</label>
                    <input type="number" value={r.forwardPort} onChange={e => patch(idx, { forwardPort: parseInt(e.target.value) || 80 })}
                      className="w-full rounded border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] text-text-muted block mb-1">Forward-auth</label>
                    <select value={r.authMode} onChange={e => patch(idx, { authMode: e.target.value as 'inherit' | 'none' | 'override' })}
                      className="w-full rounded border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent">
                      <option value="inherit">Inherit (host default)</option>
                      <option value="none">None (public — bypass auth)</option>
                      <option value="override" disabled>Override provider (coming soon)</option>
                    </select>
                    {r.authMode === 'override' && (
                      <select value={r.azureAuthProviderOverrideId || ''} onChange={e => patch(idx, { azureAuthProviderOverrideId: parseInt(e.target.value) || null })}
                        className="w-full mt-1 rounded border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent">
                        <option value="">Select provider…</option>
                        {azureProviders.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                    )}
                  </div>
                  <div>
                    <label className="text-[10px] text-text-muted block mb-1">Access lists</label>
                    <select value={r.accessListMode} onChange={e => patch(idx, { accessListMode: e.target.value as 'inherit' | 'none' | 'override' })}
                      className="w-full rounded border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent">
                      <option value="inherit">Inherit (host default)</option>
                      <option value="none">None (bypass)</option>
                      <option value="override" disabled>Override (coming soon)</option>
                    </select>
                    {r.accessListMode === 'override' && (
                      <div className="mt-1 rounded border border-border bg-bg-tertiary p-1 max-h-24 overflow-y-auto space-y-0.5">
                        {accessLists.map(al => {
                          const selected = r.accessListOverrideIds.includes(al.id);
                          return (
                            <label key={al.id} className="flex items-center gap-1 text-[10px] cursor-pointer">
                              <input
                                type="checkbox"
                                checked={selected}
                                onChange={e => patch(idx, {
                                  accessListOverrideIds: e.target.checked
                                    ? [...r.accessListOverrideIds, al.id]
                                    : r.accessListOverrideIds.filter(x => x !== al.id),
                                })}
                              />
                              <span>{al.name}</span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] text-text-muted block mb-1">WebSocket</label>
                    <select
                      value={r.websocketSupport === null ? 'inherit' : r.websocketSupport ? 'on' : 'off'}
                      onChange={e => patch(idx, { websocketSupport: e.target.value === 'inherit' ? null : e.target.value === 'on' })}
                      className="w-full rounded border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                    >
                      <option value="inherit">Inherit</option>
                      <option value="on">On</option>
                      <option value="off">Off</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] text-text-muted block mb-1">Proxy buffering</label>
                    <select
                      value={r.proxyBuffering === null ? 'inherit' : r.proxyBuffering ? 'on' : 'off'}
                      onChange={e => patch(idx, { proxyBuffering: e.target.value === 'inherit' ? null : e.target.value === 'on' })}
                      className="w-full rounded border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                    >
                      <option value="inherit">Inherit</option>
                      <option value="on">On</option>
                      <option value="off">Off (streams / SSE)</option>
                    </select>
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}

      <button
        onClick={add}
        className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs rounded-lg border border-dashed border-border text-text-muted hover:text-text-primary hover:border-accent"
      >
        <Plus size={12} /> Add sub-route
      </button>
    </div>
  );
}
