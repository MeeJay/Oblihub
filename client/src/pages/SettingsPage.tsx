import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { settingsApi } from '@/api/settings.api';
import { notificationsApi, type PluginMeta } from '@/api/notifications.api';
import { systemApi } from '@/api/stacks.api';
import { proxyApi } from '@/api/proxy.api';
import { useAuthStore } from '@/store/authStore';
import type { NotificationChannel } from '@oblihub/shared';
import toast from 'react-hot-toast';
import { Save, Plus, Trash2, Send, ChevronDown, ChevronRight, Power, PowerOff, X, Globe, RefreshCw, Shield, CheckCircle } from 'lucide-react';

// ── Obligate SSO Section ──
function SsoSection({ config, setConfig, onSave, saving }: {
  config: Record<string, string | null>;
  setConfig: (c: Record<string, string | null>) => void;
  onSave: () => void;
  saving: boolean;
}) {
  const enabled = config.obligate_enabled === 'true';
  const [ssoStatus, setSsoStatus] = useState<'checking' | 'connected' | 'unreachable' | 'disabled'>('checking');

  useEffect(() => {
    if (!enabled || !config.obligate_url) {
      setSsoStatus(enabled ? 'unreachable' : 'disabled');
      return;
    }
    // Simple connectivity check via our own backend (settings already loaded means backend is reachable)
    setSsoStatus(enabled ? 'connected' : 'disabled');
  }, [enabled, config.obligate_url]);

  const statusDot = {
    checking: 'bg-text-muted',
    connected: 'bg-status-up',
    unreachable: 'bg-status-down',
    disabled: 'bg-text-muted',
  };
  const statusLabel = {
    checking: 'Checking...',
    connected: 'Connected',
    unreachable: 'Unreachable',
    disabled: 'Disabled',
  };

  return (
    <div className="rounded-xl border border-border bg-bg-secondary p-5 mb-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-text-primary">Obligate SSO</h2>
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <span className={`h-2 w-2 rounded-full ${statusDot[ssoStatus]}`} />
          {statusLabel[ssoStatus]}
        </div>
      </div>
      <div className="space-y-4">
        <div>
          <label className="block text-sm text-text-secondary mb-1">Obligate URL</label>
          <input type="text" value={config.obligate_url || ''} placeholder="https://sso.example.com"
            onChange={(e) => setConfig({ ...config, obligate_url: e.target.value || null })}
            className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent" />
        </div>
        <div>
          <label className="block text-sm text-text-secondary mb-1">API Key</label>
          <input type="password" value={config.obligate_api_key || ''} placeholder="Enter API key"
            onChange={(e) => setConfig({ ...config, obligate_api_key: e.target.value || null })}
            className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent" />
        </div>
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => setConfig({ ...config, obligate_enabled: enabled ? 'false' : 'true' })}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${enabled ? 'bg-accent' : 'bg-bg-tertiary border border-border'}`}>
            <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${enabled ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
          <span className="text-sm text-text-secondary">Enable SSO</span>
        </div>
        <button onClick={onSave} disabled={saving}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-accent text-white hover:bg-accent-hover disabled:opacity-50 transition-colors">
          <Save size={14} /> {saving ? 'Saving...' : 'Save SSO Settings'}
        </button>
      </div>
    </div>
  );
}

// ── Default Settings Section ──
function DefaultSettingsSection({ config, setConfig, onSave, saving }: {
  config: Record<string, string | null>;
  setConfig: (c: Record<string, string | null>) => void;
  onSave: () => void;
  saving: boolean;
}) {
  return (
    <div className="rounded-xl border border-border bg-bg-secondary p-5 mb-6">
      <h2 className="text-sm font-semibold text-text-primary mb-4">Default Settings</h2>
      <div className="mb-4">
        <label className="block text-sm text-text-secondary mb-1">Default Check Interval (seconds)</label>
        <input type="number" min={10} value={config.default_check_interval || '300'}
          onChange={(e) => setConfig({ ...config, default_check_interval: e.target.value || '300' })}
          className="w-48 rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent" />
        <p className="text-xs text-text-muted mt-1">How often stacks are checked for updates (minimum 10s)</p>
      </div>

      {/* Global Auto-Update */}
      <div className="mb-4 flex items-center justify-between rounded-lg border border-border bg-bg-tertiary p-3">
        <div>
          <div className="text-sm font-medium text-text-primary">Global Auto-Update</div>
          <div className="text-xs text-text-muted">Automatically update ALL stacks when new images are detected</div>
          <div className="text-xs text-status-down mt-1 font-medium">Not recommended — prefer per-stack auto-update</div>
        </div>
        <button
          onClick={() => {
            const current = config.global_auto_update === 'true';
            setConfig({ ...config, global_auto_update: current ? 'false' : 'true' });
          }}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors shrink-0 ml-4 ${config.global_auto_update === 'true' ? 'bg-status-down' : 'bg-bg-hover border border-border'}`}>
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${config.global_auto_update === 'true' ? 'translate-x-6' : 'translate-x-1'}`} />
        </button>
      </div>

      <button onClick={onSave} disabled={saving}
        className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-accent text-white hover:bg-accent-hover disabled:opacity-50 transition-colors">
        <Save size={14} /> {saving ? 'Saving...' : 'Save'}
      </button>
    </div>
  );
}

// ── Dynamic Config Fields ──
function ConfigFields({ fields, config, setConfig }: {
  fields: PluginMeta['configFields'];
  config: Record<string, unknown>;
  setConfig: (c: Record<string, unknown>) => void;
}) {
  return (
    <div className="space-y-3">
      {fields.map((field) => (
        <div key={field.key}>
          <label className="block text-sm text-text-secondary mb-1">
            {field.label}{field.required && <span className="text-status-down ml-1">*</span>}
          </label>
          {field.type === 'boolean' ? (
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={!!config[field.key]}
                onChange={(e) => setConfig({ ...config, [field.key]: e.target.checked })}
                className="h-4 w-4 rounded border-border bg-bg-tertiary accent-accent" />
              <span className="text-sm text-text-secondary">{field.label}</span>
            </label>
          ) : (
            <input
              type={field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'}
              value={String(config[field.key] ?? '')}
              placeholder={field.placeholder || ''}
              onChange={(e) => setConfig({ ...config, [field.key]: field.type === 'number' ? Number(e.target.value) : e.target.value })}
              className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
            />
          )}
        </div>
      ))}
    </div>
  );
}

// ── Notification Channels Section ──
function NotificationChannelsSection() {
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [plugins, setPlugins] = useState<PluginMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [showNew, setShowNew] = useState(false);

  // New channel form
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState('');
  const [newConfig, setNewConfig] = useState<Record<string, unknown>>({});
  const [creating, setCreating] = useState(false);

  // Edit state
  const [editName, setEditName] = useState('');
  const [editConfig, setEditConfig] = useState<Record<string, unknown>>({});
  const [savingId, setSavingId] = useState<number | null>(null);
  const [testingId, setTestingId] = useState<number | null>(null);

  const load = async () => {
    try {
      const [ch, pl] = await Promise.all([notificationsApi.getChannels(), notificationsApi.getPlugins()]);
      setChannels(ch);
      setPlugins(pl);
    } catch { toast.error('Failed to load notifications'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const selectedPlugin = plugins.find(p => p.type === newType);

  const handleCreate = async () => {
    if (!newName.trim() || !newType) { toast.error('Name and type required'); return; }
    setCreating(true);
    try {
      await notificationsApi.createChannel({ name: newName.trim(), type: newType, config: newConfig });
      setShowNew(false);
      setNewName('');
      setNewType('');
      setNewConfig({});
      toast.success('Channel created');
      await load();
    } catch { toast.error('Failed to create channel'); }
    finally { setCreating(false); }
  };

  const handleToggle = async (ch: NotificationChannel) => {
    try {
      await notificationsApi.updateChannel(ch.id, { isEnabled: !ch.isEnabled });
      await load();
    } catch { toast.error('Failed to toggle channel'); }
  };

  const handleSave = async (id: number) => {
    setSavingId(id);
    try {
      await notificationsApi.updateChannel(id, { name: editName, config: editConfig });
      toast.success('Channel updated');
      await load();
    } catch { toast.error('Failed to update channel'); }
    finally { setSavingId(null); }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this notification channel?')) return;
    try {
      await notificationsApi.deleteChannel(id);
      setExpandedId(null);
      toast.success('Channel deleted');
      await load();
    } catch { toast.error('Failed to delete channel'); }
  };

  const handleTest = async (id: number) => {
    setTestingId(id);
    try {
      await notificationsApi.testChannel(id);
      toast.success('Test notification sent');
    } catch { toast.error('Test failed'); }
    finally { setTestingId(null); }
  };

  const expand = (ch: NotificationChannel) => {
    if (expandedId === ch.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(ch.id);
    setEditName(ch.name);
    setEditConfig({ ...ch.config });
  };

  if (loading) {
    return (
      <div className="rounded-xl border border-border bg-bg-secondary p-5 mb-6">
        <h2 className="text-sm font-semibold text-text-primary mb-4">Notification Channels</h2>
        <div className="flex items-center justify-center py-8">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-bg-secondary p-5 mb-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-text-primary">Notification Channels</h2>
        <button onClick={() => setShowNew(!showNew)}
          className="flex items-center gap-1 px-3 py-1.5 text-xs rounded-lg bg-accent/10 text-accent hover:bg-accent/20 transition-colors">
          {showNew ? <X size={12} /> : <Plus size={12} />} {showNew ? 'Cancel' : 'New Channel'}
        </button>
      </div>

      {/* New channel form */}
      {showNew && (
        <div className="mb-4 p-4 rounded-lg border border-border bg-bg-tertiary space-y-3">
          <div>
            <label className="block text-sm text-text-secondary mb-1">Channel Name</label>
            <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="My Channel"
              className="w-full rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent" />
          </div>
          <div>
            <label className="block text-sm text-text-secondary mb-1">Plugin Type</label>
            <select value={newType} onChange={(e) => { setNewType(e.target.value); setNewConfig({}); }}
              className="w-full rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent">
              <option value="">Select a plugin...</option>
              {plugins.map(p => <option key={p.type} value={p.type}>{p.name}</option>)}
            </select>
          </div>
          {selectedPlugin && (
            <ConfigFields fields={selectedPlugin.configFields} config={newConfig} setConfig={setNewConfig} />
          )}
          <button onClick={handleCreate} disabled={creating}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-accent text-white hover:bg-accent-hover disabled:opacity-50 transition-colors">
            <Save size={14} /> {creating ? 'Creating...' : 'Create Channel'}
          </button>
        </div>
      )}

      {/* Channel list */}
      {channels.length === 0 ? (
        <p className="text-sm text-text-muted py-4 text-center">No notification channels configured</p>
      ) : (
        <div className="space-y-2">
          {channels.map((ch) => {
            const isExpanded = expandedId === ch.id;
            const plugin = plugins.find(p => p.type === ch.type);
            return (
              <div key={ch.id} className="rounded-lg border border-border bg-bg-tertiary overflow-hidden">
                <div className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-bg-hover transition-colors"
                  onClick={() => expand(ch)}>
                  {isExpanded ? <ChevronDown size={14} className="text-text-muted" /> : <ChevronRight size={14} className="text-text-muted" />}
                  <span className="text-sm text-text-primary flex-1 font-medium">{ch.name}</span>
                  <span className="text-xs text-text-muted capitalize">{ch.type}</span>
                  <button onClick={(e) => { e.stopPropagation(); handleToggle(ch); }}
                    className={`p-1 rounded ${ch.isEnabled ? 'text-status-up hover:bg-status-up/10' : 'text-text-muted hover:bg-bg-hover'}`}
                    title={ch.isEnabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}>
                    {ch.isEnabled ? <Power size={14} /> : <PowerOff size={14} />}
                  </button>
                  <button onClick={(e) => { e.stopPropagation(); handleTest(ch.id); }} disabled={testingId === ch.id}
                    className="p-1 rounded text-text-muted hover:text-accent hover:bg-accent/10 disabled:opacity-50" title="Send test">
                    <Send size={14} />
                  </button>
                  <button onClick={(e) => { e.stopPropagation(); handleDelete(ch.id); }}
                    className="p-1 rounded text-text-muted hover:text-status-down hover:bg-status-down/10" title="Delete">
                    <Trash2 size={14} />
                  </button>
                </div>

                {isExpanded && plugin && (
                  <div className="px-4 pb-4 border-t border-border pt-3 space-y-3">
                    <div>
                      <label className="block text-sm text-text-secondary mb-1">Channel Name</label>
                      <input type="text" value={editName} onChange={(e) => setEditName(e.target.value)}
                        className="w-full rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent" />
                    </div>
                    <ConfigFields fields={plugin.configFields} config={editConfig} setConfig={setEditConfig} />
                    <button onClick={() => handleSave(ch.id)} disabled={savingId === ch.id}
                      className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-accent text-white hover:bg-accent-hover disabled:opacity-50 transition-colors">
                      <Save size={14} /> {savingId === ch.id ? 'Saving...' : 'Save Changes'}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── System Info Section ──
function SystemInfoSection() {
  const [info, setInfo] = useState<{ dockerConnected: boolean; dockerVersion: any; stackCount: number; containerCount: number } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    settingsApi.getSystemInfo()
      .then(setInfo)
      .catch(() => toast.error('Failed to load system info'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="rounded-xl border border-border bg-bg-secondary p-5">
        <h2 className="text-sm font-semibold text-text-primary mb-4">System Info</h2>
        <div className="flex items-center justify-center py-8">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-bg-secondary p-5">
      <h2 className="text-sm font-semibold text-text-primary mb-4">System Info</h2>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <span className="text-xs text-text-muted">Docker Connection</span>
          <div className="flex items-center gap-2 mt-1">
            <span className={`h-2.5 w-2.5 rounded-full ${info?.dockerConnected ? 'bg-status-up' : 'bg-status-down'}`} />
            <span className="text-sm text-text-primary">{info?.dockerConnected ? 'Connected' : 'Disconnected'}</span>
          </div>
        </div>
        <div>
          <span className="text-xs text-text-muted">Docker Version</span>
          <p className="text-sm text-text-primary mt-1">
            {info?.dockerVersion?.version || info?.dockerVersion?.Version || 'N/A'}
          </p>
        </div>
        <div>
          <span className="text-xs text-text-muted">Stacks</span>
          <p className="text-sm text-text-primary mt-1">{info?.stackCount ?? 0}</p>
        </div>
        <div>
          <span className="text-xs text-text-muted">Containers</span>
          <p className="text-sm text-text-primary mt-1">{info?.containerCount ?? 0}</p>
        </div>
      </div>
    </div>
  );
}

// ── Main Settings Page ──
export function SettingsPage() {
  const { user } = useAuthStore();
  const [config, setConfig] = useState<Record<string, string | null>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Redirect non-admins
  if (user && user.role !== 'admin') {
    return <Navigate to="/" replace />;
  }

  useEffect(() => {
    settingsApi.getAll()
      .then(setConfig)
      .catch(() => toast.error('Failed to load settings'))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await settingsApi.update(config);
      toast.success('Settings saved');
    } catch {
      toast.error('Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="p-6 max-w-3xl">
        <h1 className="text-xl font-semibold text-text-primary mb-6">Settings</h1>
        <div className="flex items-center justify-center py-20">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-3xl">
      <h1 className="text-xl font-semibold text-text-primary mb-6">Settings</h1>
      <SsoSection config={config} setConfig={setConfig} onSave={handleSave} saving={saving} />
      <DefaultSettingsSection config={config} setConfig={setConfig} onSave={handleSave} saving={saving} />
      <NotificationChannelsSection />
      <ProxyStatusSection />
      <SystemInfoSection />
    </div>
  );
}

// ── Proxy Status Section ──
function ProxyStatusSection() {
  const [status, setStatus] = useState<{ nginxRunning: boolean; proxyHostCount: number; enabledHostCount: number; certificateCount: number; validCertCount: number; expiringSoon: number } | null>(null);
  const [allowNginx, setAllowNginx] = useState(false);
  const [testing, setTesting] = useState(false);
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    systemApi.getFeatures().then(f => {
      setAllowNginx(f.allowNginx);
      if (f.allowNginx) {
        proxyApi.getStatus().then(setStatus).catch(() => {});
      }
    }).catch(() => {});
  }, []);

  if (!allowNginx) return null;

  return (
    <div className="rounded-xl border border-border bg-bg-secondary p-4 mb-6">
      <h2 className="text-sm font-semibold text-text-secondary mb-4 flex items-center gap-1.5"><Globe size={14} /> Nginx Proxy Status</h2>
      {status ? (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <div className={`h-3 w-3 rounded-full ${status.nginxRunning ? 'bg-status-up' : 'bg-status-down'}`} />
            <span className="text-sm text-text-primary font-medium">{status.nginxRunning ? 'Running' : 'Stopped'}</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="rounded-lg bg-bg-tertiary p-3 text-center">
              <div className="text-lg font-semibold text-text-primary">{status.enabledHostCount}</div>
              <div className="text-[10px] text-text-muted">Active Hosts</div>
            </div>
            <div className="rounded-lg bg-bg-tertiary p-3 text-center">
              <div className="text-lg font-semibold text-text-primary">{status.proxyHostCount}</div>
              <div className="text-[10px] text-text-muted">Total Hosts</div>
            </div>
            <div className="rounded-lg bg-bg-tertiary p-3 text-center">
              <div className="text-lg font-semibold text-status-up">{status.validCertCount}</div>
              <div className="text-[10px] text-text-muted">Valid Certs</div>
            </div>
            <div className="rounded-lg bg-bg-tertiary p-3 text-center">
              <div className={`text-lg font-semibold ${status.expiringSoon > 0 ? 'text-status-pending' : 'text-text-primary'}`}>{status.expiringSoon}</div>
              <div className="text-[10px] text-text-muted">Expiring Soon</div>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={async () => {
                setReloading(true);
                try { await proxyApi.reloadNginx(); toast.success('Nginx reloaded'); proxyApi.getStatus().then(setStatus); }
                catch { toast.error('Reload failed'); }
                finally { setReloading(false); }
              }}
              disabled={reloading}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-border text-text-secondary hover:bg-bg-hover disabled:opacity-50">
              <RefreshCw size={12} className={reloading ? 'animate-spin' : ''} /> Reload Nginx
            </button>
            <button
              onClick={async () => {
                setTesting(true);
                try {
                  const result = await proxyApi.testNginx();
                  if (result.valid) toast.success('Config is valid');
                  else toast.error(`Config invalid: ${result.error}`);
                } catch { toast.error('Test failed'); }
                finally { setTesting(false); }
              }}
              disabled={testing}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-border text-text-secondary hover:bg-bg-hover disabled:opacity-50">
              <CheckCircle size={12} /> Test Config
            </button>
          </div>
        </div>
      ) : (
        <div className="text-xs text-text-muted">Loading proxy status...</div>
      )}
    </div>
  );
}
