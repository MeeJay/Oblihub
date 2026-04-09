import { useEffect, useState } from 'react';
import { RefreshCw, Trash2, Plus, Network, Link, Unlink, ChevronDown, ChevronRight, Eraser } from 'lucide-react';
import { dockerApi } from '@/api/docker.api';
import type { DockerNetwork } from '@oblihub/shared';
import toast from 'react-hot-toast';

export function NetworksPage() {
  const [networks, setNetworks] = useState<DockerNetwork[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [createForm, setCreateForm] = useState({ name: '', driver: 'bridge', subnet: '', gateway: '', internal: false, attachable: true });
  const [connectForm, setConnectForm] = useState<{ networkId: string; containerId: string } | null>(null);

  const load = async () => {
    try {
      setNetworks(await dockerApi.listNetworks());
    } catch { toast.error('Failed to load networks'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const toggleExpand = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handleCreate = async () => {
    if (!createForm.name.trim()) return;
    try {
      await dockerApi.createNetwork(createForm);
      toast.success(`Network ${createForm.name} created`);
      setCreateForm({ name: '', driver: 'bridge', subnet: '', gateway: '', internal: false, attachable: true });
      setShowCreate(false);
      load();
    } catch { toast.error('Failed to create network'); }
  };

  const handleRemove = async (net: DockerNetwork) => {
    if (!confirm(`Remove network "${net.name}"?`)) return;
    try {
      await dockerApi.removeNetwork(net.id);
      toast.success(`Network ${net.name} removed`);
      load();
    } catch { toast.error('Failed to remove network. It may be in use.'); }
  };

  const handleDisconnect = async (networkId: string, containerId: string, containerName: string) => {
    try {
      await dockerApi.disconnectNetwork(networkId, containerId);
      toast.success(`${containerName} disconnected`);
      load();
    } catch { toast.error('Failed to disconnect'); }
  };

  const handleConnect = async () => {
    if (!connectForm) return;
    try {
      await dockerApi.connectNetwork(connectForm.networkId, connectForm.containerId);
      toast.success('Container connected');
      setConnectForm(null);
      load();
    } catch { toast.error('Failed to connect container'); }
  };

  const isSystemNetwork = (name: string) => ['bridge', 'host', 'none'].includes(name);

  if (loading) return <div className="flex items-center justify-center h-full"><div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" /></div>;

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-text-primary flex items-center gap-2"><Network size={20} /> Networks</h1>
        <div className="flex gap-2">
          <button onClick={() => setShowCreate(v => !v)} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover">
            <Plus size={14} /> Create
          </button>
          <button
            onClick={async () => {
              if (!confirm('Remove all unused networks?')) return;
              try {
                const result = await dockerApi.pruneNetworks();
                toast.success(`Pruned ${result.deleted.length} network(s)`);
                load();
              } catch { toast.error('Prune failed'); }
            }}
            className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border border-status-down/30 text-status-down hover:bg-status-down/10">
            <Eraser size={14} /> Prune
          </button>
          <button onClick={load} className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="rounded-xl border border-border bg-bg-secondary p-4 mb-6 space-y-3">
          <h3 className="text-sm font-semibold text-text-secondary">Create Network</h3>
          <div className="grid grid-cols-2 gap-3">
            <input value={createForm.name} onChange={e => setCreateForm(f => ({ ...f, name: e.target.value }))} placeholder="Network name" className="rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
            <select value={createForm.driver} onChange={e => setCreateForm(f => ({ ...f, driver: e.target.value }))} className="rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent">
              <option value="bridge">bridge</option>
              <option value="overlay">overlay</option>
              <option value="macvlan">macvlan</option>
              <option value="ipvlan">ipvlan</option>
            </select>
            <input value={createForm.subnet} onChange={e => setCreateForm(f => ({ ...f, subnet: e.target.value }))} placeholder="Subnet (e.g. 172.20.0.0/16)" className="rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
            <input value={createForm.gateway} onChange={e => setCreateForm(f => ({ ...f, gateway: e.target.value }))} placeholder="Gateway (e.g. 172.20.0.1)" className="rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
          </div>
          <div className="flex items-center gap-4 text-xs">
            <label className="flex items-center gap-1.5 text-text-secondary cursor-pointer">
              <input type="checkbox" checked={createForm.internal} onChange={e => setCreateForm(f => ({ ...f, internal: e.target.checked }))} className="rounded" />
              Internal
            </label>
            <label className="flex items-center gap-1.5 text-text-secondary cursor-pointer">
              <input type="checkbox" checked={createForm.attachable} onChange={e => setCreateForm(f => ({ ...f, attachable: e.target.checked }))} className="rounded" />
              Attachable
            </label>
          </div>
          <div className="flex gap-2">
            <button onClick={handleCreate} className="px-4 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover">Create</button>
            <button onClick={() => setShowCreate(false)} className="px-4 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">Cancel</button>
          </div>
        </div>
      )}

      {/* Connect container modal */}
      {connectForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setConnectForm(null)}>
          <div className="rounded-xl border border-border bg-bg-secondary p-6 w-96 space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-text-primary">Connect Container to Network</h3>
            <input
              value={connectForm.containerId}
              onChange={e => setConnectForm(f => f ? { ...f, containerId: e.target.value } : null)}
              placeholder="Container ID or name"
              className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
            />
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConnectForm(null)} className="px-4 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">Cancel</button>
              <button onClick={handleConnect} className="px-4 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover">Connect</button>
            </div>
          </div>
        </div>
      )}

      {/* Networks list */}
      <div className="space-y-2">
        {networks.map((net) => (
          <div key={net.id} className="rounded-xl border border-border bg-bg-secondary overflow-hidden">
            <div className="px-4 py-3 flex items-center gap-3 cursor-pointer hover:bg-bg-hover/50" onClick={() => toggleExpand(net.id)}>
              {expanded.has(net.id) ? <ChevronDown size={14} className="text-text-muted" /> : <ChevronRight size={14} className="text-text-muted" />}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-text-primary">{net.name}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-tertiary text-text-muted">{net.driver}</span>
                  {net.internal && <span className="text-[10px] px-1.5 py-0.5 rounded bg-status-pending/10 text-status-pending">internal</span>}
                  {net.composeProject && <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent">{net.composeProject}</span>}
                </div>
                <div className="text-[10px] text-text-muted mt-0.5">
                  {net.id} &middot; {net.containers.length} container{net.containers.length !== 1 ? 's' : ''}
                  {net.ipam[0]?.subnet && <> &middot; {net.ipam[0].subnet}</>}
                </div>
              </div>
              {!isSystemNetwork(net.name) && (
                <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                  <button onClick={() => setConnectForm({ networkId: net.id, containerId: '' })} className="p-1.5 rounded-md text-text-muted hover:text-accent hover:bg-bg-hover" title="Connect container">
                    <Link size={14} />
                  </button>
                  <button onClick={() => handleRemove(net)} className="p-1.5 rounded-md text-text-muted hover:text-status-down hover:bg-bg-hover" title="Remove network">
                    <Trash2 size={14} />
                  </button>
                </div>
              )}
            </div>

            {/* Expanded: show containers */}
            {expanded.has(net.id) && net.containers.length > 0 && (
              <div className="border-t border-border">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-bg-tertiary">
                      <th className="text-left px-4 py-1.5 text-text-muted font-medium">Container</th>
                      <th className="text-left px-4 py-1.5 text-text-muted font-medium">IPv4</th>
                      <th className="text-left px-4 py-1.5 text-text-muted font-medium">IPv6</th>
                      <th className="w-10"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {net.containers.map(c => (
                      <tr key={c.id} className="hover:bg-bg-hover/30">
                        <td className="px-4 py-1.5 text-text-primary font-medium">{c.name}</td>
                        <td className="px-4 py-1.5 text-text-muted font-mono">{c.ipv4 || '-'}</td>
                        <td className="px-4 py-1.5 text-text-muted font-mono">{c.ipv6 || '-'}</td>
                        <td className="px-4 py-1.5">
                          {!isSystemNetwork(net.name) && (
                            <button onClick={() => handleDisconnect(net.id, c.id, c.name)} className="p-1 rounded hover:bg-bg-hover text-text-muted hover:text-status-down" title="Disconnect">
                              <Unlink size={12} />
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))}
        {networks.length === 0 && (
          <div className="text-center py-12 text-text-muted">No networks found</div>
        )}
      </div>
    </div>
  );
}
