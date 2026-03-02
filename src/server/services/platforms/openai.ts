import { BasePlatformAdapter, type BalanceInfo, type CheckinResult, type UserInfo } from './base.js';

function normalizeBaseUrl(baseUrl: string): string {
  return (baseUrl || '').replace(/\/+$/, '');
}

function resolveOpenAiModelsUrl(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  if (/\/v\d+(\.\d+)?$/i.test(normalized)) {
    return `${normalized}/models`;
  }
  return `${normalized}/v1/models`;
}

export class OpenAiAdapter extends BasePlatformAdapter {
  readonly platformName = 'openai';

  async detect(url: string): Promise<boolean> {
    const normalized = (url || '').toLowerCase();
    return normalized.includes('api.openai.com');
  }

  override async login(_baseUrl: string, _username: string, _password: string) {
    return { success: false, message: 'login endpoint not supported' };
  }

  override async getUserInfo(_baseUrl: string, _accessToken: string): Promise<UserInfo | null> {
    return null;
  }

  async checkin(_baseUrl: string, _accessToken: string): Promise<CheckinResult> {
    return { success: false, message: 'checkin endpoint not supported' };
  }

  async getBalance(_baseUrl: string, _accessToken: string): Promise<BalanceInfo> {
    // Official OpenAI API keys generally do not expose account balance via API.
    return { balance: 0, used: 0, quota: 0 };
  }

  async getModels(baseUrl: string, apiToken: string): Promise<string[]> {
    try {
      const res = await this.fetchJson<any>(resolveOpenAiModelsUrl(baseUrl), {
        headers: { Authorization: `Bearer ${apiToken}` },
      });
      return (res?.data || []).map((m: any) => m?.id).filter(Boolean);
    } catch {
      return [];
    }
  }
}
