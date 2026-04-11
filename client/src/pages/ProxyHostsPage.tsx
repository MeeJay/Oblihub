import { useEffect, useState } from 'react';
import { RefreshCw, Plus, Trash2, Edit2, Globe, Shield, Zap, Lock, Power, PowerOff, ChevronDown, ChevronRight } from 'lucide-react';
import { proxyApi } from '@/api/proxy.api';
import type { ProxyHost, Certificate, AccessList, CustomPage } from '@oblihub/shared';
import toast from 'react-hot-toast';

const DEFAULT_HOST: Partial<ProxyHost> = {
  domainNames: [],
  forwardScheme: 'http',
  forwardHost: '',
  forwardPort: 80,
  sslForced: false,
  http2Support: false,
  hstsEnabled: false,
  hstsSubdomains: false,
  blockExploits: true,
  cachingEnabled: false,
  websocketSupport: true,
  enabled: true,
};

export function ProxyHostsPage() {
  const [hosts, setHosts] = useState<ProxyHost[]>([]);
  const [certs, setCerts] = useState<Certificate[]>([]);
  const [accessLists, setAccessLists] = useState<AccessList[]>([]);
  const [customPages, setCustomPages] = useState<CustomPage[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Partial<ProxyHost> | null>(null);
  const [editId, setEditId] = useState<number | null>(null);
  const [domainInput, setDomainInput] = useState('');
  const [certMode, setCertMode] = useState<'none' | 'existing' | 'new'>('none');
  const [acmeEmail, setAcmeEmail] = useState(localStorage.getItem('oblihub_acme_email') || '');

  const load = async () => {
    try {
      const [h, c, a, p] = await Promise.all([proxyApi.listHosts(), proxyApi.listCertificates(), proxyApi.listAccessLists(), proxyApi.listCustomPages()]);
      setHosts(h);
      setCerts(c);
      setAccessLists(a);
      setCustomPages(p);
    } catch { toast.error('Failed to load proxy hosts'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  // Auto-refresh while any cert is pending
  useEffect(() => {
    if (!hosts.some(h => h.certificate?.status === 'pending')) return;
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [hosts]);

  const startCreate = () => {
    setEditing({ ...DEFAULT_HOST, domainNames: [] });
    setEditId(null);
    setDomainInput('');
  };

  const startEdit = (host: ProxyHost) => {
    setEditing({ ...host });
    setEditId(host.id);
    setDomainInput('');
    setCertMode(host.certificateId ? 'existing' : 'none');
  };

  const addDomain = () => {
    const d = domainInput.trim().toLowerCase();
    if (!d || editing?.domainNames?.includes(d)) return;
    setEditing(e => e ? { ...e, domainNames: [...(e.domainNames || []), d] } : null);
    setDomainInput('');
  };

  const removeDomain = (domain: string) => {
    setEditing(e => e ? { ...e, domainNames: (e.domainNames || []).filter(d => d !== domain) } : null);
  };

  const handleSave = async () => {
    if (!editing) return;
    if (!editing.domainNames?.length) { toast.error('At least one domain required'); return; }
    if (!editing.forwardHost) { toast.error('Forward host required'); return; }
    try {
      // If requesting new LE cert, create it first
      if (certMode === 'new') {
        if (!acmeEmail) { toast.error('Email required for Let\'s Encrypt'); return; }
        localStorage.setItem('oblihub_acme_email', acmeEmail);
        const cert = await proxyApi.createCertificate({ domainNames: editing.domainNames, provider: 'letsencrypt', acmeEmail });
        editing.certificateId = cert.id;
        editing.sslForced = true;
        editing.http2Support = true;
      }
      if (editId) {
        await proxyApi.updateHost(editId, editing);
        toast.success('Proxy host updated');
      } else {
        await proxyApi.createHost(editing);
        toast.success('Proxy host created');
      }
      setEditing(null);
      setEditId(null);
      setCertMode('none');
      load();
    } catch { toast.error('Failed to save proxy host'); }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this proxy host?')) return;
    try {
      await proxyApi.deleteHost(id);
      toast.success('Proxy host deleted');
      load();
    } catch { toast.error('Failed to delete'); }
  };

  const handleToggle = async (id: number) => {
    try {
      const result = await proxyApi.toggleHost(id);
      toast.success(result.enabled ? 'Enabled' : 'Disabled');
      load();
    } catch { toast.error('Failed to toggle'); }
  };

  if (loading) return <div className="flex items-center justify-center h-full"><div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" /></div>;

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-text-primary flex items-center gap-2"><Globe size={20} /> Proxy Hosts</h1>
        <div className="flex gap-2">
          <button onClick={startCreate} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover">
            <Plus size={14} /> Add Proxy Host
          </button>
          <button onClick={load} className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      {/* Editor modal */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-20 bg-black/50" onClick={() => setEditing(null)}>
          <div className="rounded-xl border border-border bg-bg-primary w-full max-w-2xl max-h-[80vh] overflow-auto shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-border">
              <h2 className="text-sm font-semibold text-text-primary">{editId ? 'Edit' : 'New'} Proxy Host</h2>
            </div>
            <div className="p-6 space-y-5">
              {/* Domains */}
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
                  <input value={domainInput} onChange={e => setDomainInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addDomain())}
                    placeholder="example.com" className="flex-1 rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
                  <button onClick={addDomain} className="px-3 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">Add</button>
                </div>
              </div>

              {/* Forward to */}
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="text-xs font-medium text-text-secondary block mb-1.5">Scheme</label>
                  <select value={editing.forwardScheme || 'http'} onChange={e => setEditing(h => h ? { ...h, forwardScheme: e.target.value as 'http' | 'https' } : null)}
                    className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent">
                    <option value="http">http</option>
                    <option value="https">https</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-text-secondary block mb-1.5">Forward Host</label>
                  <input value={editing.forwardHost || ''} onChange={e => setEditing(h => h ? { ...h, forwardHost: e.target.value } : null)}
                    placeholder="container_name or IP" className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
                </div>
                <div>
                  <label className="text-xs font-medium text-text-secondary block mb-1.5">Port</label>
                  <input type="number" value={editing.forwardPort || 80} onChange={e => setEditing(h => h ? { ...h, forwardPort: parseInt(e.target.value) || 80 } : null)}
                    className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
                </div>
              </div>

              {/* Certificate */}
              <div>
                <label className="text-xs font-medium text-text-secondary block mb-1.5">SSL Certificate</label>
                <div className="flex gap-2 mb-2">
                  {(['none', 'new', 'existing'] as const).map(mode => (
                    <button key={mode} onClick={() => {
                      setCertMode(mode);
                      if (mode === 'none') setEditing(h => h ? { ...h, certificateId: null, sslForced: false, http2Support: false, hstsEnabled: false, hstsSubdomains: false } : null);
                    }}
                      className={`flex-1 px-3 py-1.5 text-xs rounded-lg border transition-colors ${certMode === mode ? 'border-accent bg-accent/10 text-accent font-medium' : 'border-border text-text-muted hover:bg-bg-hover'}`}>
                      {mode === 'none' ? 'No SSL' : mode === 'new' ? 'Request Let\'s Encrypt' : 'Use Existing'}
                    </button>
                  ))}
                </div>
                {certMode === 'new' && (
                  <div className="space-y-2 p-3 rounded-lg border border-accent/20 bg-accent/5">
                    <div className="text-[10px] text-accent font-medium">A new Let's Encrypt certificate will be requested for the domains above</div>
                    <input value={acmeEmail} onChange={e => setAcmeEmail(e.target.value)} placeholder="admin@example.com" type="email"
                      className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
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
                        <button key={c.id} onClick={() => setEditing(h => h ? { ...h, certificateId: c.id, sslForced: true, http2Support: true } : null)}
                          className={`w-full text-left px-3 py-2 rounded-lg border text-xs transition-colors ${isSelected ? 'border-accent bg-accent/10' : isUsed ? 'border-status-down/30 bg-status-down/5 hover:bg-status-down/10' : 'border-border hover:bg-bg-hover'}`}>
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

              {/* Toggles */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  { key: 'sslForced', label: 'Force SSL', icon: Lock, requiresSsl: true },
                  { key: 'http2Support', label: 'HTTP/2', icon: Zap, requiresSsl: true },
                  { key: 'hstsEnabled', label: 'HSTS', icon: Shield, requiresSsl: true },
                  { key: 'hstsSubdomains', label: 'HSTS Subs', icon: Shield, requiresSsl: true },
                  { key: 'blockExploits', label: 'Block Exploits', icon: Shield, requiresSsl: false },
                  { key: 'cachingEnabled', label: 'Cache Assets', icon: Zap, requiresSsl: false },
                  { key: 'websocketSupport', label: 'WebSocket', icon: Zap, requiresSsl: false },
                  { key: 'gzipEnabled', label: 'Gzip', icon: Zap, requiresSsl: false },
                  { key: 'corsEnabled', label: 'CORS', icon: Globe, requiresSsl: false },
                ].map(({ key, label, icon: Icon, requiresSsl }) => {
                  const active = !!(editing as Record<string, unknown>)[key];
                  const disabled = requiresSsl && certMode === 'none';
                  return (
                    <button key={key} disabled={disabled}
                      onClick={() => { if (!disabled) setEditing(h => h ? { ...h, [key]: !active } : null); }}
                      className={`flex items-center gap-2 p-2 rounded-lg border transition-colors ${disabled ? 'border-border opacity-30 cursor-not-allowed' : active ? 'border-accent/50 bg-accent/10' : 'border-border hover:bg-bg-hover'}`}>
                      <div className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors shrink-0 ${active && !disabled ? 'bg-accent' : 'bg-bg-tertiary'}`}>
                        <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${active && !disabled ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                      </div>
                      <Icon size={12} className={active && !disabled ? 'text-accent' : 'text-text-muted'} />
                      <span className={`text-xs ${active && !disabled ? 'text-text-primary' : 'text-text-secondary'}`}>{label}</span>
                    </button>
                  );
                })}
              </div>

              {/* Access List */}
              <div>
                <label className="text-xs font-medium text-text-secondary block mb-1.5">Access List</label>
                <select value={editing.accessListId || ''} onChange={e => setEditing(h => h ? { ...h, accessListId: parseInt(e.target.value) || null } : null)}
                  className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent">
                  <option value="">No restriction</option>
                  {accessLists.map(al => <option key={al.id} value={al.id}>{al.name} ({al.clients.length} rules, {al.auth.length} users)</option>)}
                </select>
              </div>

              {/* Performance */}
              <div className="border-t border-border pt-4">
                <div className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">Performance</div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] text-text-muted block mb-1">Max Body Size</label>
                    <input value={editing.clientMaxBodySize || ''} onChange={e => setEditing(h => h ? { ...h, clientMaxBodySize: e.target.value || null } : null)}
                      placeholder="100m" className="w-full rounded border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
                  </div>
                  <div>
                    <label className="text-[10px] text-text-muted block mb-1">Connect Timeout (sec)</label>
                    <input type="number" value={editing.proxyConnectTimeout || ''} onChange={e => setEditing(h => h ? { ...h, proxyConnectTimeout: parseInt(e.target.value) || null } : null)}
                      placeholder="60" className="w-full rounded border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
                  </div>
                  <div>
                    <label className="text-[10px] text-text-muted block mb-1">Send Timeout (sec)</label>
                    <input type="number" value={editing.proxySendTimeout || ''} onChange={e => setEditing(h => h ? { ...h, proxySendTimeout: parseInt(e.target.value) || null } : null)}
                      placeholder="60" className="w-full rounded border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
                  </div>
                  <div>
                    <label className="text-[10px] text-text-muted block mb-1">Read Timeout (sec)</label>
                    <input type="number" value={editing.proxyReadTimeout || ''} onChange={e => setEditing(h => h ? { ...h, proxyReadTimeout: parseInt(e.target.value) || null } : null)}
                      placeholder="60" className="w-full rounded border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
                  </div>
                </div>
              </div>

              {/* Rate Limiting */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] text-text-muted block mb-1">Rate Limit (req/sec)</label>
                  <input type="number" value={editing.rateLimitRps || ''} onChange={e => setEditing(h => h ? { ...h, rateLimitRps: parseInt(e.target.value) || null } : null)}
                    placeholder="Off" className="w-full rounded border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
                </div>
                <div>
                  <label className="text-[10px] text-text-muted block mb-1">Rate Limit Burst</label>
                  <input type="number" value={editing.rateLimitBurst || ''} onChange={e => setEditing(h => h ? { ...h, rateLimitBurst: parseInt(e.target.value) || null } : null)}
                    placeholder="10" className="w-full rounded border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
                </div>
              </div>

              {/* Error Page */}
              <div>
                <label className="text-xs font-medium text-text-secondary block mb-1.5">Error Page</label>
                <select value={editing.errorPageId || ''} onChange={e => setEditing(h => h ? { ...h, errorPageId: parseInt(e.target.value) || null } : null)}
                  className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent">
                  <option value="">Use global default</option>
                  {customPages.map(p => <option key={p.id} value={p.id}>{p.name} ({p.errorCodes.join(', ')})</option>)}
                </select>
              </div>

              {/* Custom Response Headers */}
              <div>
                <label className="text-xs font-medium text-text-secondary block mb-1.5">Custom Response Headers</label>
                <div className="space-y-1.5 mb-2">
                  {(editing.customResponseHeaders || []).map((h, i) => (
                    <div key={i} className="flex gap-1.5 items-center">
                      <select value={h.action} onChange={e => { const headers = [...(editing.customResponseHeaders || [])]; headers[i] = { ...h, action: e.target.value as 'add' | 'remove' }; setEditing(ed => ed ? { ...ed, customResponseHeaders: headers } : null); }}
                        className="rounded border border-border bg-bg-tertiary px-1.5 py-0.5 text-[10px] text-text-primary w-16">
                        <option value="add">Add</option><option value="remove">Remove</option>
                      </select>
                      <input value={h.name} onChange={e => { const headers = [...(editing.customResponseHeaders || [])]; headers[i] = { ...h, name: e.target.value }; setEditing(ed => ed ? { ...ed, customResponseHeaders: headers } : null); }}
                        placeholder="Header-Name" className="flex-1 rounded border border-border bg-bg-tertiary px-2 py-0.5 text-xs font-mono text-text-primary" />
                      {h.action === 'add' && (
                        <input value={h.value} onChange={e => { const headers = [...(editing.customResponseHeaders || [])]; headers[i] = { ...h, value: e.target.value }; setEditing(ed => ed ? { ...ed, customResponseHeaders: headers } : null); }}
                          placeholder="value" className="flex-1 rounded border border-border bg-bg-tertiary px-2 py-0.5 text-xs font-mono text-text-primary" />
                      )}
                      <button onClick={() => { const headers = (editing.customResponseHeaders || []).filter((_, j) => j !== i); setEditing(ed => ed ? { ...ed, customResponseHeaders: headers.length ? headers : null } : null); }}
                        className="p-0.5 text-text-muted hover:text-status-down">&times;</button>
                    </div>
                  ))}
                </div>
                <button onClick={() => setEditing(ed => ed ? { ...ed, customResponseHeaders: [...(ed.customResponseHeaders || []), { name: '', value: '', action: 'add' as const }] } : null)}
                  className="text-xs text-accent hover:text-accent-hover">+ Add header</button>
              </div>

              {/* Advanced config */}
              <div>
                <label className="text-xs font-medium text-text-secondary block mb-1.5">Custom Nginx Configuration</label>
                <textarea value={editing.advancedConfig || ''} onChange={e => setEditing(h => h ? { ...h, advancedConfig: e.target.value } : null)}
                  rows={4} spellCheck={false} placeholder="# Custom nginx directives..."
                  className="w-full rounded-lg border border-border bg-[#0d1117] px-3 py-2 text-xs font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent resize-none" />
              </div>
            </div>
            <div className="px-6 py-4 border-t border-border flex justify-end gap-2">
              <button onClick={() => { setEditing(null); setEditId(null); }} className="px-4 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">Cancel</button>
              <button onClick={handleSave} className="px-4 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover">Save</button>
            </div>
          </div>
        </div>
      )}

      {/* Hosts list */}
      {hosts.length === 0 ? (
        <div className="text-center py-20">
          <Globe size={40} className="mx-auto mb-3 text-text-muted" />
          <p className="text-text-muted">No proxy hosts configured</p>
          <button onClick={startCreate} className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover">
            <Plus size={14} /> Add Proxy Host
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {hosts.map(host => (
            <div key={host.id} className={`rounded-xl border bg-bg-secondary overflow-hidden ${host.enabled ? 'border-border' : 'border-border opacity-50'}`}>
              <div className="px-4 py-3 flex items-center gap-4">
                <div className={`h-2.5 w-2.5 rounded-full shrink-0 ${host.enabled ? (host.certificate?.status === 'valid' ? 'bg-status-up' : 'bg-status-pending') : 'bg-text-muted'}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5 mb-0.5">
                    {host.domainNames.map(d => (
                      <span key={d} className="text-sm font-medium text-text-primary">{d}</span>
                    ))}
                  </div>
                  <div className="text-xs text-text-muted">
                    {host.forwardScheme}://{host.forwardHost}:{host.forwardPort}
                  </div>
                </div>
                <div className="flex flex-wrap gap-1">
                  {host.sslForced && <span className="text-[9px] px-1.5 py-0.5 rounded bg-status-up/10 text-status-up">SSL</span>}
                  {host.http2Support && <span className="text-[9px] px-1.5 py-0.5 rounded bg-accent/10 text-accent">H2</span>}
                  {host.hstsEnabled && <span className="text-[9px] px-1.5 py-0.5 rounded bg-accent/10 text-accent">HSTS</span>}
                  {host.websocketSupport && <span className="text-[9px] px-1.5 py-0.5 rounded bg-accent/10 text-accent">WS</span>}
                  {host.blockExploits && <span className="text-[9px] px-1.5 py-0.5 rounded bg-status-pending/10 text-status-pending">Protected</span>}
                  {host.cachingEnabled && <span className="text-[9px] px-1.5 py-0.5 rounded bg-accent/10 text-accent">Cached</span>}
                  {host.certificate && (
                    <span className={`text-[9px] px-1.5 py-0.5 rounded ${host.certificate.status === 'valid' ? 'bg-status-up/10 text-status-up' : 'bg-status-down/10 text-status-down'}`}>
                      {host.certificate.provider === 'letsencrypt' ? 'LE' : 'Custom'} {host.certificate.status}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button onClick={() => startEdit(host)} className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover" title="Edit">
                    <Edit2 size={14} />
                  </button>
                  <button onClick={() => handleToggle(host.id)} className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover" title={host.enabled ? 'Disable' : 'Enable'}>
                    {host.enabled ? <Power size={14} /> : <PowerOff size={14} />}
                  </button>
                  <button onClick={() => handleDelete(host.id)} className="p-1.5 rounded-md text-text-muted hover:text-status-down hover:bg-bg-hover" title="Delete">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
