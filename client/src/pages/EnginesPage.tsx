import { useEffect, useState } from 'react';
import { Plus, Server, RefreshCw, Trash2, Edit2, CheckCircle2, XCircle, Star, Copy, Terminal } from 'lucide-react';
import { enginesApi, type EngineWriteData, type TestResult } from '@/api/engines.api';
import type { DockerEngine, DockerEngineType } from '@oblihub/shared';
import toast from 'react-hot-toast';

const TYPE_LABELS: Record<DockerEngineType, string> = {
  'local': 'Local socket',
  'ssh': 'SSH',
  'https-apikey': 'HTTP + API key (socket-proxy)',
  'tls': 'TLS (mTLS)',
};

const EMPTY: EngineWriteData = {
  name: '',
  type: 'ssh',
  host: '',
  port: 22,
  sshUser: 'root',
  sshPrivateKey: '',
  apiKey: '',
  apiKeyHeader: 'X-API-Key',
  tlsCa: '',
  tlsCert: '',
  tlsKey: '',
  enabled: true,
};

export function EnginesPage() {
  const [engines, setEngines] = useState<DockerEngine[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<EngineWriteData | null>(null);
  const [editId, setEditId] = useState<number | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showQuickSetup, setShowQuickSetup] = useState(false);

  const load = async () => {
    try { setEngines(await enginesApi.list()); }
    catch { toast.error('Failed to load engines'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const startCreate = () => { setEditing({ ...EMPTY }); setEditId(null); setTestResult(null); };
  const startEdit = (e: DockerEngine) => {
    setEditing({
      name: e.name,
      type: e.type,
      host: e.host ?? '',
      port: e.port ?? undefined,
      sshUser: e.sshUser ?? '',
      sshPrivateKey: '', // leave blank to keep existing
      sshKnownHost: e.sshKnownHost ?? '',
      apiKey: '',
      apiKeyHeader: e.apiKeyHeader ?? 'X-API-Key',
      tlsCa: e.tlsCa ?? '',
      tlsCert: e.tlsCert ?? '',
      tlsKey: '',
      enabled: e.enabled,
    });
    setEditId(e.id);
    setTestResult(null);
  };

  const cleanForApi = (data: EngineWriteData): EngineWriteData => {
    // Strip empty secrets on edit (preserve existing on the server).
    const out = { ...data };
    if (editId) {
      if (!out.sshPrivateKey) delete out.sshPrivateKey;
      if (!out.apiKey) delete out.apiKey;
      if (!out.tlsKey) delete out.tlsKey;
    }
    return out;
  };

  const handleTest = async () => {
    if (!editing) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = editId
        ? await enginesApi.testExisting(editId)
        : await enginesApi.testTransient(cleanForApi(editing));
      setTestResult(result);
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : 'Test failed' });
    } finally { setTesting(false); }
  };

  const handleSave = async () => {
    if (!editing) return;
    if (!editing.name.trim()) { toast.error('Name required'); return; }
    setSaving(true);
    try {
      if (editId) await enginesApi.update(editId, cleanForApi(editing));
      else await enginesApi.create(cleanForApi(editing));
      toast.success('Saved');
      setEditing(null); setEditId(null);
      load();
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Save failed';
      toast.error(msg);
    } finally { setSaving(false); }
  };

  const handleDelete = async (e: DockerEngine) => {
    if (e.isDefault) { toast.error('Cannot delete the default engine'); return; }
    if (!confirm(`Delete engine "${e.name}"? Stacks/containers attached to it will become orphaned (kept but no longer polled).`)) return;
    try { await enginesApi.delete(e.id); toast.success('Deleted'); load(); }
    catch (err) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Delete failed';
      toast.error(msg);
    }
  };

  const handleSetDefault = async (e: DockerEngine) => {
    try { await enginesApi.setDefault(e.id); toast.success(`${e.name} is now the default engine`); load(); }
    catch { toast.error('Failed to set default'); }
  };

  if (loading) return <div className="flex items-center justify-center h-full"><div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" /></div>;

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-text-primary flex items-center gap-2"><Server size={20} /> Docker Engines</h1>
        <div className="flex gap-2">
          <button onClick={() => setShowQuickSetup(true)} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">
            <Terminal size={14} /> Quick setup (socket-proxy)
          </button>
          <button onClick={startCreate} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover">
            <Plus size={14} /> Add Engine
          </button>
          <button onClick={load} className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      <p className="text-xs text-text-muted mb-4">
        Connect remote Docker daemons (Unraid, other VPS, edge boxes…) so Oblihub can manage them
        from this single instance. Pair this with Tailscale or any VPN for secure connectivity.
      </p>

      <div className="rounded-xl border border-border bg-bg-secondary overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-bg-tertiary text-text-muted text-[11px] uppercase tracking-wider">
            <tr>
              <th className="text-left px-4 py-2 font-medium">Name</th>
              <th className="text-left px-4 py-2 font-medium">Type</th>
              <th className="text-left px-4 py-2 font-medium">Endpoint</th>
              <th className="text-left px-4 py-2 font-medium">Last ping</th>
              <th className="text-right px-4 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {engines.map(e => (
              <tr key={e.id} className="hover:bg-bg-hover">
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-1.5">
                    <span className="text-text-primary font-medium">{e.name}</span>
                    {e.isDefault && <Star size={11} className="text-accent fill-accent" aria-label="Default" />}
                    {!e.enabled && <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-tertiary text-text-muted">disabled</span>}
                  </div>
                </td>
                <td className="px-4 py-2.5 text-text-muted">{TYPE_LABELS[e.type]}</td>
                <td className="px-4 py-2.5 font-mono text-xs text-text-muted">
                  {e.type === 'local' ? '/var/run/docker.sock' : `${e.host}${e.port ? ':' + e.port : ''}`}
                </td>
                <td className="px-4 py-2.5 text-xs">
                  {e.lastPingStatus === 'ok' ? (
                    <span className="inline-flex items-center gap-1 text-status-up"><CheckCircle2 size={11} /> ok</span>
                  ) : e.lastPingStatus === 'error' ? (
                    <span className="inline-flex items-center gap-1 text-status-down" title={e.lastPingMessage || ''}><XCircle size={11} /> error</span>
                  ) : (
                    <span className="text-text-muted">—</span>
                  )}
                  {e.lastPingAt && <span className="text-text-muted ml-2 text-[10px]">{new Date(e.lastPingAt).toLocaleString()}</span>}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <button onClick={() => enginesApi.testExisting(e.id).then(r => { toast[r.ok ? 'success' : 'error'](r.ok ? `Connected: Docker ${r.serverVersion}` : (r.message || 'Failed')); load(); })}
                    className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover" title="Test connection">
                    <RefreshCw size={13} />
                  </button>
                  {!e.isDefault && (
                    <button onClick={() => handleSetDefault(e)} className="p-1 rounded text-text-muted hover:text-accent hover:bg-bg-hover" title="Set as default">
                      <Star size={13} />
                    </button>
                  )}
                  <button onClick={() => startEdit(e)} className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover" title="Edit">
                    <Edit2 size={13} />
                  </button>
                  {!e.isDefault && (
                    <button onClick={() => handleDelete(e)} className="p-1 rounded text-text-muted hover:text-status-down hover:bg-bg-hover" title="Delete">
                      <Trash2 size={13} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {engines.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-10 text-center text-text-muted text-sm">No engines configured</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Edit / create modal */}
      {editing && (
        <EngineEditor
          editing={editing}
          editId={editId}
          testResult={testResult}
          testing={testing}
          saving={saving}
          onChange={setEditing}
          onTest={handleTest}
          onSave={handleSave}
          onCancel={() => { setEditing(null); setEditId(null); setTestResult(null); }}
        />
      )}

      {/* Quick setup wizard */}
      {showQuickSetup && <QuickSetupModal onClose={() => setShowQuickSetup(false)} onCreated={() => { setShowQuickSetup(false); load(); }} />}
    </div>
  );
}

// ─── Editor modal ──────────────────────────────────────────────────────────
function EngineEditor({
  editing, editId, testResult, testing, saving,
  onChange, onTest, onSave, onCancel,
}: {
  editing: EngineWriteData;
  editId: number | null;
  testResult: TestResult | null;
  testing: boolean;
  saving: boolean;
  onChange: (d: EngineWriteData) => void;
  onTest: () => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const update = (patch: Partial<EngineWriteData>) => onChange({ ...editing, ...patch });

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-10 bg-black/50" onClick={onCancel}>
      <div className="rounded-xl border border-border bg-bg-primary w-full max-w-2xl max-h-[85vh] overflow-auto shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-border flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text-primary">{editId ? 'Edit' : 'New'} Docker Engine</h2>
          <button onClick={onCancel} className="text-text-muted hover:text-text-primary text-xl leading-none">&times;</button>
        </div>
        <div className="p-6 space-y-4">

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-text-secondary block mb-1.5">Name</label>
              <input value={editing.name} onChange={e => update({ name: e.target.value })} placeholder="e.g. Unraid - homelab"
                className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
            </div>
            <div>
              <label className="text-xs font-medium text-text-secondary block mb-1.5">Type</label>
              <select value={editing.type} onChange={e => update({ type: e.target.value as DockerEngineType })} disabled={!!editId}
                className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-60">
                <option value="local">Local socket (this host)</option>
                <option value="ssh">SSH</option>
                <option value="https-apikey">HTTP + API key (socket-proxy)</option>
                <option value="tls">TLS (mTLS, raw Docker TCP)</option>
              </select>
            </div>
          </div>

          {editing.type !== 'local' && (
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <label className="text-xs font-medium text-text-secondary block mb-1.5">Host</label>
                <input value={editing.host || ''} onChange={e => update({ host: e.target.value })} placeholder="100.64.10.5 or unraid.tailnet.ts.net"
                  className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
              </div>
              <div>
                <label className="text-xs font-medium text-text-secondary block mb-1.5">Port</label>
                <input type="number" value={editing.port || ''} onChange={e => update({ port: parseInt(e.target.value) || undefined })}
                  placeholder={editing.type === 'ssh' ? '22' : editing.type === 'tls' ? '2376' : '2375'}
                  className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
              </div>
            </div>
          )}

          {editing.type === 'ssh' && (
            <>
              <div>
                <label className="text-xs font-medium text-text-secondary block mb-1.5">SSH User</label>
                <input value={editing.sshUser || ''} onChange={e => update({ sshUser: e.target.value })} placeholder="root or oblihub-remote"
                  className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
              </div>
              <div>
                <label className="text-xs font-medium text-text-secondary block mb-1.5">
                  Private key (OpenSSH or PEM) {editId && <span className="text-text-muted">— leave blank to keep existing</span>}
                </label>
                <textarea value={editing.sshPrivateKey || ''} onChange={e => update({ sshPrivateKey: e.target.value })}
                  rows={6} spellCheck={false}
                  placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----'}
                  className="w-full rounded-lg border border-border bg-[#0d1117] px-3 py-2 text-xs font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent resize-none" />
              </div>
              <div>
                <label className="text-xs font-medium text-text-secondary block mb-1.5">Known host (optional)</label>
                <input value={editing.sshKnownHost || ''} onChange={e => update({ sshKnownHost: e.target.value })} placeholder="ssh-ed25519 AAAA... (paste from server)"
                  className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-xs font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
              </div>
            </>
          )}

          {editing.type === 'https-apikey' && (
            <>
              <div>
                <label className="text-xs font-medium text-text-secondary block mb-1.5">
                  API key {editId && <span className="text-text-muted">— leave blank to keep existing</span>}
                </label>
                <input value={editing.apiKey || ''} onChange={e => update({ apiKey: e.target.value })} placeholder="random secret value"
                  className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
              </div>
              <div>
                <label className="text-xs font-medium text-text-secondary block mb-1.5">Header name</label>
                <input value={editing.apiKeyHeader || ''} onChange={e => update({ apiKeyHeader: e.target.value })} placeholder="X-API-Key"
                  className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
              </div>
              <div className="rounded-lg border border-border bg-bg-tertiary/30 p-2.5 text-[11px] text-text-muted">
                Use this with <code className="bg-bg-tertiary px-1 rounded">tecnativa/docker-socket-proxy</code> on the remote host.
                Click <strong>Quick setup</strong> from the page header to generate the install snippet.
              </div>
            </>
          )}

          {editing.type === 'tls' && (
            <>
              <div>
                <label className="text-xs font-medium text-text-secondary block mb-1.5">CA certificate (PEM)</label>
                <textarea value={editing.tlsCa || ''} onChange={e => update({ tlsCa: e.target.value })} rows={4} spellCheck={false}
                  placeholder="-----BEGIN CERTIFICATE-----"
                  className="w-full rounded-lg border border-border bg-[#0d1117] px-3 py-2 text-xs font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent resize-none" />
              </div>
              <div>
                <label className="text-xs font-medium text-text-secondary block mb-1.5">Client certificate (PEM)</label>
                <textarea value={editing.tlsCert || ''} onChange={e => update({ tlsCert: e.target.value })} rows={4} spellCheck={false}
                  placeholder="-----BEGIN CERTIFICATE-----"
                  className="w-full rounded-lg border border-border bg-[#0d1117] px-3 py-2 text-xs font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent resize-none" />
              </div>
              <div>
                <label className="text-xs font-medium text-text-secondary block mb-1.5">
                  Client private key {editId && <span className="text-text-muted">— leave blank to keep existing</span>}
                </label>
                <textarea value={editing.tlsKey || ''} onChange={e => update({ tlsKey: e.target.value })} rows={4} spellCheck={false}
                  placeholder="-----BEGIN PRIVATE KEY-----"
                  className="w-full rounded-lg border border-border bg-[#0d1117] px-3 py-2 text-xs font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent resize-none" />
              </div>
            </>
          )}

          {testResult && (
            <div className={`rounded-lg border p-3 text-xs ${testResult.ok ? 'border-status-up/30 bg-status-up/5 text-status-up' : 'border-status-down/30 bg-status-down/5 text-status-down'}`}>
              {testResult.ok ? <CheckCircle2 size={13} className="inline mr-1" /> : <XCircle size={13} className="inline mr-1" />}
              {testResult.ok ? `Connected — Docker ${testResult.serverVersion}` : testResult.message}
            </div>
          )}

          <label className="flex items-center gap-2 text-xs text-text-secondary">
            <input type="checkbox" checked={editing.enabled !== false} onChange={e => update({ enabled: e.target.checked })} className="rounded" />
            Enabled (Oblihub workers will poll this engine)
          </label>
        </div>
        <div className="px-6 py-4 border-t border-border flex justify-end gap-2">
          <button onClick={onCancel} className="px-4 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">Cancel</button>
          <button onClick={onTest} disabled={testing} className="px-4 py-1.5 text-sm rounded-lg border border-accent text-accent hover:bg-accent/10 disabled:opacity-50">
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          <button onClick={onSave} disabled={saving} className="px-4 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover disabled:opacity-50">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Quick setup wizard (socket-proxy) ─────────────────────────────────────
function QuickSetupModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [step, setStep] = useState<'config' | 'install' | 'finish'>('config');
  const [name, setName] = useState('Unraid');
  const [host, setHost] = useState('');
  const [port, setPort] = useState(2375);
  const [apiKey, setApiKey] = useState(() => crypto.getRandomValues(new Uint8Array(24)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), ''));
  const [saving, setSaving] = useState(false);

  const snippet = `docker run -d --restart=unless-stopped --name oblihub-engine-proxy \\
  -p ${port}:2375 \\
  -v /var/run/docker.sock:/var/run/docker.sock:ro \\
  -e CONTAINERS=1 -e POST=1 -e IMAGES=1 -e EXEC=1 \\
  -e INFO=1 -e VERSION=1 -e PING=1 \\
  -e NETWORKS=0 -e VOLUMES=0 -e SECRETS=0 -e CONFIGS=0 \\
  -e API_KEY=${apiKey} \\
  tecnativa/docker-socket-proxy`;

  const copySnippet = () => { navigator.clipboard.writeText(snippet); toast.success('Copied'); };

  const handleCreate = async () => {
    if (!name.trim() || !host.trim()) { toast.error('Name and host required'); return; }
    setSaving(true);
    try {
      const created = await enginesApi.create({ name, type: 'https-apikey', host, port, apiKey, apiKeyHeader: 'X-API-Key', enabled: true });
      // Test it
      const result = await enginesApi.testExisting(created.id);
      toast[result.ok ? 'success' : 'error'](result.ok ? `Engine ready — Docker ${result.serverVersion}` : `Saved but connection failed: ${result.message}`);
      onCreated();
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Failed';
      toast.error(msg);
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-10 bg-black/50" onClick={onClose}>
      <div className="rounded-xl border border-border bg-bg-primary w-full max-w-2xl max-h-[85vh] overflow-auto shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-border flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2"><Terminal size={14} /> Quick setup — socket-proxy</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">&times;</button>
        </div>
        <div className="p-6 space-y-4">
          {step === 'config' && (
            <>
              <p className="text-xs text-text-muted">
                The fastest way to add a remote engine. Oblihub will generate an install snippet for
                <code className="bg-bg-tertiary px-1 rounded mx-0.5">tecnativa/docker-socket-proxy</code>
                — a tiny container that exposes a filtered, API-key-protected Docker socket over HTTP.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-text-secondary block mb-1.5">Engine name</label>
                  <input value={name} onChange={e => setName(e.target.value)} placeholder="Unraid"
                    className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
                </div>
                <div>
                  <label className="text-xs font-medium text-text-secondary block mb-1.5">Port (on remote)</label>
                  <input type="number" value={port} onChange={e => setPort(parseInt(e.target.value) || 2375)}
                    className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-text-secondary block mb-1.5">Host (reachable from Oblihub)</label>
                <input value={host} onChange={e => setHost(e.target.value)} placeholder="100.64.10.5 or unraid.tailnet.ts.net"
                  className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
                <p className="text-[11px] text-text-muted mt-1">Tip: use the Tailscale/WireGuard private IP, not the public one — the socket-proxy MUST be unreachable from the internet.</p>
              </div>
              <div className="flex justify-end">
                <button onClick={() => setStep('install')} disabled={!name.trim() || !host.trim()}
                  className="px-4 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover disabled:opacity-50">Next: install snippet →</button>
              </div>
            </>
          )}

          {step === 'install' && (
            <>
              <p className="text-xs text-text-muted">
                Run this on the remote host (Unraid: open the terminal from the web UI). The API key is generated and shown only once.
              </p>
              <div className="relative">
                <pre className="bg-[#0d1117] rounded-lg p-3 text-[11px] font-mono text-text-primary overflow-x-auto whitespace-pre">{snippet}</pre>
                <button onClick={copySnippet} className="absolute top-2 right-2 p-1.5 rounded bg-bg-tertiary hover:bg-bg-hover text-text-muted" title="Copy">
                  <Copy size={12} />
                </button>
              </div>
              <div className="rounded-lg border border-status-pending/30 bg-status-pending/5 p-2.5 text-[11px] text-status-pending">
                <strong>API key:</strong> <code className="bg-bg-tertiary px-1 rounded font-mono">{apiKey}</code> — save it now, you cannot recover it.
              </div>
              <div className="flex justify-between">
                <button onClick={() => setStep('config')} className="px-4 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">← Back</button>
                <button onClick={handleCreate} disabled={saving}
                  className="px-4 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover disabled:opacity-50">
                  {saving ? 'Saving + testing…' : 'I ran it — Save engine'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
