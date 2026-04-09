import { useEffect, useState } from 'react';
import { RefreshCw, Trash2, Download, HardDrive } from 'lucide-react';
import { dockerApi } from '@/api/docker.api';
import type { DockerImage } from '@oblihub/shared';
import toast from 'react-hot-toast';

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

export function ImagesPage() {
  const [images, setImages] = useState<DockerImage[]>([]);
  const [loading, setLoading] = useState(true);
  const [pullInput, setPullInput] = useState('');
  const [pulling, setPulling] = useState(false);

  const load = async () => {
    try {
      setImages(await dockerApi.listImages());
    } catch { toast.error('Failed to load images'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const handlePull = async () => {
    if (!pullInput.trim()) return;
    setPulling(true);
    try {
      const [image, tag] = pullInput.includes(':') ? pullInput.split(':') : [pullInput, 'latest'];
      await dockerApi.pullImage(image, tag);
      toast.success(`Pulling ${pullInput}...`);
      setTimeout(load, 5000);
    } catch { toast.error('Failed to pull image'); }
    finally { setPulling(false); setPullInput(''); }
  };

  const handleRemove = async (img: DockerImage) => {
    const name = img.repoTags[0] || img.id;
    if (!confirm(`Remove image ${name}?`)) return;
    try {
      await dockerApi.removeImage(img.id, true);
      toast.success(`Image ${name} removed`);
      load();
    } catch { toast.error('Failed to remove image. It may be in use.'); }
  };

  if (loading) return <div className="flex items-center justify-center h-full"><div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" /></div>;

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-text-primary flex items-center gap-2"><HardDrive size={20} /> Images</h1>
        <button onClick={load} className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {/* Pull image */}
      <div className="flex gap-2 mb-6">
        <input
          value={pullInput}
          onChange={e => setPullInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handlePull()}
          placeholder="nginx:latest, postgres:16..."
          className="flex-1 rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
        />
        <button
          onClick={handlePull}
          disabled={pulling || !pullInput.trim()}
          className="flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover disabled:opacity-50"
        >
          <Download size={14} /> Pull
        </button>
      </div>

      {/* Images table */}
      <div className="rounded-xl border border-border bg-bg-secondary overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-bg-tertiary">
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-text-muted">Repository:Tag</th>
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-text-muted">ID</th>
              <th className="text-right px-4 py-2.5 text-xs font-semibold text-text-muted">Size</th>
              <th className="text-right px-4 py-2.5 text-xs font-semibold text-text-muted">Created</th>
              <th className="text-right px-4 py-2.5 text-xs font-semibold text-text-muted w-16"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {images.map((img) => (
              <tr key={img.id} className="hover:bg-bg-hover/50">
                <td className="px-4 py-2.5">
                  <div className="space-y-0.5">
                    {(img.repoTags.length > 0 ? img.repoTags : ['<none>:<none>']).map((tag, i) => (
                      <div key={i} className="text-text-primary font-mono text-xs">{tag}</div>
                    ))}
                  </div>
                </td>
                <td className="px-4 py-2.5 font-mono text-xs text-text-muted">{img.id}</td>
                <td className="px-4 py-2.5 text-right text-text-secondary text-xs">{formatSize(img.size)}</td>
                <td className="px-4 py-2.5 text-right text-text-muted text-xs">{new Date(img.created * 1000).toLocaleDateString()}</td>
                <td className="px-4 py-2.5 text-right">
                  <button onClick={() => handleRemove(img)} className="p-1 rounded hover:bg-bg-hover text-text-muted hover:text-status-down" title="Remove">
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
            {images.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-text-muted">No images found</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
