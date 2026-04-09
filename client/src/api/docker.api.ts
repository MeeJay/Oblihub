import apiClient from './client';
import type { ApiResponse, DockerImage, DockerNetwork, DockerVolume } from '@oblihub/shared';

export const dockerApi = {
  // Images
  async listImages(): Promise<DockerImage[]> {
    const res = await apiClient.get<ApiResponse<DockerImage[]>>('/docker/images');
    return res.data.data!;
  },
  async pullImage(image: string, tag?: string): Promise<void> {
    await apiClient.post('/docker/images/pull', { image, tag });
  },
  async removeImage(id: string, force = false): Promise<void> {
    await apiClient.delete(`/docker/images/${id}?force=${force}`);
  },
  async pruneImages(): Promise<{ deleted: string[]; spaceReclaimed: number }> {
    const res = await apiClient.post<ApiResponse<{ deleted: string[]; spaceReclaimed: number }>>('/docker/images/prune');
    return res.data.data!;
  },

  // Networks
  async listNetworks(): Promise<DockerNetwork[]> {
    const res = await apiClient.get<ApiResponse<DockerNetwork[]>>('/docker/networks');
    return res.data.data!;
  },
  async createNetwork(data: { name: string; driver?: string; internal?: boolean; attachable?: boolean; subnet?: string; gateway?: string }): Promise<{ id: string }> {
    const res = await apiClient.post<ApiResponse<{ id: string }>>('/docker/networks', data);
    return res.data.data!;
  },
  async removeNetwork(id: string): Promise<void> {
    await apiClient.delete(`/docker/networks/${id}`);
  },
  async pruneNetworks(): Promise<{ deleted: string[] }> {
    const res = await apiClient.post<ApiResponse<{ deleted: string[] }>>('/docker/networks/prune');
    return res.data.data!;
  },
  async connectNetwork(networkId: string, containerId: string, aliases?: string[]): Promise<void> {
    await apiClient.post(`/docker/networks/${networkId}/connect`, { containerId, aliases });
  },
  async disconnectNetwork(networkId: string, containerId: string): Promise<void> {
    await apiClient.post(`/docker/networks/${networkId}/disconnect`, { containerId });
  },

  // Volumes
  async listVolumes(): Promise<DockerVolume[]> {
    const res = await apiClient.get<ApiResponse<DockerVolume[]>>('/docker/volumes');
    return res.data.data!;
  },
  async createVolume(data: { name: string; driver?: string }): Promise<void> {
    await apiClient.post('/docker/volumes', data);
  },
  async removeVolume(name: string, force = false): Promise<void> {
    await apiClient.delete(`/docker/volumes/${name}?force=${force}`);
  },
  async pruneVolumes(): Promise<{ deleted: string[]; spaceReclaimed: number }> {
    const res = await apiClient.post<ApiResponse<{ deleted: string[]; spaceReclaimed: number }>>('/docker/volumes/prune');
    return res.data.data!;
  },
};
