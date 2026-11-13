import type { ModelInfo } from '../../shared/types';

export interface ModelListInspection {
  recognized: boolean;
  models: ModelInfo[];
  invalidItems: number;
}

/** Validate and canonicalize an OpenAI-compatible API base URL. */
export function normalizeBaseUrl(input: string): string {
  const value = input.trim();
  if (!value) throw new Error('API Base URL 不能为空。');
  if (/[\u0000-\u0020\u007f]/.test(value)) throw new Error('API Base URL 含空格或控制字符，请检查后重试。');

  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error('API Base URL 格式无效，请输入完整的 HTTPS 地址。'); }
  if (url.protocol !== 'https:') throw new Error('API Base URL 必须使用 HTTPS。');
  if (!url.hostname || url.username || url.password) throw new Error('API Base URL 主机无效，且不能在 URL 中嵌入凭据。');
  if (url.search || url.hash) throw new Error('API Base URL 不能包含查询参数或片段。');

  let pathname = url.pathname.replace(/\/+$/, '');
  pathname = pathname.replace(/(?:\/chat\/completions)+$/i, '');
  pathname = pathname.replace(/(?:\/models)+$/i, '');
  pathname = pathname.replace(/(?:\/openai\/v1){2,}$/i, '/openai/v1');
  pathname = pathname.replace(/(?:\/v1){2,}$/i, '/v1');
  url.pathname = pathname;
  url.search = '';
  url.hash = '';
  return url.href.replace(/\/$/, '');
}

export function modelsEndpoint(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  const url = new URL(normalized);
  // OpenCode Go publishes models outside its OpenAI-compatible path.
  if (url.origin === 'https://opencode.ai' && /\/inference\/go\/openai\/v1$/i.test(url.pathname)) {
    url.pathname = url.pathname.replace(/\/openai\/v1$/i, '/v1/models');
    return url.href;
  }
  return `${normalized}/models`;
}

export function chatCompletionsEndpoint(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/chat/completions`;
}

export function inspectModels(payload: unknown): ModelListInspection {
  let list: unknown[] | undefined;
  if (Array.isArray(payload)) list = payload;
  else if (payload && typeof payload === 'object') {
    const root = payload as { data?: unknown; models?: unknown };
    if (Array.isArray(root.data)) list = root.data;
    else if (Array.isArray(root.models)) list = root.models;
  }
  if (!list) return { recognized: false, models: [], invalidItems: 0 };

  const models: ModelInfo[] = [];
  let invalidItems = 0;
  for (const item of list) {
    if (typeof item === 'string' && item.trim()) { models.push({ id: item }); continue; }
    if (item && typeof item === 'object') {
      const value = item as Record<string, unknown>;
      const id = typeof value.id === 'string' ? value.id : typeof value.name === 'string' ? value.name : '';
      if (id.trim()) {
        const model: ModelInfo = { id };
        if (typeof value.name === 'string') model.name = value.name;
        if (typeof value.context_length === 'number') model.context_length = value.context_length;
        models.push(model);
        continue;
      }
    }
    invalidItems += 1;
  }
  return { recognized: true, models: [...new Map(models.map((model) => [model.id, model])).values()].sort((a, b) => a.id.localeCompare(b.id)), invalidItems };
}

export function parseModels(payload: unknown): ModelInfo[] {
  return inspectModels(payload).models;
}
