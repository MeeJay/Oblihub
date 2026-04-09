import { useEffect, useState } from 'react';
import { RefreshCw, Trash2, Plus, Database, Eraser } from 'lucide-react';
import { dockerApi } from '@/api/docker.api';
import type { DockerVolume } from '@oblihub/shared';
import toast from 'react-hot-toast';

function formatSize(bytes: number | null): string {
  if (bytes === null || bytes < 0) return '-';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

export function VolumesPage() {
  const [volumes, setVolumes] = useState<DockerVolume[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ name: '', driver: 'local' });

  const load = async () => {
    try {
      setVolumes(await dockerApi.listVolumes());
    } catch { toast.error('Failed to load volumes'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const handleCreate = async () => {
    if (!createForm.name.trim()) return;
    try {
      await dockerApi.createVolume(createForm);
      toast.success(`Volume ${createForm.name} created`);
      setCreateForm({ name: '', driver: 'local' });
      setShowCreate(false);
      load();
    } catch { toast.error('Failed to create volume'); }
  };

  const handleRemove = async (vol: DockerVolume) => {
    if (!confirm(`Remove volume "${vol.name}"? This will delete all data in this volume!`)) return;
    try {
      await dockerApi.removeVolume(vol.name, true);
      toast.success(`Volume ${vol.name} removed`);
      load();
    } catch { toast.error('Failed to remove volume. It may be in use.'); }
  };

  if (loading) return <div className="flex items-center justify-center h-full"><div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" /></div>;

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-text-primary flex items-center gap-2"><Database size={20} /> Volumes</h1>
        <div className="flex gap-2">
          <button onClick={() => setShowCreate(v => !v)} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover">
            <Plus size={14} /> Create
          </button>
          <button
            onClick={async () => {
              if (!confirm('Remove all unused volumes? This will DELETE all data in unused volumes!')) return;
              try {
                const result = await dockerApi.pruneVolumes();
                toast.success(`Pruned ${result.deleted.length} volume(s), reclaimed ${formatSize(result.spaceReclaimed)}`);
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
          <h3 className="text-sm font-semibold text-text-secondary">Create Volume</h3>
          <div className="grid grid-cols-2 gap-3">
            <input value={createForm.name} onChange={e => setCreateForm(f => ({ ...f, name: e.target.value }))} placeholder="Volume name" className="rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
            <select value={createForm.driver} onChange={e => setCreateForm(f => ({ ...f, driver: e.target.value }))} className="rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent">
              <option value="local">local</option>
            </select>
          </div>
          <div className="flex gap-2">
            <button onClick={handleCreate} className="px-4 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover">Create</button>
            <button onClick={() => setShowCreate(false)} className="px-4 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">Cancel</button>
          </div>
        </div>
      )}

      {/* Volumes table */}
      <div className="rounded-xl border border-border bg-bg-secondary overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-bg-tertiary">
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-text-muted">Name</th>
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-text-muted">Driver</th>
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-text-muted">Stack</th>
              <th className="text-right px-4 py-2.5 text-xs font-semibold text-text-muted">Size</th>
              <th className="text-right px-4 py-2.5 text-xs font-semibold text-text-muted">Created</th>
              <th className="text-right px-4 py-2.5 text-xs font-semibold text-text-muted w-16"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {volumes.map((vol) => (
              <tr key={vol.name} className="hover:bg-bg-hover/50">
                <td className="px-4 py-2.5">
                  <div className="text-text-primary font-mono text-xs truncate max-w-xs" title={vol.name}>{vol.name}</div>
                </td>
                <td className="px-4 py-2.5 text-text-muted text-xs">{vol.driver}</td>
                <td className="px-4 py-2.5">
                  {vol.composeProject ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent">{vol.composeProject}</span>
                  ) : (
                    <span className="text-text-muted text-xs">-</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-right text-text-secondary text-xs">{formatSize(vol.usageSize)}</td>
                <td className="px-4 py-2.5 text-right text-text-muted text-xs">{vol.created ? new Date(vol.created).toLocaleDateString() : '-'}</td>
                <td className="px-4 py-2.5 text-right">
                  <button onClick={() => handleRemove(vol)} className="p-1 rounded hover:bg-bg-hover text-text-muted hover:text-status-down" title="Remove">
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
            {volumes.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-text-muted">No volumes found</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
