import apiClient from './client';
import type { ApiResponse, DockerImage, DockerNetwork, DockerVolume } from '@oblihub/shared';

/**
 * `engineId` semantics across these helpers:
 *   undefined / null  → backend's default engine (local socket)
 *   number            → that specific engine id
 *   'all'             → backend fans out to every enabled engine in parallel and tags each
 *                       returned row with its source engine (id + name) so the UI can render
 *                       a badge. Only meaningful for list/prune; mutating operations require
 *                       a concrete target.
 */
export type EngineTarget = number | 'all' | null | undefined;

function q(engineId: EngineTarget): string {
  if (engineId == null) return '';
  return `?engineId=${engineId}`;
}

// Per-row engine tagging — the backend extends each list item with these two fields when the
// list endpoint is hit. They're optional on the base types (legacy callers may not have them)
// but always present in fresh responses.
export type WithEngine<T> = T & { engineId: number | null; engineName: string };

export interface PruneAllRecap<R> {
  perEngine: { engineId: number; engineName: string; ok: boolean; result?: R; error?: string }[];
}

export const dockerApi = {
  // Images
  async listImages(engineId: EngineTarget = null): Promise<WithEngine<DockerImage>[]> {
    const res = await apiClient.get<ApiResponse<WithEngine<DockerImage>[]>>(`/docker/images${q(engineId)}`);
    return res.data.data!;
  },
  async pullImage(image: string, tag?: string, engineId: EngineTarget = null): Promise<void> {
    await apiClient.post(`/docker/images/pull${q(engineId)}`, { image, tag });
  },
  async removeImage(id: string, force = false, engineId: EngineTarget = null): Promise<void> {
    const sep = engineId == null ? '?' : '&';
    await apiClient.delete(`/docker/images/${id}${q(engineId)}${sep}force=${force}`);
  },
  async pruneImages(engineId: EngineTarget = null): Promise<{ deleted: string[]; spaceReclaimed: number } | PruneAllRecap<{ deleted: string[]; spaceReclaimed: number }>> {
    const res = await apiClient.post<ApiResponse<{ deleted: string[]; spaceReclaimed: number } | PruneAllRecap<{ deleted: string[]; spaceReclaimed: number }>>>(`/docker/images/prune${q(engineId)}`);
    return res.data.data!;
  },

  // Networks
  async listNetworks(engineId: EngineTarget = null): Promise<WithEngine<DockerNetwork>[]> {
    const res = await apiClient.get<ApiResponse<WithEngine<DockerNetwork>[]>>(`/docker/networks${q(engineId)}`);
    return res.data.data!;
  },
  async createNetwork(data: { name: string; driver?: string; internal?: boolean; attachable?: boolean; subnet?: string; gateway?: string }, engineId: EngineTarget = null): Promise<{ id: string }> {
    const res = await apiClient.post<ApiResponse<{ id: string }>>(`/docker/networks${q(engineId)}`, data);
    return res.data.data!;
  },
  async removeNetwork(id: string, engineId: EngineTarget = null): Promise<void> {
    await apiClient.delete(`/docker/networks/${id}${q(engineId)}`);
  },
  async pruneNetworks(engineId: EngineTarget = null): Promise<{ deleted: string[] } | PruneAllRecap<{ deleted: string[] }>> {
    const res = await apiClient.post<ApiResponse<{ deleted: string[] } | PruneAllRecap<{ deleted: string[] }>>>(`/docker/networks/prune${q(engineId)}`);
    return res.data.data!;
  },
  async connectNetwork(networkId: string, containerId: string, aliases?: string[], engineId: EngineTarget = null): Promise<void> {
    await apiClient.post(`/docker/networks/${networkId}/connect${q(engineId)}`, { containerId, aliases });
  },
  async disconnectNetwork(networkId: string, containerId: string, engineId: EngineTarget = null): Promise<void> {
    await apiClient.post(`/docker/networks/${networkId}/disconnect${q(engineId)}`, { containerId });
  },

  // Volumes
  async listVolumes(engineId: EngineTarget = null): Promise<WithEngine<DockerVolume>[]> {
    const res = await apiClient.get<ApiResponse<WithEngine<DockerVolume>[]>>(`/docker/volumes${q(engineId)}`);
    return res.data.data!;
  },
  async createVolume(data: { name: string; driver?: string; driverOpts?: Record<string, string> }, engineId: EngineTarget = null): Promise<void> {
    await apiClient.post(`/docker/volumes${q(engineId)}`, data);
  },
  async removeVolume(name: string, force = false, engineId: EngineTarget = null): Promise<void> {
    const sep = engineId == null ? '?' : '&';
    await apiClient.delete(`/docker/volumes/${name}${q(engineId)}${sep}force=${force}`);
  },
  async pruneVolumes(engineId: EngineTarget = null): Promise<{ deleted: string[]; spaceReclaimed: number } | PruneAllRecap<{ deleted: string[]; spaceReclaimed: number }>> {
    const res = await apiClient.post<ApiResponse<{ deleted: string[]; spaceReclaimed: number } | PruneAllRecap<{ deleted: string[]; spaceReclaimed: number }>>>(`/docker/volumes/prune${q(engineId)}`);
    return res.data.data!;
  },
};
