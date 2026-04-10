import apiClient from './client';
import type { ApiResponse, ProxyHost, Certificate, RedirectionHost, StreamHost, DeadHost, AccessList, CustomPage } from '@oblihub/shared';

export const proxyApi = {
  // Proxy hosts
  async listHosts(): Promise<ProxyHost[]> {
    const res = await apiClient.get<ApiResponse<ProxyHost[]>>('/proxy/hosts');
    return res.data.data!;
  },
  async getHost(id: number): Promise<ProxyHost> {
    const res = await apiClient.get<ApiResponse<ProxyHost>>(`/proxy/hosts/${id}`);
    return res.data.data!;
  },
  async createHost(data: Partial<ProxyHost>): Promise<ProxyHost> {
    const res = await apiClient.post<ApiResponse<ProxyHost>>('/proxy/hosts', data);
    return res.data.data!;
  },
  async updateHost(id: number, data: Partial<ProxyHost>): Promise<ProxyHost> {
    const res = await apiClient.put<ApiResponse<ProxyHost>>(`/proxy/hosts/${id}`, data);
    return res.data.data!;
  },
  async deleteHost(id: number): Promise<void> {
    await apiClient.delete(`/proxy/hosts/${id}`);
  },
  async toggleHost(id: number): Promise<{ enabled: boolean }> {
    const res = await apiClient.post<ApiResponse<{ enabled: boolean }>>(`/proxy/hosts/${id}/toggle`);
    return res.data.data!;
  },

  // Certificates
  async listCertificates(): Promise<Certificate[]> {
    const res = await apiClient.get<ApiResponse<Certificate[]>>('/proxy/certificates');
    return res.data.data!;
  },
  async createCertificate(data: { domainNames: string[]; provider?: string; acmeEmail?: string }): Promise<Certificate> {
    const res = await apiClient.post<ApiResponse<Certificate>>('/proxy/certificates', data);
    return res.data.data!;
  },
  async uploadCertificate(id: number, data: { certificate: string; key: string; chain?: string }): Promise<void> {
    await apiClient.post(`/proxy/certificates/${id}/upload`, data);
  },
  async deleteCertificate(id: number): Promise<void> {
    await apiClient.delete(`/proxy/certificates/${id}`);
  },

  // Redirections
  async listRedirections(): Promise<RedirectionHost[]> {
    const res = await apiClient.get<ApiResponse<RedirectionHost[]>>('/proxy/redirections');
    return res.data.data!;
  },
  async createRedirection(data: Partial<RedirectionHost>): Promise<RedirectionHost> {
    const res = await apiClient.post<ApiResponse<RedirectionHost>>('/proxy/redirections', data);
    return res.data.data!;
  },
  async updateRedirection(id: number, data: Partial<RedirectionHost>): Promise<RedirectionHost> {
    const res = await apiClient.put<ApiResponse<RedirectionHost>>(`/proxy/redirections/${id}`, data);
    return res.data.data!;
  },
  async deleteRedirection(id: number): Promise<void> {
    await apiClient.delete(`/proxy/redirections/${id}`);
  },

  // Streams
  async listStreams(): Promise<StreamHost[]> {
    const res = await apiClient.get<ApiResponse<StreamHost[]>>('/proxy/streams');
    return res.data.data!;
  },
  async createStream(data: Partial<StreamHost>): Promise<StreamHost> {
    const res = await apiClient.post<ApiResponse<StreamHost>>('/proxy/streams', data);
    return res.data.data!;
  },
  async updateStream(id: number, data: Partial<StreamHost>): Promise<StreamHost> {
    const res = await apiClient.put<ApiResponse<StreamHost>>(`/proxy/streams/${id}`, data);
    return res.data.data!;
  },
  async deleteStream(id: number): Promise<void> {
    await apiClient.delete(`/proxy/streams/${id}`);
  },

  // Dead hosts
  async listDeadHosts(): Promise<DeadHost[]> {
    const res = await apiClient.get<ApiResponse<DeadHost[]>>('/proxy/dead-hosts');
    return res.data.data!;
  },
  async createDeadHost(data: Partial<DeadHost>): Promise<DeadHost> {
    const res = await apiClient.post<ApiResponse<DeadHost>>('/proxy/dead-hosts', data);
    return res.data.data!;
  },
  async deleteDeadHost(id: number): Promise<void> {
    await apiClient.delete(`/proxy/dead-hosts/${id}`);
  },

  // Access lists
  async listAccessLists(): Promise<AccessList[]> {
    const res = await apiClient.get<ApiResponse<AccessList[]>>('/proxy/access-lists');
    return res.data.data!;
  },
  async createAccessList(data: { name: string; satisfyAny?: boolean; passAuth?: boolean }): Promise<AccessList> {
    const res = await apiClient.post<ApiResponse<AccessList>>('/proxy/access-lists', data);
    return res.data.data!;
  },
  async deleteAccessList(id: number): Promise<void> {
    await apiClient.delete(`/proxy/access-lists/${id}`);
  },
  async addAccessListClient(listId: number, address: string, directive: 'allow' | 'deny'): Promise<void> {
    await apiClient.post(`/proxy/access-lists/${listId}/clients`, { address, directive });
  },
  async removeAccessListClient(listId: number, clientId: number): Promise<void> {
    await apiClient.delete(`/proxy/access-lists/${listId}/clients/${clientId}`);
  },
  async addAccessListAuth(listId: number, username: string, password: string): Promise<void> {
    await apiClient.post(`/proxy/access-lists/${listId}/auth`, { username, password });
  },
  async removeAccessListAuth(listId: number, authId: number): Promise<void> {
    await apiClient.delete(`/proxy/access-lists/${listId}/auth/${authId}`);
  },

  // Custom pages
  async listCustomPages(): Promise<CustomPage[]> {
    const res = await apiClient.get<ApiResponse<CustomPage[]>>('/proxy/custom-pages');
    return res.data.data!;
  },
  async createCustomPage(data: { name: string; description?: string; errorCodes: number[]; htmlContent: string; theme?: string }): Promise<CustomPage> {
    const res = await apiClient.post<ApiResponse<CustomPage>>('/proxy/custom-pages', data);
    return res.data.data!;
  },
  async updateCustomPage(id: number, data: Partial<CustomPage>): Promise<CustomPage> {
    const res = await apiClient.put<ApiResponse<CustomPage>>(`/proxy/custom-pages/${id}`, data);
    return res.data.data!;
  },
  async deleteCustomPage(id: number): Promise<void> {
    await apiClient.delete(`/proxy/custom-pages/${id}`);
  },

  // Stack integration
  async getHostsByStack(stackId: number): Promise<ProxyHost[]> {
    const res = await apiClient.get<ApiResponse<ProxyHost[]>>(`/proxy/hosts/by-stack/${stackId}`);
    return res.data.data!;
  },
  async quickSetup(data: { stackId: number; containerId: number; domainNames: string[]; forwardPort: number; requestCertificate?: boolean; acmeEmail?: string }): Promise<ProxyHost> {
    const res = await apiClient.post<ApiResponse<ProxyHost>>('/proxy/hosts/quick-setup', data);
    return res.data.data!;
  },

  // Status
  async getStatus(): Promise<{ nginxRunning: boolean; proxyHostCount: number; enabledHostCount: number; certificateCount: number; validCertCount: number; expiringSoon: number }> {
    const res = await apiClient.get<ApiResponse<{ nginxRunning: boolean; proxyHostCount: number; enabledHostCount: number; certificateCount: number; validCertCount: number; expiringSoon: number }>>('/proxy/status');
    return res.data.data!;
  },

  // Nginx control
  async reloadNginx(): Promise<void> {
    await apiClient.post('/proxy/nginx/reload');
  },
  async testNginx(): Promise<{ valid: boolean; error?: string }> {
    const res = await apiClient.post<ApiResponse<{ valid: boolean; error?: string }>>('/proxy/nginx/test');
    return res.data.data!;
  },
};
