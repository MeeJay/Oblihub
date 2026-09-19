import apiClient from './client';
import type { ApiResponse, ManagedStack } from '@oblihub/shared';

// Fields added in later server versions — the client container can be updated before the server.
function withDefaults(s: ManagedStack): ManagedStack {
  return { ...s, volumesInStacksDir: !!s.volumesInStacksDir, volumePlacements: s.volumePlacements ?? [] };
}

export const managedStacksApi = {
  async list(): Promise<ManagedStack[]> {
    const res = await apiClient.get<ApiResponse<ManagedStack[]>>('/managed-stacks');
    return res.data.data!.map(withDefaults);
  },
  async getById(id: number): Promise<ManagedStack> {
    const res = await apiClient.get<ApiResponse<ManagedStack>>(`/managed-stacks/${id}`);
    return withDefaults(res.data.data!);
  },
  async create(data: { name: string; composeContent: string; envContent?: string | null; teamId?: number | null; engineId?: number | null; registryCredentials?: Array<{ registry: string; username: string; password?: string }>; gitUsername?: string | null; gitToken?: string | null; composePath?: string | null; buildEnabled?: boolean; pollGitIntervalS?: number }): Promise<ManagedStack> {
    const res = await apiClient.post<ApiResponse<ManagedStack>>('/managed-stacks', data);
    return withDefaults(res.data.data!);
  },
  async update(id: number, data: { name?: string; composeContent?: string; envContent?: string | null; engineId?: number | null; registryCredentials?: Array<{ registry: string; username: string; password?: string }>; gitUsername?: string | null; gitToken?: string | null; composePath?: string | null; buildEnabled?: boolean; pollGitIntervalS?: number }): Promise<ManagedStack> {
    const res = await apiClient.put<ApiResponse<ManagedStack>>(`/managed-stacks/${id}`, data);
    return withDefaults(res.data.data!);
  },
  /**
   * `forEngineId`: the engine of the discovered stack the delete comes from — the server then wipes
   * volumes only if this managed stack runs on that same daemon. `keptVolumeData`: `.volumes` folders left on disk.
   */
  async delete(id: number, removeVolumes = false, forEngineId?: number | null): Promise<{ keptVolumeData: string[] }> {
    const engineParam = forEngineId !== undefined ? `&forEngine=${forEngineId ?? 'null'}` : '';
    const res = await apiClient.delete<ApiResponse<{ removedVolumes: boolean; keptVolumeData?: string[] }>>(`/managed-stacks/${id}?volumes=${removeVolumes}${engineParam}`);
    return { keptVolumeData: res.data?.data?.keptVolumeData ?? [] };
  },
  async deploy(id: number): Promise<void> {
    await apiClient.post(`/managed-stacks/${id}/deploy`);
  },
  async stop(id: number): Promise<void> {
    await apiClient.post(`/managed-stacks/${id}/stop`);
  },
  /** `keptVolumeData`: `.volumes` folders a wipe had to keep (still used by another container / volume). */
  async down(id: number, removeVolumes = false): Promise<{ removedVolumeData: string[]; keptVolumeData: string[] }> {
    const res = await apiClient.post<ApiResponse<{ removedVolumeData: string[]; keptVolumeData: string[] }>>(`/managed-stacks/${id}/down?volumes=${removeVolumes}`);
    return res.data.data ?? { removedVolumeData: [], keptVolumeData: [] };
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
    return withDefaults(res.data.data!);
  },
  async setGitSource(id: number, args: { gitUrl: string; gitBranch?: string; gitUsername?: string | null; gitToken?: string | null; composePath?: string | null }): Promise<ManagedStack> {
    const res = await apiClient.post<ApiResponse<ManagedStack>>(`/managed-stacks/${id}/source/git`, args);
    return withDefaults(res.data.data!);
  },
  async getDeployHistory(id: number, limit = 50): Promise<Array<import('@oblihub/shared').ManagedStackDeployHistoryEntry>> {
    const res = await apiClient.get<ApiResponse<Array<import('@oblihub/shared').ManagedStackDeployHistoryEntry>>>(`/managed-stacks/${id}/deploy-history?limit=${limit}`);
    return res.data.data!;
  },
  async rollback(id: number, gitRef: string): Promise<ManagedStack> {
    const res = await apiClient.post<ApiResponse<{ stack: ManagedStack }>>(`/managed-stacks/${id}/rollback`, { gitRef });
    return withDefaults(res.data.data!.stack);
  },
  async gitPull(id: number): Promise<{ stack: ManagedStack; redeployStarted: boolean }> {
    // Server chains pull → background redeploy when the stack has been deployed at least once.
    // Callers surface a different toast message depending on `redeployStarted` so the operator
    // knows if they still need to click Deploy or if the rebuild is already in flight.
    const res = await apiClient.post<ApiResponse<ManagedStack> & { redeployStarted?: boolean }>(`/managed-stacks/${id}/source/git-pull`);
    return { stack: withDefaults(res.data.data!), redeployStarted: !!res.data.redeployStarted };
  },
  async listSourceFiles(id: number): Promise<{ path: string; size: number; isDir: boolean }[]> {
    const res = await apiClient.get<ApiResponse<{ path: string; size: number; isDir: boolean }[]>>(`/managed-stacks/${id}/source/files`);
    return res.data.data!;
  },
  async getGeneratedFiles(id: number): Promise<Array<{ name: string; path: string; content: string | null; exists: boolean }>> {
    const res = await apiClient.get<ApiResponse<Array<{ name: string; path: string; content: string | null; exists: boolean }>>>(`/managed-stacks/${id}/source/generated`);
    return res.data.data!;
  },
  async getEffectiveConfig(id: number): Promise<{ config: string | null; error: string | null; exitCode: number }> {
    const res = await apiClient.get<ApiResponse<{ config: string | null; error: string | null; exitCode: number }>>(`/managed-stacks/${id}/effective-config`);
    return res.data.data!;
  },

  // Engine migration
  async previewMigration(id: number): Promise<{ named: string[]; binds: string[] }> {
    const res = await apiClient.get<ApiResponse<{ named: string[]; binds: string[] }>>(`/managed-stacks/${id}/migration-preview`);
    return res.data.data!;
  },
  /** `engineOnly`: both engines are the same local daemon — only the reference changed, nothing was redeployed. */
  async migrateEngine(id: number, body: { targetEngineId: number | null; strategy: 'just-save' | 'stop-and-deploy' | 'migrate-data' }): Promise<{
    stack: ManagedStack;
    migrated: { name: string; ok: boolean; bytesIn?: number; error?: string }[];
    skippedBinds: string[];
    engineOnly?: boolean;
  }> {
    const res = await apiClient.post<ApiResponse<{
      stack: ManagedStack;
      migrated: { name: string; ok: boolean; bytesIn?: number; error?: string }[];
      skippedBinds: string[];
      engineOnly?: boolean;
    }>>(`/managed-stacks/${id}/migrate-engine`, body);
    const data = res.data.data!;
    return { ...data, stack: withDefaults(data.stack) };
  },
  async cancel(id: number): Promise<{ killed: boolean }> {
    const res = await apiClient.post<ApiResponse<{ killed: boolean }>>(`/managed-stacks/${id}/cancel`);
    return res.data.data!;
  },
};
