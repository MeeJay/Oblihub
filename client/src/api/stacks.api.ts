import apiClient from './client';
import type { ApiResponse, Stack, UpdateHistoryEntry } from '@oblihub/shared';

export const stacksApi = {
  async list(): Promise<Stack[]> {
    const res = await apiClient.get<ApiResponse<Stack[]>>('/stacks');
    return res.data.data!;
  },
  async getById(id: number): Promise<Stack> {
    const res = await apiClient.get<ApiResponse<Stack>>(`/stacks/${id}`);
    return res.data.data!;
  },
  async update(id: number, data: Partial<Pick<Stack, 'name' | 'checkInterval' | 'autoUpdate' | 'enabled' | 'url'>>): Promise<Stack> {
    const res = await apiClient.patch<ApiResponse<Stack>>(`/stacks/${id}`, data);
    return res.data.data!;
  },
  async check(id: number): Promise<void> {
    await apiClient.post(`/stacks/${id}/check`);
  },
  async triggerUpdate(id: number): Promise<void> {
    await apiClient.post(`/stacks/${id}/update`);
  },
  async restart(id: number): Promise<void> {
    await apiClient.post(`/stacks/${id}/restart`);
  },
  async getHistory(id: number, limit = 50, offset = 0): Promise<UpdateHistoryEntry[]> {
    const res = await apiClient.get<ApiResponse<UpdateHistoryEntry[]>>(`/stacks/${id}/history?limit=${limit}&offset=${offset}`);
    return res.data.data!;
  },
};

export const containersApi = {
  async restart(id: number): Promise<void> {
    await apiClient.post(`/containers/${id}/restart`);
  },
  async stop(id: number): Promise<void> {
    await apiClient.post(`/containers/${id}/stop`);
  },
  async start(id: number): Promise<void> {
    await apiClient.post(`/containers/${id}/start`);
  },
  async inspect(id: number): Promise<{ env: string[]; ports: Record<string, { HostIp: string; HostPort: string }[]>; mounts: { Type: string; Source: string; Destination: string; Mode: string }[]; networks: Record<string, { IPAddress: string; Gateway: string; NetworkID: string }> }> {
    const res = await apiClient.get<ApiResponse<{ env: string[]; ports: Record<string, { HostIp: string; HostPort: string }[]>; mounts: { Type: string; Source: string; Destination: string; Mode: string }[]; networks: Record<string, { IPAddress: string; Gateway: string; NetworkID: string }> }>>(`/containers/${id}/inspect`);
    return res.data.data!;
  },
};

export const systemApi = {
  async getInfo(): Promise<{ dockerConnected: boolean; dockerVersion: { version: string; apiVersion: string } | null; stackCount: number; containerCount: number; allowConsole: boolean; allowStack: boolean }> {
    const res = await apiClient.get<ApiResponse<{ dockerConnected: boolean; dockerVersion: { version: string; apiVersion: string } | null; stackCount: number; containerCount: number; allowConsole: boolean; allowStack: boolean }>>('/system');
    return res.data.data!;
  },
  async getFeatures(): Promise<{ allowConsole: boolean; allowStack: boolean; selfProject: string | null }> {
    const res = await apiClient.get<ApiResponse<{ allowConsole: boolean; allowStack: boolean; selfProject: string | null }>>('/system/features');
    return res.data.data!;
  },
};
