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
  async create(data: { name: string; composeContent: string; envContent?: string | null; teamId?: number | null; engineId?: number | null }): Promise<ManagedStack> {
    const res = await apiClient.post<ApiResponse<ManagedStack>>('/managed-stacks', data);
    return res.data.data!;
  },
  async update(id: number, data: { name?: string; composeContent?: string; envContent?: string | null; engineId?: number | null }): Promise<ManagedStack> {
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
  async checkPortConflicts(args: { engineId: number | null; ports: number[]; excludeComposeProject?: string }): Promise<{
    conflicts: { port: number; stackName: string | null; containerName: string; containerId: number }[];
  }> {
    const res = await apiClient.post<ApiResponse<{
      conflicts: { port: number; stackName: string | null; containerName: string; containerId: number }[];
    }>>('/managed-stacks/check-port-conflicts', args);
    return res.data.data!;
  },

  // ── Build-pipeline source operations ──
  async uploadZip(id: number, file: File): Promise<ManagedStack> {
    const form = new FormData();
    form.append('file', file);
    const res = await apiClient.post<ApiResponse<ManagedStack>>(`/managed-stacks/${id}/source/zip`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return res.data.data!;
  },
  async setGitSource(id: number, gitUrl: string, gitBranch?: string): Promise<ManagedStack> {
    const res = await apiClient.post<ApiResponse<ManagedStack>>(`/managed-stacks/${id}/source/git`, { gitUrl, gitBranch });
    return res.data.data!;
  },
  async gitPull(id: number): Promise<ManagedStack> {
    const res = await apiClient.post<ApiResponse<ManagedStack>>(`/managed-stacks/${id}/source/git-pull`);
    return res.data.data!;
  },
  async listSourceFiles(id: number): Promise<{ path: string; size: number; isDir: boolean }[]> {
    const res = await apiClient.get<ApiResponse<{ path: string; size: number; isDir: boolean }[]>>(`/managed-stacks/${id}/source/files`);
    return res.data.data!;
  },

  // Engine migration
  async previewMigration(id: number): Promise<{ named: string[]; binds: string[] }> {
    const res = await apiClient.get<ApiResponse<{ named: string[]; binds: string[] }>>(`/managed-stacks/${id}/migration-preview`);
    return res.data.data!;
  },
  async migrateEngine(id: number, body: { targetEngineId: number | null; strategy: 'just-save' | 'stop-and-deploy' | 'migrate-data' }): Promise<{
    stack: ManagedStack;
    migrated: { name: string; ok: boolean; bytesIn?: number; error?: string }[];
    skippedBinds: string[];
  }> {
    const res = await apiClient.post<ApiResponse<{
      stack: ManagedStack;
      migrated: { name: string; ok: boolean; bytesIn?: number; error?: string }[];
      skippedBinds: string[];
    }>>(`/managed-stacks/${id}/migrate-engine`, body);
    return res.data.data!;
  },
  async cancel(id: number): Promise<{ killed: boolean }> {
    const res = await apiClient.post<ApiResponse<{ killed: boolean }>>(`/managed-stacks/${id}/cancel`);
    return res.data.data!;
  },
};
