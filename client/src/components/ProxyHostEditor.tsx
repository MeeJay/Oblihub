import { useState, type Dispatch, type SetStateAction } from 'react';
import { Shield, Zap, Lock, Globe, Moon } from 'lucide-react';
import type { ProxyHost, Certificate, AccessList, CustomPage, Container, AzureAuthProvider, ProxyHostRoute } from '@oblihub/shared';
import { ContainerPicker } from './ContainerPicker';
import { RouteEditor } from './RouteEditor';

export type ProxyHostEditorProps = {
  editing: Partial<ProxyHost>;
  setEditing: Dispatch<SetStateAction<Partial<ProxyHost> | null>>;
  editId: number | null;
  certs: Certificate[];
  hosts: ProxyHost[];
  accessLists: AccessList[];
  azureProviders: AzureAuthProvider[];
  customPages: CustomPage[];
  allContainers: { container: Container; stackName: string }[];
  domainInput: string;
  setDomainInput: (v: string) => void;
  addDomain: () => void;
  removeDomain: (d: string) => void;
  certMode: 'none' | 'existing' | 'new';
  setCertMode: (m: 'none' | 'existing' | 'new') => void;
  acmeEmail: string;
  setAcmeEmail: (v: string) => void;
};

type Tab = 'general' | 'ssl' | 'auth' | 'routes' | 'performance' | 'others' | 'expert';
const TABS: { key: Tab; label: string }[] = [
  { key: 'general',     label: 'General' },
  { key: 'ssl',         label: 'SSL' },
  { key: 'auth',        label: 'Auth' },
  { key: 'routes',      label: 'Routes' },
  { key: 'performance', label: 'Performance' },
  { key: 'others',      label: 'Others' },
  { key: 'expert',      label: 'Expert' },
];

export function ProxyHostEditor(props: ProxyHostEditorProps) {
  const [tab, setTab] = useState<Tab>('general');
  const { editing, setEditing } = props;

  return (
    <>
      <div className="border-b border-border px-6 flex gap-1 overflow-x-auto">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors flex-shrink-0 ${
              tab === t.key ? 'border-accent text-accent' : 'border-transparent text-text-muted hover:text-text-primary'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="p-6 space-y-5">
        {tab === 'general'     && <GeneralTab {...props} />}
        {tab === 'ssl'         && <SslTab {...props} />}
        {tab === 'auth'        && <AuthTab {...props} />}
        {tab === 'routes'      && (
          <RouteEditor
            routes={editing.routes || []}
            onChange={(routes) => setEditing(e => e ? { ...e, routes } : null)}
            defaults={{
              forwardScheme: editing.forwardScheme || 'http',
              forwardHost: editing.forwardHost || '',
              forwardPort: editing.forwardPort || 80,
            }}
            azureProviders={props.azureProviders}
            accessLists={props.accessLists}
          />
        )}
        {tab === 'performance' && <PerformanceTab {...props} />}
        {tab === 'others'      && <OthersTab {...props} />}
        {tab === 'expert'      && <ExpertTab {...props} />}
      </div>
    </>
  );
}

// ── General ──
function GeneralTab({ editing, setEditing, domainInput, setDomainInput, addDomain, removeDomain }: ProxyHostEditorProps) {
  return (
    <>
      <div>
        <label className="text-xs font-medium text-text-secondary block mb-1.5">Domain Names</label>
        <div className="flex flex-wrap gap-1.5 mb-2">
          {(editing.domainNames || []).map(d => (
            <span key={d} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-accent/10 text-accent text-xs font-mono">
              {d}
              <button onClick={() => removeDomain(d)} className="hover:text-status-down">&times;</button>
            </span>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            value={domainInput}
            onChange={e => setDomainInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addDomain())}
            placeholder="example.com"
            className="flex-1 rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <button onClick={addDomain} className="px-3 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">Add</button>
        </div>
      </div>

      <div className="grid grid-cols-[80px_1fr_100px] gap-3">
        <div>
          <label className="text-xs font-medium text-text-secondary block mb-1.5">Scheme</label>
          <select
            value={editing.forwardScheme || 'http'}
            onChange={e => setEditing(h => h ? { ...h, forwardScheme: e.target.value as 'http' | 'https' } : null)}
            className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
          >
            <option value="http">http</option>
            <option value="https">https</option>
          </select>
        </div>
        <div>
          <label className="text-xs font-medium text-text-secondary block mb-1.5">Forward Host</label>
          <ContainerPicker
            value={editing.forwardHost || ''}
            onChange={(host) => setEditing(h => h ? { ...h, forwardHost: host } : null)}
          />
        </div>
        <div>
          <label className="text-xs font-medium text-text-secondary block mb-1.5">Port</label>
          <input
            type="number"
            value={editing.forwardPort || 80}
            onChange={e => setEditing(h => h ? { ...h, forwardPort: parseInt(e.target.value) || 80 } : null)}
            className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
      </div>

      <div>
        <label className="text-xs font-medium text-text-secondary block mb-1.5">
          Docker network <span className="text-text-muted font-normal">(for auto network-attach on deploy)</span>
        </label>
        <input
          value={editing.dockerNetwork || ''}
          onChange={e => setEditing(h => h ? { ...h, dockerNetwork: e.target.value || null } : null)}
          placeholder="proxy (default) — or nginx-proxy-manager_default, traefik_default, …"
          className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary font-mono focus:outline-none focus:ring-1 focus:ring-accent"
        />
        <p className="text-[10px] text-text-muted mt-1">
          The compose override attaches the forward-host service to this network on every deploy so it survives rebuilds. Leave blank for Oblihub&#39;s built-in proxy.
        </p>
      </div>

      {/* Small feature toggles that don't fit anywhere else. */}
      <div className="grid grid-cols-2 gap-3">
        <ToggleCell active={editing.blockExploits ?? true} onToggle={() => setEditing(h => h ? { ...h, blockExploits: !h.blockExploits } : null)} icon={Shield} label="Block common exploits" />
        <ToggleCell active={editing.enabled ?? true} onToggle={() => setEditing(h => h ? { ...h, enabled: !h.enabled } : null)} icon={Globe} label="Enabled" />
      </div>
    </>
  );
}

// ── SSL ──
function SslTab({ editing, setEditing, certs, hosts, certMode, setCertMode, acmeEmail, setAcmeEmail, editId }: ProxyHostEditorProps) {
  return (
    <>
      <div>
        <label className="text-xs font-medium text-text-secondary block mb-1.5">SSL Certificate</label>
        <div className="flex gap-2 mb-2">
          {(['none', 'new', 'existing'] as const).map(mode => (
            <button
              key={mode}
              onClick={() => {
                setCertMode(mode);
                if (mode === 'none') setEditing(h => h ? { ...h, certificateId: null, sslForced: false, http2Support: false, hstsEnabled: false, hstsSubdomains: false } : null);
              }}
              className={`flex-1 px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                certMode === mode ? 'border-accent bg-accent/10 text-accent font-medium' : 'border-border text-text-muted hover:bg-bg-hover'
              }`}
            >
              {mode === 'none' ? 'No SSL' : mode === 'new' ? "Request Let's Encrypt" : 'Use Existing'}
            </button>
          ))}
        </div>
        {certMode === 'new' && (
          <div className="space-y-2 p-3 rounded-lg border border-accent/20 bg-accent/5">
            <div className="text-[10px] text-accent font-medium">A new Let's Encrypt certificate will be requested for the domains above</div>
            <input
              value={acmeEmail}
              onChange={e => setAcmeEmail(e.target.value)}
              placeholder="admin@example.com"
              type="email"
              className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
        )}
        {certMode === 'existing' && (
          <div className="space-y-1 max-h-40 overflow-auto">
            {certs.length === 0 ? (
              <div className="text-xs text-text-muted p-2">No certificates available</div>
            ) : certs.map(c => {
              const isUsed = hosts.some(h => h.certificateId === c.id && h.id !== editId);
              const isSelected = editing.certificateId === c.id;
              return (
                <button
                  key={c.id}
                  onClick={() => setEditing(h => h ? { ...h, certificateId: c.id, sslForced: true, http2Support: true } : null)}
                  className={`w-full text-left px-3 py-2 rounded-lg border text-xs transition-colors ${
                    isSelected ? 'border-accent bg-accent/10' : isUsed ? 'border-status-down/30 bg-status-down/5 hover:bg-status-down/10' : 'border-border hover:bg-bg-hover'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className={`font-mono ${isSelected ? 'text-accent' : 'text-text-primary'}`}>{c.domainNames.join(', ')}</span>
                    <div className="flex items-center gap-1.5">
                      {isUsed && <span className="text-[9px] px-1 py-0.5 rounded bg-status-down/10 text-status-down">In use</span>}
                      <span className={`text-[9px] px-1 py-0.5 rounded ${c.status === 'valid' ? 'bg-status-up/10 text-status-up' : 'bg-status-pending/10 text-status-pending'}`}>{c.status}</span>
                    </div>
                  </div>
                  {c.expiresAt && <div className="text-[10px] text-text-muted mt-0.5">Expires: {new Date(c.expiresAt).toLocaleDateString()}</div>}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <ToggleCell disabled={certMode === 'none'} active={!!editing.sslForced}     onToggle={() => setEditing(h => h ? { ...h, sslForced: !h.sslForced } : null)}         icon={Lock}   label="Force SSL" />
        <ToggleCell disabled={certMode === 'none'} active={!!editing.http2Support}  onToggle={() => setEditing(h => h ? { ...h, http2Support: !h.http2Support } : null)}   icon={Zap}    label="HTTP/2" />
        <ToggleCell disabled={certMode === 'none'} active={!!editing.hstsEnabled}   onToggle={() => setEditing(h => h ? { ...h, hstsEnabled: !h.hstsEnabled } : null)}     icon={Shield} label="HSTS" />
        <ToggleCell disabled={certMode === 'none' || !editing.hstsEnabled} active={!!editing.hstsSubdomains} onToggle={() => setEditing(h => h ? { ...h, hstsSubdomains: !h.hstsSubdomains } : null)} icon={Shield} label="HSTS Subdomains" />
      </div>
    </>
  );
}

// ── Auth ──
function AuthTab({ editing, setEditing, accessLists, azureProviders }: ProxyHostEditorProps) {
  return (
    <>
      <div>
        <label className="text-xs font-medium text-text-secondary block mb-1.5">
          Access Lists <span className="text-text-muted">(stackable — union of rules)</span>
        </label>
        {accessLists.length === 0 ? (
          <div className="text-[11px] text-text-muted italic rounded-lg border border-border bg-bg-tertiary px-3 py-2">
            No access lists configured. Create one in the Access Lists page.
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-bg-tertiary p-2 max-h-40 overflow-y-auto space-y-1">
            {accessLists.map(al => {
              const selected = (editing.accessListIds || (editing.accessListId ? [editing.accessListId] : [])).includes(al.id);
              return (
                <label key={al.id} className="flex items-center gap-2 text-xs text-text-primary cursor-pointer hover:bg-bg-secondary px-1 py-0.5 rounded">
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={(e) => setEditing(h => {
                      if (!h) return null;
                      const cur = h.accessListIds || (h.accessListId ? [h.accessListId] : []);
                      const next = e.target.checked ? [...cur, al.id] : cur.filter(x => x !== al.id);
                      return { ...h, accessListIds: next, accessListId: next[0] ?? null };
                    })}
                  />
                  <span className="font-medium">{al.name}</span>
                  <span className="text-text-muted">({al.clients.length} rule{al.clients.length !== 1 ? 's' : ''}, {al.auth.length} user{al.auth.length !== 1 ? 's' : ''})</span>
                </label>
              );
            })}
          </div>
        )}
      </div>

      <div>
        <label className="text-xs font-medium text-text-secondary block mb-1.5">
          Azure AD forward-auth <span className="text-text-muted">(delegates auth to an oauth2-proxy sidecar)</span>
        </label>
        <select
          value={editing.azureAuthProviderId || ''}
          onChange={e => setEditing(h => h ? { ...h, azureAuthProviderId: e.target.value ? parseInt(e.target.value, 10) : null } : null)}
          className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
        >
          <option value="">None — no forward-auth</option>
          {azureProviders.map(p => (
            <option key={p.id} value={p.id}>
              {p.name} {p.containerStatus === 'running' ? '' : `(${p.containerStatus || 'not deployed'})`}
            </option>
          ))}
        </select>
        {editing.azureAuthProviderId && editing.domainNames?.[0] && (
          <p className="text-[10px] text-status-pending mt-1.5">
            ⚠ Add this callback URL to the Azure app's Redirect URIs: <code className="bg-bg-tertiary px-1 rounded">https://{editing.domainNames[0]}/oauth2/callback</code>
          </p>
        )}
        {azureProviders.length === 0 && (
          <p className="text-[10px] text-text-muted mt-1.5">
            No providers yet — create one in the <a href="/azure-auth" className="text-accent hover:underline">Azure Auth page</a>.
          </p>
        )}
      </div>
    </>
  );
}

// ── Performance ──
function PerformanceTab({ editing, setEditing }: ProxyHostEditorProps) {
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <ToggleCell active={!!editing.cachingEnabled}   onToggle={() => setEditing(h => h ? { ...h, cachingEnabled: !h.cachingEnabled } : null)}     icon={Zap}    label="Cache static assets" />
        <ToggleCell active={!!editing.gzipEnabled}      onToggle={() => setEditing(h => h ? { ...h, gzipEnabled: !h.gzipEnabled } : null)}           icon={Zap}    label="Gzip compression" />
        <ToggleCell active={!!editing.websocketSupport} onToggle={() => setEditing(h => h ? { ...h, websocketSupport: !h.websocketSupport } : null)} icon={Zap}    label="WebSocket support" />
        <ToggleCell active={!!editing.corsEnabled}      onToggle={() => setEditing(h => h ? { ...h, corsEnabled: !h.corsEnabled } : null)}           icon={Globe}  label="CORS headers" />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-[10px] text-text-muted block mb-1">Max Body Size</label>
          <input value={editing.clientMaxBodySize || ''} onChange={e => setEditing(h => h ? { ...h, clientMaxBodySize: e.target.value || null } : null)} placeholder="100m"
            className="w-full rounded border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
        </div>
        <div>
          <label className="text-[10px] text-text-muted block mb-1">Proxy buffering</label>
          <select
            value={editing.proxyBuffering === false ? 'off' : editing.proxyBuffering === true ? 'on' : 'default'}
            onChange={e => setEditing(h => h ? { ...h, proxyBuffering: e.target.value === 'default' ? null : e.target.value === 'on' } : null)}
            className="w-full rounded border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
          >
            <option value="default">nginx default (on)</option>
            <option value="on">Force on</option>
            <option value="off">Off (streams / SSE)</option>
          </select>
        </div>
        <div>
          <label className="text-[10px] text-text-muted block mb-1">Connect Timeout (sec)</label>
          <input type="number" value={editing.proxyConnectTimeout || ''} onChange={e => setEditing(h => h ? { ...h, proxyConnectTimeout: parseInt(e.target.value) || null } : null)} placeholder="60"
            className="w-full rounded border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
        </div>
        <div>
          <label className="text-[10px] text-text-muted block mb-1">Send Timeout (sec)</label>
          <input type="number" value={editing.proxySendTimeout || ''} onChange={e => setEditing(h => h ? { ...h, proxySendTimeout: parseInt(e.target.value) || null } : null)} placeholder="60"
            className="w-full rounded border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
        </div>
        <div>
          <label className="text-[10px] text-text-muted block mb-1">Read Timeout (sec)</label>
          <input type="number" value={editing.proxyReadTimeout || ''} onChange={e => setEditing(h => h ? { ...h, proxyReadTimeout: parseInt(e.target.value) || null } : null)} placeholder="60"
            className="w-full rounded border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-[10px] text-text-muted block mb-1">Rate Limit (req/sec)</label>
          <input type="number" value={editing.rateLimitRps || ''} onChange={e => setEditing(h => h ? { ...h, rateLimitRps: parseInt(e.target.value) || null } : null)} placeholder="Off"
            className="w-full rounded border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
        </div>
        <div>
          <label className="text-[10px] text-text-muted block mb-1">Rate Limit Burst</label>
          <input type="number" value={editing.rateLimitBurst || ''} onChange={e => setEditing(h => h ? { ...h, rateLimitBurst: parseInt(e.target.value) || null } : null)} placeholder="10"
            className="w-full rounded border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
        </div>
      </div>
    </>
  );
}

// ── Others: error page, sleep mode, custom response headers ──
function OthersTab({ editing, setEditing, customPages, allContainers }: ProxyHostEditorProps) {
  return (
    <>
      <div>
        <label className="text-xs font-medium text-text-secondary block mb-1.5">Error Page</label>
        <select
          value={editing.errorPageId || ''}
          onChange={e => setEditing(h => h ? { ...h, errorPageId: parseInt(e.target.value) || null } : null)}
          className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
        >
          <option value="">Use global default</option>
          {customPages.filter(p => !p.isWakingPage).map(p => <option key={p.id} value={p.id}>{p.name} ({p.errorCodes.join(', ')})</option>)}
        </select>
      </div>

      <div className="rounded-lg border border-border bg-bg-tertiary/50 p-3">
        <div className="flex items-center gap-2 mb-2">
          <Moon size={14} className="text-accent" />
          <span className="text-sm font-medium text-text-primary">Sleep mode</span>
        </div>
        <p className="text-[11px] text-text-muted mb-3">
          When the linked container is asleep, requests to this host show a loading page that auto-wakes it. Configure the container&#39;s idle timeout from its Sleep panel in the Stack page.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="text-[11px] font-medium text-text-secondary block mb-1">Wake container</label>
            <select
              value={editing.wakeContainerId || ''}
              onChange={e => setEditing(h => h ? { ...h, wakeContainerId: parseInt(e.target.value) || null } : null)}
              className="w-full rounded-lg border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
            >
              <option value="">Disabled</option>
              {allContainers.map(({ container, stackName }) => (
                <option key={container.id} value={container.id}>
                  {stackName} / {container.containerName}{container.sleepEnabled ? ' ⏾' : ''}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-[11px] font-medium text-text-secondary block mb-1">Waking page</label>
            <select
              value={editing.wakingPageId || ''}
              onChange={e => setEditing(h => h ? { ...h, wakingPageId: parseInt(e.target.value) || null } : null)}
              className="w-full rounded-lg border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
              disabled={!editing.wakeContainerId}
            >
              <option value="">Built-in default</option>
              {customPages.filter(p => p.isWakingPage).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        </div>

        <div className="mt-3">
          <label className="text-[11px] font-medium text-text-secondary block mb-1">
            Also wake these containers <span className="text-text-muted">(optional, parallel)</span>
          </label>
          {editing.wakeContainerId ? (
            <div className="rounded-lg border border-border bg-bg-tertiary/40 p-2 max-h-40 overflow-y-auto space-y-1">
              {allContainers.filter(({ container }) => container.id !== editing.wakeContainerId).map(({ container, stackName }) => {
                const checked = (editing.wakeExtraContainerIds || []).includes(container.id);
                return (
                  <label key={container.id} className="flex items-center gap-2 text-[11px] text-text-primary cursor-pointer hover:bg-bg-tertiary px-1 py-0.5 rounded">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => setEditing(h => {
                        if (!h) return null;
                        const cur = h.wakeExtraContainerIds || [];
                        const next = e.target.checked ? [...cur, container.id] : cur.filter(id => id !== container.id);
                        return { ...h, wakeExtraContainerIds: next };
                      })}
                    />
                    <span>{stackName} / {container.containerName}{container.sleepEnabled ? ' ⏾' : ''}</span>
                  </label>
                );
              })}
              {allContainers.length <= 1 && (
                <div className="text-[11px] text-text-muted italic px-1 py-0.5">No other containers available.</div>
              )}
            </div>
          ) : (
            <div className="rounded-lg border border-border bg-bg-tertiary/40 p-2 text-[11px] text-text-muted italic">Select a primary wake container first.</div>
          )}
        </div>
      </div>

      <div>
        <label className="text-xs font-medium text-text-secondary block mb-1.5">Custom Response Headers</label>
        <div className="space-y-1.5 mb-2">
          {(editing.customResponseHeaders || []).map((h, i) => (
            <div key={i} className="flex gap-1.5 items-center">
              <select
                value={h.action}
                onChange={e => { const headers = [...(editing.customResponseHeaders || [])]; headers[i] = { ...h, action: e.target.value as 'add' | 'remove' }; setEditing(ed => ed ? { ...ed, customResponseHeaders: headers } : null); }}
                className="rounded border border-border bg-bg-tertiary px-1.5 py-0.5 text-[10px] text-text-primary w-16"
              >
                <option value="add">Add</option><option value="remove">Remove</option>
              </select>
              <input
                value={h.name}
                onChange={e => { const headers = [...(editing.customResponseHeaders || [])]; headers[i] = { ...h, name: e.target.value }; setEditing(ed => ed ? { ...ed, customResponseHeaders: headers } : null); }}
                placeholder="Header-Name"
                className="flex-1 rounded border border-border bg-bg-tertiary px-2 py-0.5 text-xs font-mono text-text-primary"
              />
              {h.action === 'add' && (
                <input
                  value={h.value}
                  onChange={e => { const headers = [...(editing.customResponseHeaders || [])]; headers[i] = { ...h, value: e.target.value }; setEditing(ed => ed ? { ...ed, customResponseHeaders: headers } : null); }}
                  placeholder="value"
                  className="flex-1 rounded border border-border bg-bg-tertiary px-2 py-0.5 text-xs font-mono text-text-primary"
                />
              )}
              <button
                onClick={() => { const headers = (editing.customResponseHeaders || []).filter((_, j) => j !== i); setEditing(ed => ed ? { ...ed, customResponseHeaders: headers.length ? headers : null } : null); }}
                className="p-0.5 text-text-muted hover:text-status-down"
              >&times;</button>
            </div>
          ))}
        </div>
        <button
          onClick={() => setEditing(ed => ed ? { ...ed, customResponseHeaders: [...(ed.customResponseHeaders || []), { name: '', value: '', action: 'add' as const }] } : null)}
          className="text-xs text-accent hover:text-accent-hover"
        >+ Add header</button>
      </div>
    </>
  );
}

// ── Expert (advanced free-text) ──
function ExpertTab({ editing, setEditing }: ProxyHostEditorProps) {
  return (
    <div>
      <label className="text-xs font-medium text-text-secondary block mb-1.5">Custom Nginx Configuration</label>
      <textarea
        value={editing.advancedConfig || ''}
        onChange={e => setEditing(h => h ? { ...h, advancedConfig: e.target.value } : null)}
        rows={12}
        spellCheck={false}
        placeholder={'# Injected inside the server { } block, after location /.\n# Use Routes tab for common sub-location cases;\n# this is the escape hatch for the rest.'}
        className="w-full rounded-lg border border-border bg-[#0d1117] px-3 py-2 text-xs font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent resize-none"
      />
      <p className="text-[10px] text-text-muted mt-1">
        Free-form nginx directives. Emitted at the server-scope after the main location block. Use with care — a bad snippet fails <code>nginx -t</code> and stops reloads until fixed.
      </p>
    </div>
  );
}

// ── Reusable toggle cell ──
function ToggleCell({ active, onToggle, icon: Icon, label, disabled }: { active: boolean; onToggle: () => void; icon: typeof Shield; label: string; disabled?: boolean }) {
  return (
    <button
      disabled={disabled}
      onClick={() => { if (!disabled) onToggle(); }}
      className={`flex items-center gap-2 p-2 rounded-lg border transition-colors ${
        disabled ? 'border-border opacity-30 cursor-not-allowed' : active ? 'border-accent/50 bg-accent/10' : 'border-border hover:bg-bg-hover'
      }`}
    >
      <div className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors shrink-0 ${active && !disabled ? 'bg-accent' : 'bg-bg-tertiary'}`}>
        <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${active && !disabled ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
      </div>
      <Icon size={12} className={active && !disabled ? 'text-accent' : 'text-text-muted'} />
      <span className={`text-xs ${active && !disabled ? 'text-text-primary' : 'text-text-secondary'}`}>{label}</span>
    </button>
  );
}
