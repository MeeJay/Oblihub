import apiClient from './client';
import type { ApiResponse, ManagedStack } from '@oblihub/shared';

export const managedStacksApi = {
  async list(): Promise<ManagedStack[]> {
    const res = await apiClient.get<ApiResponse<ManagedStack[]>>('/managed-stacks');
    return res.data.data!;
  },
  async getById(id: number): Promise<ManagedStack> {
    const res = await apiClient.get<ApiResponse<ManagedStack>>(`/managed-stacks/${id}`);
    return res.data.data!;
  },
  async create(data: { name: string; composeContent: string; envContent?: string | null; teamId?: number | null }): Promise<ManagedStack> {
    const res = await apiClient.post<ApiResponse<ManagedStack>>('/managed-stacks', data);
    return res.data.data!;
  },
  async update(id: number, data: { name?: string; composeContent?: string; envContent?: string | null }): Promise<ManagedStack> {
    const res = await apiClient.put<ApiResponse<ManagedStack>>(`/managed-stacks/${id}`, data);
    return res.data.data!;
  },
  async delete(id: number): Promise<void> {
    await apiClient.delete(`/managed-stacks/${id}`);
  },
  async deploy(id: number): Promise<void> {
    await apiClient.post(`/managed-stacks/${id}/deploy`);
  },
  async stop(id: number): Promise<void> {
    await apiClient.post(`/managed-stacks/${id}/stop`);
  },
  async down(id: number, removeVolumes = false): Promise<void> {
    await apiClient.post(`/managed-stacks/${id}/down?volumes=${removeVolumes}`);
  },
  async pull(id: number): Promise<{ exitCode: number; output: string }> {
    const res = await apiClient.post<ApiResponse<{ exitCode: number; output: string }>>(`/managed-stacks/${id}/pull`);
    return res.data.data!;
  },
  async redeploy(id: number): Promise<void> {
    await apiClient.post(`/managed-stacks/${id}/redeploy`);
  },
  async cancel(id: number): Promise<{ killed: boolean }> {
    const res = await apiClient.post<ApiResponse<{ killed: boolean }>>(`/managed-stacks/${id}/cancel`);
    return res.data.data!;
  },
};
