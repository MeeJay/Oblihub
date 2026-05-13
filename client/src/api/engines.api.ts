import apiClient from './client';
import type { ApiResponse, DockerEngine, DockerEngineType } from '@oblihub/shared';

export interface EngineWriteData {
  name: string;
  type: DockerEngineType;
  host?: string | null;
  port?: number | null;
  sshUser?: string | null;
  sshPrivateKey?: string; // omit on edit to keep existing
  sshKnownHost?: string | null;
  apiKey?: string; // omit on edit to keep existing
  apiKeyHeader?: string | null;
  tlsCa?: string | null;
  tlsCert?: string | null;
  tlsKey?: string; // omit on edit to keep existing
  enabled?: boolean;
}

export interface TestResult {
  ok: boolean;
  message?: string;
  serverVersion?: string;
}

export const enginesApi = {
  async list(): Promise<DockerEngine[]> {
    const res = await apiClient.get<ApiResponse<DockerEngine[]>>('/engines');
    return res.data.data!;
  },
  async getById(id: number): Promise<DockerEngine> {
    const res = await apiClient.get<ApiResponse<DockerEngine>>(`/engines/${id}`);
    return res.data.data!;
  },
  async create(data: EngineWriteData): Promise<DockerEngine> {
    const res = await apiClient.post<ApiResponse<DockerEngine>>('/engines', data);
    return res.data.data!;
  },
  async update(id: number, data: Partial<EngineWriteData>): Promise<DockerEngine> {
    const res = await apiClient.patch<ApiResponse<DockerEngine>>(`/engines/${id}`, data);
    return res.data.data!;
  },
  async delete(id: number): Promise<void> {
    await apiClient.delete(`/engines/${id}`);
  },
  async setDefault(id: number): Promise<void> {
    await apiClient.post(`/engines/${id}/set-default`);
  },
  async testExisting(id: number): Promise<TestResult> {
    const res = await apiClient.post<ApiResponse<TestResult>>(`/engines/${id}/test`);
    return res.data.data!;
  },
  async testTransient(data: EngineWriteData): Promise<TestResult> {
    const res = await apiClient.post<ApiResponse<TestResult>>('/engines/test', data);
    return res.data.data!;
  },
};
