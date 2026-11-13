export type Mode = 'chat' | 'agent' | 'research';
export type Role = 'user' | 'assistant' | 'system' | 'tool';
export interface ChatMessage { id: string; role: Role; content: string; createdAt: number; toolCallId?: string; }
export interface ChatSession { id: string; title: string; sessionId: string; model: string; messages: ChatMessage[]; updatedAt: number; }
export interface ChatToolAction { id: string; label: string; prompt: string; context: 'page' | 'selection' | 'auto'; }
export const DEFAULT_CHAT_TOOLS: ChatToolAction[] = [
  { id: 'summarize', label: '总结', prompt: '请用中文总结以下内容，列出主要观点和结论。', context: 'auto' },
  { id: 'translate', label: '翻译', prompt: '请将以下内容翻译成简体中文，保留标题和列表结构。', context: 'auto' },
  { id: 'extract', label: '提取要点', prompt: '请提取内容中的关键事实、数据和表格，注明来源位置。', context: 'page' },
];
export interface AppSettings {
  baseUrl: string; model: string; maxTokens: number; temperature: number; timeoutMs: number; stream: boolean;
  maxAgentSteps: number; maxAgentMinutes: number; separateAgentTab: boolean; confirmEveryAction: boolean;
  maxResearchPages: number; maxResearchSteps: number; maxResearchMinutes: number; reportLanguage: string; searchEngine: 'bing' | 'google';
  chatTools: ChatToolAction[];
}
export interface PageSnapshot {
  title: string; url: string; markdown: string; text: string; textLength?: number; markdownLength?: number; contentRevision?: number; headings: { level: number; text: string }[];
  links: { text: string; url: string }[]; images: { alt: string; url: string }[]; tables: string[][][];
  author?: string; publishedAt?: string; selectedText?: string;
}
export interface ModelInfo { id: string; name?: string; context_length?: number; }
export interface ConnectionDiagnostic {
  kind: 'connection' | 'model-call';
  ok: boolean;
  baseUrl: string;
  requestUrl?: string;
  method: 'GET' | 'POST';
  startedAt: number;
  durationMs?: number;
  originPermission: 'granted' | 'missing' | 'not-checked';
  network: 'not-started' | 'succeeded' | 'failed';
  httpStatus?: number;
  contentType?: string;
  authentication: 'not-confirmed' | 'accepted' | 'rejected';
  modelList?: 'not-checked' | 'parsed' | 'empty' | 'invalid';
  modelCount?: number;
  modelCall?: 'not-started' | 'succeeded' | 'failed';
  modelId?: string;
  models?: ModelInfo[];
  errorType?: string;
  errorStage?: string;
  errorMessage?: string;
  errorCauseType?: string;
  errorCauseMessage?: string;
  message: string;
}
export interface ToolCall { id: string; name: string; arguments: Record<string, unknown>; }
export interface CompletionResult { content: string; toolCalls: ToolCall[]; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }; finishReason?: string; }
export interface ApiCallRecord { id: string; mode: 'chat' | 'agent' | 'research'; model: string; sessionId: string; requestedAt: number; durationMs: number; status: 'ok' | 'error'; promptTokens?: number; completionTokens?: number; error?: string; }
export interface AgentStep { index: number; tool: string; arguments: Record<string, unknown>; status: 'running' | 'done' | 'error' | 'blocked'; result?: string; at: number; }
export interface SourceRecord { index: number; url: string; title: string; accessedAt: number; excerpt: string; status: 'read' | 'blocked' | 'failed'; }
export interface TaskRecord {
  id: string; kind: 'agent' | 'research'; task: string; sessionId: string; status: 'running' | 'paused' | 'awaiting-confirmation' | 'completed' | 'stopped' | 'failed';
  steps: AgentStep[]; sources: SourceRecord[]; answer?: string; report?: string; error?: string; startedAt: number; updatedAt: number; tabId?: number;
  pendingConfirmation?: { tool: string; arguments: Record<string, unknown>; reason: string };
}
export interface ToolDefinition { name: string; description: string; parameters: Record<string, unknown>; readOnly: boolean; }
