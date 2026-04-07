import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, RefreshCw, Play, Settings2 } from 'lucide-react';
import { stacksApi } from '@/api/stacks.api';
import type { Stack, UpdateHistoryEntry } from '@oblihub/shared';
import toast from 'react-hot-toast';

export function StackDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [stack, setStack] = useState<Stack | null>(null);
  const [history, setHistory] = useState<UpdateHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    if (!id) return;
    try {
      const [s, h] = await Promise.all([
        stacksApi.getById(Number(id)),
        stacksApi.getHistory(Number(id)),
      ]);
      setStack(s);
      setHistory(h);
    } catch { toast.error('Failed to load stack'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [id]);

  if (loading) return <div className="flex items-center justify-center h-full"><div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" /></div>;
  if (!stack) return <div className="p-6 text-text-muted">Stack not found</div>;

  return (
    <div className="p-6 max-w-5xl">
      <button onClick={() => navigate('/')} className="flex items-center gap-1 text-sm text-text-muted hover:text-text-primary mb-4">
        <ArrowLeft size={14} /> Back
      </button>

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">{stack.name}</h1>
          {stack.composeProject && <p className="text-xs text-text-muted mt-1">Compose project: {stack.composeProject}</p>}
        </div>
        <div className="flex gap-2">
          <button onClick={() => stacksApi.check(stack.id).then(load)} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">
            <RefreshCw size={14} /> Check Now
          </button>
          <button onClick={() => stacksApi.triggerUpdate(stack.id).then(load)} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover">
            <Play size={14} /> Update All
          </button>
        </div>
      </div>

      {/* Containers */}
      <div className="rounded-xl border border-border bg-bg-secondary mb-6">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-text-secondary">Containers</h2>
        </div>
        <div className="divide-y divide-border">
          {stack.containers.map((c) => (
            <div key={c.id} className="px-4 py-3 flex items-center gap-4">
              <div className={`h-2.5 w-2.5 rounded-full shrink-0 ${
                c.status === 'up_to_date' ? 'bg-status-up' :
                c.status === 'update_available' ? 'bg-status-pending' :
                c.status === 'error' ? 'bg-status-down' :
                c.status === 'updating' ? 'bg-accent animate-pulse' : 'bg-text-muted'
              }`} />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-text-primary">{c.containerName}</div>
                <div className="text-xs text-text-muted">{c.image}:{c.imageTag}</div>
              </div>
              <div className="text-right shrink-0">
                {c.currentDigest && (
                  <div className="text-[10px] font-mono text-text-muted" title={c.currentDigest}>
                    {c.currentDigest.slice(7, 19)}
                  </div>
                )}
                {c.latestDigest && c.latestDigest !== c.currentDigest && (
                  <div className="text-[10px] font-mono text-status-pending" title={c.latestDigest}>
                    → {c.latestDigest.slice(7, 19)}
                  </div>
                )}
              </div>
              {c.excluded && <span className="text-[10px] text-text-muted bg-bg-tertiary px-1.5 py-0.5 rounded">Excluded</span>}
            </div>
          ))}
        </div>
      </div>

      {/* Config */}
      <div className="rounded-xl border border-border bg-bg-secondary mb-6 p-4">
        <h2 className="text-sm font-semibold text-text-secondary mb-3 flex items-center gap-1.5"><Settings2 size={14} /> Configuration</h2>
        <div className="grid grid-cols-3 gap-4 text-sm">
          <div>
            <span className="text-text-muted">Check Interval</span>
            <div className="text-text-primary font-medium">{stack.checkInterval}s</div>
          </div>
          <div>
            <span className="text-text-muted">Auto-Update</span>
            <div className={`font-medium ${stack.autoUpdate ? 'text-status-up' : 'text-text-muted'}`}>{stack.autoUpdate ? 'Enabled' : 'Disabled'}</div>
          </div>
          <div>
            <span className="text-text-muted">Monitoring</span>
            <div className={`font-medium ${stack.enabled ? 'text-status-up' : 'text-status-down'}`}>{stack.enabled ? 'Active' : 'Paused'}</div>
          </div>
        </div>
      </div>

      {/* History */}
      {history.length > 0 && (
        <div className="rounded-xl border border-border bg-bg-secondary">
          <div className="px-4 py-3 border-b border-border">
            <h2 className="text-sm font-semibold text-text-secondary">Update History</h2>
          </div>
          <div className="divide-y divide-border">
            {history.map((h) => (
              <div key={h.id} className="px-4 py-2.5 flex items-center gap-3 text-xs">
                <div className={`h-2 w-2 rounded-full shrink-0 ${
                  h.status === 'success' ? 'bg-status-up' : h.status === 'failed' ? 'bg-status-down' : 'bg-status-pending'
                }`} />
                <span className="text-text-primary font-medium">{h.containerName}</span>
                <span className="text-text-muted">{h.image}</span>
                <span className={`ml-auto ${h.status === 'success' ? 'text-status-up' : h.status === 'failed' ? 'text-status-down' : 'text-text-muted'}`}>
                  {h.status}
                </span>
                <span className="text-text-muted">{new Date(h.startedAt).toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
