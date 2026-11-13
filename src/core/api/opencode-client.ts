import type { AppSettings, CompletionResult, ConnectionDiagnostic, ToolCall } from '../../shared/types';
import { chatCompletionsEndpoint, inspectModels, modelsEndpoint, normalizeBaseUrl } from './model-manager';
import { createSseParser } from './sse-parser';

export interface ChatTurn { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; name?: string; tool_call_id?: string; tool_calls?: unknown[]; }
export interface ClientOptions { signal?: AbortSignal; onToken?: (chunk: string) => void; }

type ErrorStage = 'configuration' | 'fetch' | 'timeout' | 'cancelled' | 'http' | 'parse' | 'models' | 'completion';
interface RequestMetadata { url: string; method: 'GET' | 'POST'; startedAt: number; durationMs: number; status?: number; contentType?: string; }
interface RequestHandle { response: Response; metadata: RequestMetadata; signal: AbortSignal; release: () => void; }

export class ApiRequestError extends Error {
  readonly errorType: string;
  readonly request?: RequestMetadata;
  constructor(message: string, readonly stage: ErrorStage, options: { name?: string; cause?: unknown; request?: RequestMetadata } = {}) {
    super(message, { cause: options.cause });
    this.name = options.name ?? 'ApiRequestError';
    this.errorType = this.name;
    this.request = options.request;
  }
}

export class OpenCodeClient {
  private readonly fetcher: typeof fetch;

  constructor(private readonly settings: AppSettings, private readonly apiKey: string, fetcher?: typeof fetch) {
    this.fetcher = fetcher ?? globalThis.fetch.bind(globalThis);
  }

  async listModels(signal?: AbortSignal) {
    const request = await this.request(modelsEndpoint(this.normalizedBaseUrl()), { method: 'GET', signal, headers: { Accept: 'application/json' } });
    try {
      if (!request.response.ok) throw await this.responseError(request.response, request.metadata, request.signal);
      return inspectModels(await this.readJson(request.response, request.metadata, request.signal)).models;
    } finally { request.release(); }
  }

  async testConnection(signal?: AbortSignal): Promise<ConnectionDiagnostic> {
    const startedAt = Date.now();
    let baseUrl = this.displayBaseUrl();
    let requestUrl: string | undefined;
    let metadata: RequestMetadata | undefined;
    try {
      baseUrl = this.normalizedBaseUrl();
      requestUrl = modelsEndpoint(baseUrl);
      const result = await this.request(requestUrl, { method: 'GET', signal, headers: { Accept: 'application/json' } });
      metadata = result.metadata;
      try {
        if (!result.response.ok) throw await this.responseError(result.response, metadata, result.signal);
        const payload = await this.readJson(result.response, metadata, result.signal);
        const inspection = inspectModels(payload);
        if (!inspection.recognized || inspection.invalidItems > 0) {
          const detail = !inspection.recognized ? '响应中没有 data、models 或模型数组。' : `响应中有 ${inspection.invalidItems} 个无法识别的模型项目。`;
          throw new ApiRequestError(`模型列表格式异常：${detail}`, 'models', { name: 'ModelListFormatError', request: metadata });
        }
        const ok = inspection.models.length > 0;
        return {
          kind: 'connection', ok, baseUrl, requestUrl, method: 'GET', startedAt, durationMs: Date.now() - startedAt,
          originPermission: 'not-checked', network: 'succeeded', httpStatus: result.response.status,
          contentType: result.response.headers.get('content-type') ?? undefined, authentication: 'not-confirmed',
          modelList: ok ? 'parsed' : 'empty', modelCount: inspection.models.length, models: inspection.models,
          message: ok ? `Models API 可访问并读取到 ${inspection.models.length} 个模型；此接口响应不能确认 API Key 是否可用于模型调用。` : 'Models API 可访问，但模型列表为空；此接口响应不能确认 API Key 是否可用于模型调用。',
        };
      } finally { result.release(); }
    } catch (error) {
      return this.failureDiagnostic('connection', baseUrl, requestUrl, startedAt, metadata ?? (error instanceof ApiRequestError ? error.request : undefined), error);
    }
  }

  async testModelCall(sessionId: string, signal?: AbortSignal): Promise<ConnectionDiagnostic> {
    const startedAt = Date.now();
    let baseUrl = this.displayBaseUrl();
    let requestUrl: string | undefined;
    let metadata: RequestMetadata | undefined;
    try {
      baseUrl = this.normalizedBaseUrl();
      requestUrl = chatCompletionsEndpoint(baseUrl);
      const body = { model: this.settings.model, messages: [{ role: 'user', content: 'Reply with exactly: OpenCode API OK' }], stream: false, temperature: 0, max_tokens: 64 };
      const result = await this.request(requestUrl, {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-opencode-session': sessionId },
        body: JSON.stringify(body),
      });
      metadata = result.metadata;
      try {
        if (!result.response.ok) throw await this.responseError(result.response, metadata, result.signal);
        const payload = await this.readJson(result.response, metadata, result.signal) as { choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }> };
        const content = payload?.choices?.[0]?.message?.content;
        const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((part) => part.text ?? '').join('') : '';
        if (!text.trim()) throw new ApiRequestError('模型调用响应没有可显示的文本内容。', 'completion', { name: 'CompletionFormatError', request: metadata });
        return {
          kind: 'model-call', ok: true, baseUrl, requestUrl, method: 'POST', startedAt, durationMs: Date.now() - startedAt,
          originPermission: 'not-checked', network: 'succeeded', httpStatus: result.response.status,
          contentType: result.response.headers.get('content-type') ?? undefined, authentication: 'accepted',
          modelCall: 'succeeded', modelId: this.settings.model, message: '模型调用成功。',
        };
      } finally { result.release(); }
    } catch (error) {
      return this.failureDiagnostic('model-call', baseUrl, requestUrl, startedAt, metadata ?? (error instanceof ApiRequestError ? error.request : undefined), error, this.settings.model);
    }
  }

  async complete(sessionId: string, messages: ChatTurn[], options: ClientOptions = {}, tools?: unknown[]): Promise<CompletionResult> {
    const body: Record<string, unknown> = {
      model: this.settings.model, messages, stream: this.settings.stream && !!options.onToken,
      temperature: this.settings.temperature,
    };
    if (this.settings.maxTokens > 0) body.max_tokens = this.settings.maxTokens;
    if (tools?.length) body.tools = tools;
    const url = chatCompletionsEndpoint(this.normalizedBaseUrl());
    const result = await this.request(url, {
      method: 'POST', signal: options.signal,
      headers: { 'Content-Type': 'application/json', Accept: body.stream ? 'text/event-stream' : 'application/json', 'x-opencode-session': sessionId },
      body: JSON.stringify(body),
    });
    try {
      if (!result.response.ok) throw await this.responseError(result.response, result.metadata, result.signal);
      if (body.stream) return await this.readStream(result.response, options.onToken, result.metadata, result.signal);
      const payload = await this.readJson(result.response, result.metadata, result.signal) as { choices?: Array<{ message?: { content?: string | Array<{ text?: string }>; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string }>; usage?: CompletionResult['usage'] };
      const choice = payload.choices?.[0];
      const raw = choice?.message?.content;
      const content = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map((part) => part.text ?? '').join('') : '';
      const toolCalls = this.parseToolCalls(choice?.message?.tool_calls);
      if (!content.trim() && !toolCalls.length) throw new ApiRequestError('模型请求已结束，但响应中没有可显示的文本或工具调用。', 'completion', { name: 'CompletionFormatError', request: result.metadata });
      const usage = payload.usage ? { ...payload.usage, total_tokens: payload.usage.total_tokens ?? (payload.usage.prompt_tokens ?? 0) + (payload.usage.completion_tokens ?? 0) } : undefined;
      return { content, toolCalls, usage, finishReason: choice?.finish_reason };
    } finally { result.release(); }
  }

  private displayBaseUrl() {
    try { return this.sanitize(normalizeBaseUrl(this.settings.baseUrl)); }
    catch {
      try {
        const url = new URL(this.settings.baseUrl.trim());
        url.username = ''; url.password = ''; url.search = ''; url.hash = '';
        return this.sanitize(`${url.origin}${url.pathname}`.slice(0, 500));
      } catch { return this.sanitize(this.settings.baseUrl.trim().slice(0, 500)); }
    }
  }

  private normalizedBaseUrl() {
    const baseUrl = normalizeBaseUrl(this.settings.baseUrl);
    if (this.apiKey && baseUrl.includes(this.apiKey)) throw new ApiRequestError('API Key 不能放在 API Base URL 中。', 'configuration', { name: 'CredentialInUrlError' });
    return baseUrl;
  }

  private sanitize(value: string) {
    let safe = value;
    if (this.apiKey) safe = safe.replaceAll(this.apiKey, '[REDACTED]');
    return safe.replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]').replace(/oc_sk_[A-Za-z0-9_-]+/g, '[REDACTED]').slice(0, 1200);
  }

  private async request(url: string, init: RequestInit): Promise<RequestHandle> {
    const startedAt = Date.now();
    const method = init.method === 'POST' ? 'POST' : 'GET';
    if (init.signal?.aborted) throw new ApiRequestError('请求已由用户取消。', 'cancelled', { name: 'AbortError', cause: init.signal.reason });
    if (!this.apiKey || /[\u0000-\u001f\u007f]/.test(this.apiKey)) {
      throw new ApiRequestError('API Key 为空或含换行、控制字符，请重新粘贴并保存。', 'configuration', { name: 'CredentialFormatError' });
    }
    const headers = new Headers(init.headers);
    try { headers.set('Authorization', `Bearer ${this.apiKey}`); }
    catch (error) { throw new ApiRequestError('API Key 无法放入 HTTP Authorization 标头，请检查格式。', 'configuration', { name: 'CredentialFormatError', cause: error }); }

    const controller = new AbortController();
    const timer = this.settings.timeoutMs > 0 ? setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), this.settings.timeoutMs) : undefined;
    const onAbort = () => controller.abort(init.signal?.reason ?? new DOMException('Request cancelled', 'AbortError'));
    init.signal?.addEventListener('abort', onAbort, { once: true });
    let released = false;
    let metadata: RequestMetadata | undefined;
    const release = () => {
      if (released) return;
      released = true;
      if (timer) clearTimeout(timer);
      init.signal?.removeEventListener('abort', onAbort);
      if (metadata) metadata.durationMs = Date.now() - startedAt;
    };
    try {
      const response = await this.fetcher(url, { ...init, headers, signal: controller.signal });
      metadata = { url, method, startedAt, durationMs: Date.now() - startedAt, status: response.status, contentType: response.headers.get('content-type') ?? undefined };
      return { response, metadata, signal: controller.signal, release };
    } catch (error) {
      const timeout = controller.signal.aborted && controller.signal.reason instanceof DOMException && controller.signal.reason.name === 'TimeoutError';
      const cancelled = !timeout && (init.signal?.aborted || (error instanceof DOMException && error.name === 'AbortError'));
      const cause = timeout ? controller.signal.reason : cancelled ? (init.signal?.reason ?? error) : error;
      const name = timeout ? 'TimeoutError' : cancelled ? 'AbortError' : error instanceof Error ? error.name : 'UnknownError';
      const stage: ErrorStage = timeout ? 'timeout' : cancelled ? 'cancelled' : 'fetch';
      const description = timeout ? '请求超过超时限制。' : cancelled ? '请求已由用户取消。' : error instanceof Error ? this.sanitize(error.message) : '浏览器未提供错误详情。';
      release();
      throw new ApiRequestError(description, stage, { name, cause, request: { url, method, startedAt, durationMs: Date.now() - startedAt } });
    }
  }

  private abortedError(signal: AbortSignal, cause: unknown, metadata: RequestMetadata): ApiRequestError {
    const reason = signal.reason;
    const timeout = reason instanceof DOMException && reason.name === 'TimeoutError';
    return new ApiRequestError(timeout ? '请求超过超时限制。' : '请求已由用户取消。', timeout ? 'timeout' : 'cancelled', {
      name: timeout ? 'TimeoutError' : 'AbortError', cause: timeout ? reason : (reason ?? cause), request: metadata,
    });
  }

  private async readJson(response: Response, metadata: RequestMetadata, signal: AbortSignal): Promise<unknown> {
    try { return await response.json() as unknown; }
    catch (error) {
      if (signal.aborted) throw this.abortedError(signal, error, metadata);
      const message = error instanceof Error ? this.sanitize(error.message) : '返回内容无法解析为 JSON。';
      throw new ApiRequestError(`API 返回的 JSON 无法解析：${message}`, 'parse', { name: error instanceof Error ? error.name : 'SyntaxError', cause: error, request: metadata });
    }
  }

  private async responseError(response: Response, metadata: RequestMetadata, signal: AbortSignal): Promise<ApiRequestError> {
    let detail = '';
    try {
      const raw = await response.text();
      if (raw) {
        try {
          const body = JSON.parse(raw) as { error?: { message?: string } | string; message?: string };
          detail = typeof body.error === 'string' ? body.error : body.error?.message ?? body.message ?? '';
        } catch { detail = raw; }
      }
    } catch (error) {
      if (signal.aborted) throw this.abortedError(signal, error, metadata);
      /* The status remains useful if the response body cannot be read. */
    }
    const reason = response.status === 401 ? '服务器拒绝了身份验证。' : response.status === 403 ? '服务器拒绝访问；请检查账户、订阅、额度或模型权限。' : response.status === 404 ? '接口路径不存在，请检查 API Base URL。' : response.status === 429 ? '请求受到限流或额度限制。' : response.status >= 500 ? 'API 服务端发生错误。' : 'API 拒绝了此请求。';
    const suffix = detail ? ` ${this.sanitize(detail).slice(0, 500)}` : '';
    return new ApiRequestError(`HTTP ${response.status}：${reason}${suffix}`, 'http', { name: 'HttpError', request: metadata });
  }

  private failureDiagnostic(kind: ConnectionDiagnostic['kind'], baseUrl: string, requestUrl: string | undefined, startedAt: number, metadata: RequestMetadata | undefined, error: unknown, modelId?: string): ConnectionDiagnostic {
    const apiError = error instanceof ApiRequestError ? error : new ApiRequestError(error instanceof Error ? this.sanitize(error.message) : '发生未知错误。', 'configuration', { name: error instanceof Error ? error.name : 'UnknownError', cause: error });
    const status = metadata?.status;
    const auth = status === 401 ? 'rejected' : 'not-confirmed';
    const network = status !== undefined || apiError.stage === 'parse' || apiError.stage === 'models' || apiError.stage === 'completion' || apiError.stage === 'http' ? 'succeeded' : apiError.stage === 'configuration' || apiError.stage === 'cancelled' ? 'not-started' : 'failed';
    return {
      kind, ok: false, baseUrl, requestUrl: metadata?.url ?? requestUrl, method: kind === 'connection' ? 'GET' : 'POST', startedAt,
      durationMs: metadata?.durationMs ?? apiError.request?.durationMs, originPermission: 'not-checked', network, httpStatus: status,
      contentType: metadata?.contentType, authentication: auth,
      ...(kind === 'connection' ? { modelList: apiError.stage === 'http' || apiError.stage === 'fetch' || apiError.stage === 'timeout' || apiError.stage === 'cancelled' || apiError.stage === 'configuration' ? 'not-checked' as const : 'invalid' as const } : { modelCall: network === 'not-started' ? 'not-started' as const : 'failed' as const, modelId }),
      errorType: apiError.errorType, errorStage: apiError.stage, errorMessage: this.sanitize(apiError.message), message: this.sanitize(apiError.message),
      ...(apiError.cause instanceof Error ? { errorCauseType: apiError.cause.name, errorCauseMessage: this.sanitize(apiError.cause.message) } : {}),
    };
  }

  private parseToolCalls(calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>): ToolCall[] {
    return (calls ?? []).flatMap((call, index) => {
      try {
        const name = call.function?.name;
        if (!name) return [];
        return [{ id: call.id ?? `call_${index}`, name, arguments: JSON.parse(call.function?.arguments ?? '{}') as Record<string, unknown> }];
      } catch { return []; }
    });
  }

  private async readStream(response: Response, onToken: ((chunk: string) => void) | undefined, metadata: RequestMetadata, signal: AbortSignal): Promise<CompletionResult> {
    if (!response.body) throw new ApiRequestError('流式响应没有可读取的内容。', 'completion', { name: 'EmptyStreamError' });
    const reader = response.body.getReader(); const decoder = new TextDecoder();
    let content = ''; let promptTokens: number | undefined; let completionTokens: number | undefined; let finishReason: string | undefined;
    let streamFinished = false;
    const toolParts = new Map<number, { id: string; name: string; arguments: string }>();
    const parser = createSseParser((event) => {
      if (event.data === '[DONE]') { streamFinished = true; return; }
      let payload: { choices?: Array<{ delta?: { content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      try { payload = JSON.parse(event.data) as typeof payload; }
      catch { throw new ApiRequestError('流式响应包含无法解析的 JSON 数据。', 'parse', { name: 'StreamFormatError', request: metadata }); }
      const choice = payload.choices?.[0];
      const text = choice?.delta?.content;
      if (text) { content += text; onToken?.(text); }
      for (const [position, part] of (choice?.delta?.tool_calls ?? []).entries()) {
        const index = part.index ?? position; const current = toolParts.get(index) ?? { id: '', name: '', arguments: '' };
        if (part.id) current.id = part.id;
        if (part.function?.name) current.name += part.function.name;
        if (part.function?.arguments) current.arguments += part.function.arguments;
        toolParts.set(index, current);
      }
      finishReason = choice?.finish_reason ?? finishReason;
      promptTokens = payload.usage?.prompt_tokens ?? promptTokens; completionTokens = payload.usage?.completion_tokens ?? completionTokens;
    });
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        parser.feed(decoder.decode(value, { stream: true }));
        if (streamFinished) { void reader.cancel().catch(() => undefined); break; }
      }
      parser.feed(decoder.decode()); parser.finish();
    } catch (error) {
      if (error instanceof ApiRequestError) throw error;
      if (signal.aborted) throw this.abortedError(signal, error, metadata);
      throw new ApiRequestError(error instanceof Error ? this.sanitize(error.message) : '读取流式响应失败。', error instanceof DOMException && error.name === 'AbortError' ? 'cancelled' : 'completion', { name: error instanceof Error ? error.name : 'StreamReadError', cause: error });
    }
    const toolCalls = [...toolParts.values()].flatMap((part) => { try { return part.name ? [{ id: part.id || `call_${Math.random()}`, name: part.name, arguments: JSON.parse(part.arguments || '{}') as Record<string, unknown> }] : []; } catch { return []; } });
    if (!content.trim() && !toolCalls.length) throw new ApiRequestError('流式请求已结束，但没有收到可显示的文本或工具调用。', 'completion', { name: 'CompletionFormatError', request: metadata });
    return { content, toolCalls, usage: promptTokens || completionTokens ? { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: (promptTokens ?? 0) + (completionTokens ?? 0) } : undefined, finishReason };
  }
}
