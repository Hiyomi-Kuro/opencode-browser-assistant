import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Bot, BookOpen, Check, ChevronDown, CircleAlert, Code2, Copy, ExternalLink, FileDown, Globe2, LoaderCircle, MessageCircle, Pause, Pencil, Play, Plus, Settings2, ShieldCheck, Square, Trash2, Wrench, X } from 'lucide-react';
import { DEFAULT_CHAT_TOOLS, type ApiCallRecord, type AppSettings, type ChatMessage, type ChatSession, type ChatToolAction, type ConnectionDiagnostic, type Mode, type ModelInfo, type TaskRecord } from '../shared/types';
import { createSessionId } from '../core/api/session-ids';
import { normalizeBaseUrl } from '../core/api/model-manager';
import { ensureApiOriginPermission } from '../core/api/host-permissions';

type Bootstrap = { settings: AppSettings; hasApiKey: boolean; tabs: Array<{ id: number; title?: string; url?: string; active: boolean }>; chats: ChatSession[]; tasks: TaskRecord[]; calls: ApiCallRecord[] };
type ApiResponse<T> = { ok: true; result: T } | { ok: false; error: string };
type ChatToolDraft = Omit<ChatToolAction, 'id'> & { id?: string };
const send = async <T,>(type: string, payload: Record<string, unknown> = {}): Promise<T> => {
  const response = await chrome.runtime.sendMessage({ type, ...payload }) as ApiResponse<T>;
  if (!response?.ok) throw new Error(response?.error ?? '扩展后台无响应。');
  return response.result;
};
const emptySettings: AppSettings = {
  baseUrl: 'https://opencode.ai/inference/go/openai/v1', model: 'deepseek-v4.1-flash', maxTokens: 0, temperature: 0.7,
  timeoutMs: 0, stream: true, maxAgentSteps: 0, maxAgentMinutes: 0, separateAgentTab: true, confirmEveryAction: false,
  maxResearchPages: 0, maxResearchSteps: 0, maxResearchMinutes: 0, reportLanguage: '简体中文', searchEngine: 'bing', chatTools: DEFAULT_CHAT_TOOLS,
};
const uid = () => crypto.randomUUID();
const defaultChat = (): ChatSession => ({ id: uid(), title: '新对话', sessionId: createSessionId(), model: emptySettings.model, messages: [], updatedAt: Date.now() });

export default function App() {
  const [mode, setMode] = useState<Mode>('chat');
  const [settings, setSettings] = useState<AppSettings>(emptySettings);
  const [hasKey, setHasKey] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [chats, setChats] = useState<ChatSession[]>([]);
  const chatsRef = useRef(chats); chatsRef.current = chats;
  const [activeChatId, setActiveChatId] = useState('');
  const activeChat = chats.find((chat) => chat.id === activeChatId);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsQuery, setModelsQuery] = useState('');
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [calls, setCalls] = useState<ApiCallRecord[]>([]);
  const [diagnostic, setDiagnostic] = useState<ConnectionDiagnostic | null>(null);
  const [diagnosticBusy, setDiagnosticBusy] = useState(false);
  const [diagnosticKind, setDiagnosticKind] = useState<ConnectionDiagnostic['kind'] | null>(null);
  const [taskInput, setTaskInput] = useState('');
  const [selectedTaskId, setSelectedTaskId] = useState('');
  const isNewTaskConversation = selectedTaskId === `new:${mode}`;
  const selectedTask = isNewTaskConversation ? undefined : tasks.find((task) => task.id === selectedTaskId && task.kind === mode) ?? tasks.find((task) => task.kind === mode && (task.status === 'running' || task.status === 'paused' || task.status === 'awaiting-confirmation'));
  const [messageInput, setMessageInput] = useState('');
  const [includePage, setIncludePage] = useState(false);
  const [includeSelection, setIncludeSelection] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [toolDraft, setToolDraft] = useState<ChatToolDraft | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const chatPort = useRef<chrome.runtime.Port | null>(null);
  const requestRef = useRef<{ id: string; chatId: string; assistantId: string } | null>(null);
  const chatTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const diagnosticLock = useRef(false);

  useEffect(() => {
    let alive = true;
    void send<Bootstrap>('GET_BOOTSTRAP').then((data) => {
      if (!alive) return;
      setSettings(data.settings); setHasKey(data.hasApiKey); setChats(data.chats); setTasks(data.tasks); setCalls(data.calls);
      if (data.chats.length) setActiveChatId(data.chats[0].id);
      else { const chat = defaultChat(); setChats([chat]); setActiveChatId(chat.id); }
      const running = data.tasks.find((task) => ['running', 'paused', 'awaiting-confirmation'].includes(task.status)); if (running) setSelectedTaskId(running.id);
    }).catch((error: Error) => setStatus(error.message));
    const connectChatPort = () => {
      if (!alive) return;
      let port: chrome.runtime.Port;
      try { port = chrome.runtime.connect({ name: 'opencode-chat' }); }
      catch (error) { setStatus(`无法连接扩展后台：${(error as Error).message}`); return; }
      chatPort.current = port;
      port.onMessage.addListener((event: { type: string; requestId?: string; chunk?: string; elapsedMs?: number; stage?: string; result?: { content: string }; error?: string }) => {
        const request = requestRef.current; if (!request || event.requestId !== request.id) return;
        if (event.type === 'CHAT_STAGE') setStatus(event.stage ?? '正在处理请求…');
        if (event.type === 'CHAT_PROGRESS') setStatus(`模型仍在处理中，已等待 ${Math.floor((event.elapsedMs ?? 0) / 1000)} 秒…`);
        if (event.type === 'CHAT_TOKEN') updateMessage(request.chatId, request.assistantId, (message) => ({ ...message, content: message.content + (event.chunk ?? '') }));
        if (event.type === 'CHAT_DONE') {
          const content = event.result?.content ?? '';
          updateMessage(request.chatId, request.assistantId, (message) => ({ ...message, content: content || message.content || '模型请求已结束，但未返回可显示的文本。' }));
          requestRef.current = null; if (chatTimerRef.current) clearTimeout(chatTimerRef.current); chatTimerRef.current = null; setLoading(false); setStatus('');
        }
        if (event.type === 'CHAT_ERROR') failChatRequest(request, `请求失败：${event.error ?? '未知错误'}`);
      });
      port.onDisconnect.addListener(() => {
        if (chatPort.current === port) chatPort.current = null;
        if (!alive) return;
        const request = requestRef.current;
        if (request) failChatRequest(request, '扩展后台连接中断，当前回复已停止。请重新发送。');
        reconnectTimer = setTimeout(connectChatPort, 500);
      });
    };
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    connectChatPort();
    const runtimeListener = (message: { type?: string; task?: TaskRecord; call?: ApiCallRecord }) => {
      if (message.type === 'TASK_UPDATE' && message.task) setTasks((prev) => [message.task!, ...prev.filter((task) => task.id !== message.task!.id)]);
      if (message.type === 'API_CALL_UPDATE' && message.call) setCalls((prev) => [message.call as ApiCallRecord, ...prev].slice(0, 200));
    };
    chrome.runtime.onMessage.addListener(runtimeListener);
    return () => {
      alive = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (chatTimerRef.current) clearTimeout(chatTimerRef.current);
      chatTimerRef.current = null;
      chatPort.current?.disconnect(); chatPort.current = null;
      chrome.runtime.onMessage.removeListener(runtimeListener);
    };
  }, []);

  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [activeChat?.messages, selectedTask?.steps]);
  useEffect(() => { if (!settingsOpen && !historyOpen) composerRef.current?.focus({ preventScroll: true }); }, [settingsOpen, historyOpen, mode]);
  useEffect(() => { if (!activeChat) return; const next = chatsRef.current; void send('SAVE_CHATS', { chats: next }).catch(() => undefined); }, [chats]);

  function updateMessage(chatId: string, messageId: string, mutate: (message: ChatMessage) => ChatMessage) {
    setChats((previous) => previous.map((chat) => chat.id === chatId ? { ...chat, messages: chat.messages.map((message) => message.id === messageId ? mutate(message) : message), updatedAt: Date.now() } : chat));
  }

  function failChatRequest(request: { id: string; chatId: string; assistantId: string } | null, message: string) {
    if (!request) return;
    updateMessage(request.chatId, request.assistantId, (previous) => ({ ...previous, content: previous.content ? `${previous.content}\n\n> ${message}` : message }));
    requestRef.current = null;
    if (chatTimerRef.current) clearTimeout(chatTimerRef.current);
    chatTimerRef.current = null; setLoading(false); setStatus(message);
  }

  const visibleModels = useMemo(() => models.filter((item) => `${item.id} ${item.name ?? ''}`.toLowerCase().includes(modelsQuery.toLowerCase())), [models, modelsQuery]);

  const persistSettings = async () => {
    const nextSettings = { ...settings, baseUrl: normalizeBaseUrl(settings.baseUrl) };
    const result = await send<{ settings: AppSettings; hasApiKey: boolean }>('SAVE_SETTINGS', { settings: nextSettings, apiKey: keyInput });
    setSettings(result.settings); setHasKey(result.hasApiKey); setKeyInput(''); setSaved(true); setDiagnostic(null); setModels([]);
    return result.settings;
  };

  const saveSettings = async (event?: FormEvent) => {
    event?.preventDefault(); setSaved(false); setStatus('正在保存设置…');
    try { await persistSettings(); setStatus('设置已保存'); }
    catch (error) { setStatus((error as Error).message); }
  };

  const runDiagnostic = async (kind: ConnectionDiagnostic['kind']) => {
    if (diagnosticLock.current) return;
    diagnosticLock.current = true; setDiagnosticBusy(true); setDiagnosticKind(kind); setDiagnostic(null);
    setStatus(kind === 'connection' ? '正在检查 Models API…' : '正在调用所选模型…');
    const startedAt = Date.now();
    let baseUrl = '';
    try {
      baseUrl = normalizeBaseUrl(settings.baseUrl);
      if (!hasKey && !keyInput.trim()) throw new Error('尚未保存 API Key，请输入并保存后重试。');
      if (/[\u0000-\u001f\u007f]/.test(keyInput)) throw new Error('API Key 不能包含换行或控制字符，请重新粘贴。');
      await ensureApiOriginPermission(chrome.permissions, baseUrl);
      await persistSettings();
      const result = await send<ConnectionDiagnostic>(kind === 'connection' ? 'TEST_CONNECTION' : 'TEST_MODEL_CALL');
      setDiagnostic(result);
      if (kind === 'connection') setModels(result.models ?? []);
      setStatus(result.message);
    } catch (error) {
      const message = (error as Error).message || '诊断未能完成。';
      const localResult: ConnectionDiagnostic = {
        kind, ok: false, baseUrl, method: kind === 'connection' ? 'GET' : 'POST', startedAt,
        originPermission: 'not-checked', network: 'not-started', authentication: 'not-confirmed',
        ...(kind === 'connection' ? { modelList: 'not-checked' } : { modelCall: 'not-started', modelId: settings.model }),
        errorType: (error as Error).name || 'Error', errorStage: 'configuration', errorMessage: message, message,
      };
      setDiagnostic(localResult); setStatus(message);
    } finally { diagnosticLock.current = false; setDiagnosticBusy(false); setDiagnosticKind(null); }
  };

  const testConnection = () => runDiagnostic('connection');
  const testModelCall = () => runDiagnostic('model-call');
  const copyDiagnostic = async () => {
    if (!diagnostic) return;
    const report = {
      baseUrl: diagnostic.baseUrl,
      requestUrl: diagnostic.requestUrl,
      method: diagnostic.method,
      time: new Date(diagnostic.startedAt).toISOString(),
      durationMs: diagnostic.durationMs,
      apiOriginPermission: diagnostic.originPermission,
      network: diagnostic.network,
      httpStatus: diagnostic.httpStatus,
      contentType: diagnostic.contentType,
      authentication: diagnostic.authentication,
      modelList: diagnostic.modelList,
      modelCount: diagnostic.modelCount,
      modelCall: diagnostic.modelCall,
      modelId: diagnostic.modelId,
      errorType: diagnostic.errorType,
      errorStage: diagnostic.errorStage,
      errorMessage: diagnostic.errorMessage,
      errorCauseType: diagnostic.errorCauseType,
      errorCauseMessage: diagnostic.errorCauseMessage,
      result: diagnostic.message,
    };
    try { await navigator.clipboard.writeText(JSON.stringify(report, null, 2)); setStatus('已复制诊断信息（不含 API Key 或请求正文）'); }
    catch { setStatus('无法访问剪贴板，请检查浏览器扩展权限。'); }
  };

  const createChat = () => { const next = defaultChat(); setChats((prev) => [next, ...prev]); setActiveChatId(next.id); setMode('chat'); setHistoryOpen(false); };
  const createTaskConversation = () => { setSelectedTaskId(`new:${mode}`); setTaskInput(''); setHistoryOpen(false); };
  const deleteChat = (id: string) => { const remaining = chats.filter((chat) => chat.id !== id); setChats(remaining); if (id === activeChatId) { const next = remaining[0] ?? defaultChat(); setChats(remaining.length ? remaining : [next]); setActiveChatId(next.id); } };

  const runChat = useCallback(async (text: string, options: { includePage?: boolean; replaceLast?: boolean } = {}) => {
    if (!hasKey) { setSettingsOpen(true); setStatus('请先配置 OpenCode Go API Key。'); return; }
    const chat = chatsRef.current.find((item) => item.id === activeChatId); if (!chat || !text.trim() || loading) return;
    try {
      const baseUrl = normalizeBaseUrl(settings.baseUrl);
      if ((await ensureApiOriginPermission(chrome.permissions, baseUrl)) !== 'granted') { setStatus(`未授予 API 域名 ${new URL(baseUrl).origin} 的访问权限。`); return; }
      const saved = await send<{ settings: AppSettings; hasApiKey: boolean }>('SAVE_SETTINGS', { settings: { ...settings, baseUrl }, apiKey: '' });
      setSettings(saved.settings); setHasKey(saved.hasApiKey);
    } catch (error) { setStatus((error as Error).message); return; }
    let messages = chat.messages;
    if (options.replaceLast) messages = messages.filter((message) => message.role !== 'assistant' || message !== messages.at(-1));
    else messages = [...messages, { id: uid(), role: 'user', content: text.trim(), createdAt: Date.now() }];
    const userMessage = messages.filter((message) => message.role === 'user').at(-1);
    const assistant: ChatMessage = { id: uid(), role: 'assistant', content: '', createdAt: Date.now() };
    const nextMessages = [...messages, assistant];
    setChats((previous) => previous.map((item) => item.id === chat.id ? { ...item, title: item.messages.length ? item.title : text.trim().slice(0, 44), model: settings.model, messages: nextMessages, updatedAt: Date.now() } : item));
    setLoading(true); setStatus(''); const requestId = uid(); requestRef.current = { id: requestId, chatId: chat.id, assistantId: assistant.id };
    if (chatTimerRef.current) clearTimeout(chatTimerRef.current);
    if (settings.timeoutMs > 0) {
      chatTimerRef.current = setTimeout(() => {
        const request = requestRef.current;
        if (!request || request.id !== requestId) return;
        try { chatPort.current?.postMessage({ type: 'CHAT_CANCEL', requestId }); } catch { /* the port may already be disconnected */ }
        failChatRequest(request, `请求超过 ${settings.timeoutMs} ms，已停止。`);
      }, settings.timeoutMs + 5000);
    }
    const port = chatPort.current;
    if (!port) { failChatRequest(requestRef.current, '扩展后台未连接，无法发送请求。请重试。'); return; }
    try { port.postMessage({ type: 'CHAT_SEND', requestId, sessionId: chat.sessionId, messages: [...messages, ...(userMessage && !messages.includes(userMessage) ? [userMessage] : [])], includePage: options.includePage ?? includePage }); }
    catch { failChatRequest(requestRef.current, '无法将请求发送到扩展后台，请重试。'); }
  }, [activeChatId, hasKey, includePage, loading, settings]);

  const onChatSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const text = messageInput.trim();
    if (!text || loading) return;
    let content = text;
    if (includeSelection) {
      try {
        const selected = await send<string>('GET_SELECTED_TEXT');
        if (!selected.trim()) { setStatus('请先在当前网页中选中一段文字。'); return; }
        content = `${text}\n\n当前网页选中的文字：\n<selected-text>\n${selected}\n</selected-text>`;
        setIncludeSelection(false);
      } catch (error) { setStatus((error as Error).message); return; }
    }
    setMessageInput('');
    runChat(content, { includePage });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); composerRef.current?.form?.requestSubmit(); } };

  const runChatTool = async (tool: ChatToolAction) => {
    try {
      const useSelection = tool.context === 'selection' || (tool.context === 'auto' && includeSelection);
      let prompt = tool.prompt;
      if (useSelection) {
        const selected = await send<string>('GET_SELECTED_TEXT');
        if (!selected.trim()) { setStatus('请先在当前网页中选中一段文字。'); return; }
        prompt = `${tool.prompt}\n\n请处理当前网页选中的文字：\n<selected-text>\n${selected}\n</selected-text>`;
        setIncludeSelection(false);
      }
      setMode('chat'); setToolsOpen(false); setToolDraft(null);
      runChat(prompt, { includePage: tool.context === 'page' || (!useSelection && tool.context === 'auto') || includePage });
    } catch (error) { setStatus((error as Error).message); }
  };

  const persistChatTools = async (chatTools: ChatToolAction[]) => {
    try {
      const result = await send<{ settings: AppSettings; hasApiKey: boolean }>('SAVE_SETTINGS', { settings: { ...settings, chatTools }, apiKey: '' });
      setSettings(result.settings); setHasKey(result.hasApiKey); setStatus('工具已保存');
      return true;
    } catch (error) { setStatus((error as Error).message); return false; }
  };
  const saveToolDraft = async () => {
    if (!toolDraft) return;
    const label = toolDraft.label.trim(); const prompt = toolDraft.prompt.trim();
    if (!label || !prompt) { setStatus('请填写工具名称和提示词。'); return; }
    if (!toolDraft.id && settings.chatTools.length >= 20) { setStatus('最多可设置 20 个工具。'); return; }
    const next = toolDraft.id
      ? settings.chatTools.map((tool) => tool.id === toolDraft.id ? { ...tool, label: label.slice(0, 32), prompt: prompt.slice(0, 4000), context: toolDraft.context } : tool)
      : [...settings.chatTools, { id: uid(), label: label.slice(0, 32), prompt: prompt.slice(0, 4000), context: toolDraft.context }];
    if (await persistChatTools(next)) setToolDraft(null);
  };
  const deleteChatTool = async (id: string) => {
    const next = settings.chatTools.filter((tool) => tool.id !== id);
    if (await persistChatTools(next) && toolDraft?.id === id) setToolDraft(null);
  };

  const startTask = async (kind: 'agent' | 'research') => {
    const text = taskInput.trim(); if (!text) return;
    if (!hasKey) { setSettingsOpen(true); setStatus('请先配置 OpenCode Go API Key。'); return; }
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.url) throw new Error('无法读取当前标签页地址。');
      const pageUrl = new URL(tab.url);
      if (!['http:', 'https:'].includes(pageUrl.protocol)) throw new Error('Agent 和 Research 只能在 HTTP 或 HTTPS 网页上运行。');
      const baseUrl = normalizeBaseUrl(settings.baseUrl);
      if ((await ensureApiOriginPermission(chrome.permissions, baseUrl)) !== 'granted') throw new Error(`需要授予 API 域名 ${new URL(baseUrl).origin} 的访问权限。`);
      const pageOrigins = [`${pageUrl.origin}/*`];
      const pagePermission = await chrome.permissions.contains({ origins: pageOrigins });
      if (!pagePermission && !(await chrome.permissions.request({ origins: pageOrigins }))) throw new Error(`需要授予当前网页 ${pageUrl.origin} 的访问权限，才能执行浏览器任务。`);
      const saved = await send<{ settings: AppSettings; hasApiKey: boolean }>('SAVE_SETTINGS', { settings: { ...settings, baseUrl }, apiKey: '' });
      setSettings(saved.settings); setHasKey(saved.hasApiKey);
      const task = await send<TaskRecord>(kind === 'research' ? 'RESEARCH_START' : 'AGENT_START', { task: text, tabId: tab?.id });
      setTasks((prev) => [task, ...prev.filter((item) => item.id !== task.id)]); setSelectedTaskId(task.id); setTaskInput(''); setStatus('');
    } catch (error) { setStatus((error as Error).message); }
  };

  const taskControl = async (action: string, approved?: boolean) => {
    if (!selectedTask) return;
    try { const updated = await send<TaskRecord>('TASK_CONTROL', { taskId: selectedTask.id, action, approved }); setTasks((prev) => [updated, ...prev.filter((item) => item.id !== updated.id)]); }
    catch (error) { setStatus((error as Error).message); }
  };

  const copyText = async (text: string) => { await navigator.clipboard.writeText(text); setStatus('已复制到剪贴板'); setTimeout(() => setStatus(''), 1500); };
  const exportMarkdown = (text: string, name: string) => { const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url); };
  const exportData = async () => { const data = await send<Bootstrap>('GET_BOOTSTRAP'); const blob = new Blob([JSON.stringify({ settings: data.settings, chats: data.chats, tasks: data.tasks, calls: data.calls }, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'opencode-export.json'; a.click(); URL.revokeObjectURL(url); };
  const clearHistory = async () => { await send('CLEAR_HISTORY'); setChats([]); setTasks([]); setCalls([]); createChat(); };

  if (settingsOpen) return <div className="settings-page">
    <header className="settings-header"><button className="icon-button" onClick={() => setSettingsOpen(false)} aria-label="Back"><X size={18} /></button><div><strong>设置</strong><span>OpenCode Go 与工作偏好</span></div><div className="spacer" /></header>
    <form onSubmit={(event) => void saveSettings(event)}>
      <section className="setting-card"><div className="section-title"><span>OpenCode Go API</span><span className="secure-tag"><ShieldCheck size={13} /> 本地保存</span></div>
        <label>API Base URL<input value={settings.baseUrl} onChange={(e) => setSettings({ ...settings, baseUrl: e.target.value })} placeholder="https://opencode.ai/inference/go/openai/v1" /></label>
        <label>API Key<input type="password" autoComplete="new-password" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} placeholder={hasKey ? '已保存 · 输入新 Key 以替换' : 'oc_sk_…'} /></label>
        <div className="inline-actions"><button className="secondary-button" type="button" disabled={diagnosticBusy} onClick={() => void testConnection()}>{diagnosticKind === 'connection' ? '正在测试…' : '测试连接'}</button><button className="secondary-button" type="button" disabled={diagnosticBusy} onClick={() => void testModelCall()}>{diagnosticKind === 'model-call' ? '正在调用…' : '测试模型调用'}</button></div>
        <p className="hint">模型调用测试会发送一条独立的短消息，并可能消耗 Go 订阅额度。它只会在你点击按钮时运行，不会随连接测试自动执行。</p>
        {diagnostic && <section className={`connection-diagnostic ${diagnostic.ok ? 'success' : 'failure'}`} aria-live="polite">
          <div className="diagnostic-heading"><strong>连接诊断</strong><span>{diagnostic.ok ? '成功' : '失败'}</span></div>
          <p className="diagnostic-message">{diagnostic.message}</p>
          <dl>
            <div><dt>API 地址</dt><dd>{diagnostic.baseUrl || '未验证'}</dd></div>
            <div><dt>实际请求</dt><dd>{diagnostic.method} {diagnostic.requestUrl || '未发送'}</dd></div>
            <div><dt>API 域名权限</dt><dd>{diagnostic.originPermission === 'granted' ? '已授权' : diagnostic.originPermission === 'missing' ? '未授权' : '未检查'}</dd></div>
            <div><dt>网络请求</dt><dd>{diagnostic.network === 'succeeded' ? '已收到 HTTP 响应' : diagnostic.network === 'failed' ? '请求失败' : '未发送'}</dd></div>
            <div><dt>HTTP 状态</dt><dd>{diagnostic.httpStatus ?? '—'}</dd></div>
            <div><dt>身份验证</dt><dd>{diagnostic.authentication === 'accepted' ? '已通过' : diagnostic.authentication === 'rejected' ? '被服务器拒绝' : '未确认'}</dd></div>
            {diagnostic.modelList && <div><dt>模型列表</dt><dd>{diagnostic.modelList === 'parsed' ? '已解析' : diagnostic.modelList === 'empty' ? '为空' : diagnostic.modelList === 'invalid' ? '格式异常' : '未读取'}</dd></div>}
            {diagnostic.modelCount !== undefined && <div><dt>可用模型</dt><dd>{diagnostic.modelCount}</dd></div>}
            {diagnostic.modelId && <div><dt>测试模型</dt><dd>{diagnostic.modelId} · {diagnostic.modelCall === 'succeeded' ? '调用成功' : diagnostic.modelCall === 'failed' ? '调用失败' : '未调用'}</dd></div>}
            {diagnostic.durationMs !== undefined && <div><dt>请求耗时</dt><dd>{diagnostic.durationMs} ms</dd></div>}
            {diagnostic.contentType && <div><dt>Content-Type</dt><dd>{diagnostic.contentType}</dd></div>}
            {diagnostic.errorType && <div><dt>错误类型 / 阶段</dt><dd>{diagnostic.errorType} · {diagnostic.errorStage}</dd></div>}
            {diagnostic.errorMessage && <div className="diagnostic-error"><dt>详细错误</dt><dd>{diagnostic.errorMessage}</dd></div>}
            {diagnostic.errorCauseType && <div className="diagnostic-error"><dt>原始原因</dt><dd>{diagnostic.errorCauseType}: {diagnostic.errorCauseMessage}</dd></div>}
          </dl>
          <button className="secondary-button" type="button" onClick={() => void copyDiagnostic()}><Copy size={12} />复制诊断信息</button>
        </section>}
        {models.length > 0 && <><input className="search-input" value={modelsQuery} onChange={(e) => setModelsQuery(e.target.value)} placeholder="搜索模型" /><div className="model-list">{visibleModels.slice(0, 80).map((model) => <button type="button" key={model.id} className={`model-row ${settings.model === model.id ? 'selected' : ''}`} onClick={() => setSettings({ ...settings, model: model.id })}><span>{model.name || model.id}<small>{model.id}</small></span>{settings.model === model.id && <Check size={15} />}</button>)}</div></>}
        <label>当前模型 ID<input value={settings.model} onChange={(e) => setSettings({ ...settings, model: e.target.value })} /></label>
        <label>Temperature<input type="number" min={0} max={2} step={0.1} value={settings.temperature} onChange={(e) => setSettings({ ...settings, temperature: Number(e.target.value) })} /></label>
        <p className="hint">请求没有固定超时或应用层 Token 上限；较长回复会按模型接口返回的长度状态继续分段请求。仍可随时手动停止。</p>
        <Toggle label="启用流式输出" checked={settings.stream} onChange={(value) => setSettings({ ...settings, stream: value })} />
        <p className="hint">扩展可访问所有 HTTP/HTTPS 网站。API Key 保存在扩展本地存储中，只由后台请求使用；浏览器扩展存储不提供硬件级加密。</p>
      </section>
      <section className="setting-card"><div className="section-title">Agent</div>
        <p className="hint">执行步数与运行时间不限；可随时暂停或停止。</p>
        <Toggle label="默认创建独立工作标签页" checked={settings.separateAgentTab} onChange={(value) => setSettings({ ...settings, separateAgentTab: value })} />
        <Toggle label="每个写入动作都需要确认" checked={settings.confirmEveryAction} onChange={(value) => setSettings({ ...settings, confirmEveryAction: value })} />
      </section>
      <section className="setting-card"><div className="section-title">Research</div>
        <label>默认报告语言<input value={settings.reportLanguage} onChange={(e) => setSettings({ ...settings, reportLanguage: e.target.value })} /></label>
        <label>搜索引擎<select value={settings.searchEngine} onChange={(e) => setSettings({ ...settings, searchEngine: e.target.value as AppSettings['searchEngine'] })}><option value="bing">Bing</option><option value="google">Google</option></select></label>
        <p className="hint">网页数量、研究步数与运行时间不限；长网页会按段读取。</p>
      </section>
      <section className="setting-card"><div className="section-title">数据管理</div><div className="inline-actions wrap"><button className="secondary-button" type="button" onClick={() => void exportData()}>导出数据</button><button className="secondary-button danger" type="button" onClick={() => { if (confirm('删除 API Key？')) void send('DELETE_API_KEY').then(() => setHasKey(false)); }}>删除 API Key</button><button className="secondary-button danger" type="button" onClick={() => { if (confirm('清除全部会话、任务和调用记录吗？')) void clearHistory().catch((error: Error) => setStatus(error.message)); }}>清除历史</button></div></section>
      <section className="setting-card"><div className="section-title">最近模型调用 <span className="call-count">{calls.length}</span></div>{calls.length ? calls.slice(0, 20).map((call) => <div className="call-row" key={call.id}><div className="call-meta"><strong>{call.model}</strong><span>{call.mode === 'chat' ? '对话' : call.mode === 'agent' ? '工作' : '研究'} · {new Date(call.requestedAt).toLocaleString()}</span></div><div className={`call-state ${call.status}`}>{call.status === 'ok' ? `${(call.promptTokens ?? 0) + (call.completionTokens ?? 0)} tokens` : '失败'}</div>{call.error && <small className="call-error">{call.error}</small>}</div>) : <p className="hint">调用完成后会记录模型、时间、耗时和 API 返回的 Token 用量，不包含 API Key。</p>}</section>
      <div className="save-row"><button className="primary-button wide" type="submit">{saved ? '已保存' : '保存设置'}</button></div>
    </form>
    {status && <div className="settings-status">{status}</div>}
  </div>;

  return <main className="app-shell">
    <header className="topbar"><div className="brand-mark"><Code2 size={20} strokeWidth={1.5} /></div><div className="brand-title"><strong>OpenCode</strong><span>{settings.model || '选择模型'}</span></div>
      <button className={`header-chip ${historyOpen ? 'active' : ''}`} aria-expanded={historyOpen} onClick={() => setHistoryOpen(!historyOpen)}><ChevronDown size={14} /> 历史</button>
      <button className="icon-button settings-trigger" onClick={() => setSettingsOpen(true)} title="设置"><Settings2 size={18} /></button></header>
    <nav className="mode-tabs" aria-label="工作模式">{([['chat', '对话', MessageCircle], ['agent', '工作', Bot], ['research', '研究', BookOpen]] as const).map(([id, label, Icon]) => <button key={id} className={`mode-tab ${mode === id ? 'selected' : ''}`} onClick={() => { setMode(id); setHistoryOpen(false); }}><Icon size={15} /><span>{label}</span></button>)}</nav>

    {historyOpen && <div className="history-panel">
      <div className="history-heading"><strong>{mode === 'chat' ? '对话历史' : mode === 'agent' ? '工作历史' : '研究历史'}</strong><button className="small-action" onClick={mode === 'chat' ? createChat : createTaskConversation}><Plus size={14} /> 新建对话</button></div>
      {mode === 'chat' ? chats.length ? chats.map((chat) => <div className={`history-row ${activeChatId === chat.id ? 'selected' : ''}`} key={chat.id}><button className="history-name" onClick={() => { setActiveChatId(chat.id); setHistoryOpen(false); }}>{chat.title}<small>{chat.messages.length} 条消息</small></button><button className="icon-button tiny danger" onClick={() => deleteChat(chat.id)} aria-label="删除会话"><Trash2 size={14} /></button></div>) : <div className="empty-small">还没有对话</div>
        : tasks.filter((task) => task.kind === mode).length ? tasks.filter((task) => task.kind === mode).map((task) => <div className={`history-row ${selectedTask?.id === task.id ? 'selected' : ''}`} key={task.id}><button className="history-name" onClick={() => { setSelectedTaskId(task.id); setTaskInput(''); setHistoryOpen(false); }}>{task.task}<small>{task.status === 'completed' ? '已完成' : task.status === 'failed' ? '失败' : task.status === 'running' ? '正在执行' : task.status === 'paused' ? '已暂停' : task.status === 'awaiting-confirmation' ? '等待确认' : '已停止'} · {task.steps.length} 步</small></button></div>) : <div className="empty-small">还没有任务</div>}
    </div>}

    {mode === 'chat' && <>
      <section className="conversation" ref={scrollRef}>
        {!activeChat?.messages.length ? <div className="welcome"><div className="welcome-icon"><Code2 size={24} strokeWidth={1.5} /></div><h1>让网页变得<br /><em>更容易理解</em></h1><p>提问、总结、翻译，或让 OpenCode 阅读当前页面。</p><div className="suggestion-grid"><button onClick={() => { setMessageInput('帮我总结当前网页的主要观点'); setIncludePage(true); }}>总结页面 <span>⌘ ↵</span></button><button onClick={() => { setMessageInput('解释这页的专业术语'); setIncludePage(true); }}>解释术语 <span>⌘ ↵</span></button></div></div> : activeChat.messages.map((message, index) => <article className={`message ${message.role}`} key={message.id}><div className="message-avatar">{message.role === 'user' ? '你' : <Code2 size={14} strokeWidth={1.5} />}</div><div className="message-body"><div className="message-content">{message.role === 'assistant' && !message.content && loading ? <span className="thinking"><i />正在思考</span> : <Markdown content={message.content} />}</div>{message.content && <div className="message-actions"><button onClick={() => void copyText(message.content)}><Copy size={12} /> 复制</button>{message.role === 'assistant' && index === activeChat.messages.length - 1 && <button onClick={() => { const lastUser = [...activeChat.messages].reverse().find((item) => item.role === 'user'); if (lastUser) runChat(lastUser.content, { replaceLast: true }); }}>重新生成</button>}</div>}</div></article>)}
      </section>
      <div className="composer-area"><div className="quick-actions-shell">
        <div className="quick-actions">
          <button type="button" className={`context-toggle ${includePage ? 'on' : ''}`} aria-pressed={includePage} onClick={() => setIncludePage(!includePage)}><Globe2 size={13} /> 当前网页 {includePage && <Check size={12} />}</button>
          <button type="button" className={`context-toggle ${includeSelection ? 'on' : ''}`} aria-pressed={includeSelection} onClick={() => setIncludeSelection(!includeSelection)} title="发送消息或运行工具时，附上当前网页选中的文字"><Check size={13} /> 选中 {includeSelection && <Check size={12} />}</button>
          <button type="button" className={`context-toggle ${toolsOpen ? 'on' : ''}`} aria-expanded={toolsOpen} onClick={() => { setToolsOpen(!toolsOpen); setToolDraft(null); }}><Wrench size={13} /> 工具 <ChevronDown size={12} /></button>
        </div>
        {toolsOpen && <div className="tool-menu" role="region" aria-label="对话工具">
          <div className="tool-menu-heading"><strong>工具</strong><button type="button" className="small-action" disabled={settings.chatTools.length >= 20} onClick={() => setToolDraft({ label: '新工具', prompt: '', context: 'auto' })}><Plus size={13} />添加</button></div>
          {settings.chatTools.length ? settings.chatTools.map((tool) => <div className="tool-menu-row" key={tool.id}>
            <button type="button" className="tool-run" onClick={() => void runChatTool(tool)}><span>{tool.label}</span><small>{tool.context === 'selection' ? '选中文字' : tool.context === 'page' ? '当前网页' : '跟随选中'}</small></button>
            <button type="button" className="icon-button tiny" aria-label={`编辑${tool.label}`} title="编辑工具和提示词" onClick={() => setToolDraft({ ...tool })}><Pencil size={13} /></button>
            <button type="button" className="icon-button tiny danger" aria-label={`删除${tool.label}`} title="删除工具" onClick={() => void deleteChatTool(tool.id)}><Trash2 size={13} /></button>
          </div>) : <div className="tool-empty">还没有工具，点击“添加”创建。</div>}
          {toolDraft && <div className="tool-editor">
            <label>名称<input maxLength={32} value={toolDraft.label} onChange={(event) => setToolDraft({ ...toolDraft, label: event.target.value })} /></label>
            <label>提示词<textarea rows={4} maxLength={4000} value={toolDraft.prompt} onChange={(event) => setToolDraft({ ...toolDraft, prompt: event.target.value })} placeholder="描述运行此工具时要完成的任务" /></label>
            <label>处理内容<select value={toolDraft.context} onChange={(event) => setToolDraft({ ...toolDraft, context: event.target.value as ChatToolAction['context'] })}><option value="auto">跟随“选中”按钮；否则读取当前网页</option><option value="page">当前网页</option><option value="selection">选中文字</option></select></label>
            <div className="tool-editor-actions"><button type="button" className="secondary-button" onClick={() => setToolDraft(null)}>取消</button><button type="button" className="primary-button" onClick={() => void saveToolDraft()}>保存工具</button></div>
          </div>}
        </div>}
      </div>
        <form className="composer" onSubmit={onChatSubmit}><textarea ref={composerRef} rows={2} value={messageInput} onChange={(e) => setMessageInput(e.target.value)} onKeyDown={onKeyDown} placeholder="问问 OpenCode…" aria-label="消息" />{loading ? <button type="button" className="send-button stop" title="停止生成" onClick={() => { const request = requestRef.current; if (request) { try { chatPort.current?.postMessage({ type: 'CHAT_CANCEL', requestId: request.id }); } catch { /* the port may already be disconnected */ } failChatRequest(request, '已停止生成。'); } }}><Square size={14} fill="currentColor" /></button> : <button className="send-button" disabled={!messageInput.trim()} title="发送"><span>发送</span><span className="send-arrow">↗</span></button>}</form>
        <div className="composer-footer"><span>{hasKey ? 'OpenCode Go' : '配置 API Key 以开始'} · 内容仅在发送时提交</span><button onClick={() => { setChats((prev) => prev.map((chat) => chat.id === activeChatId ? { ...chat, messages: [], title: '新对话', sessionId: createSessionId() } : chat)); }}>清空对话</button></div></div>
    </>}

    {(mode === 'agent' || mode === 'research') && <>
      <section className="task-view" ref={scrollRef}>
        {!selectedTask && <div className="task-intro"><div className="task-orb">{mode === 'agent' ? <Bot size={22} /> : <BookOpen size={22} />}</div><div className="eyebrow">{mode === 'agent' ? 'BROWSER AGENT' : 'DEEP RESEARCH'}</div><h1>{mode === 'agent' ? '把任务交给 OpenCode' : '用真实来源开展研究'}</h1><p>{mode === 'agent' ? 'OpenCode 会观察网页、规划操作并逐步验证结果。提交、下载等动作会先询问你。' : `研究流程会搜索、打开并阅读多个网页，再生成带来源链接的${settings.reportLanguage}报告。`}</p><div className="capability-list"><span><Check size={13} />持续执行任务</span><span><Check size={13} />网页操作需许可</span><span><Check size={13} />敏感字段保护</span></div></div>}
        {selectedTask && <TaskProgress task={selectedTask} onApprove={() => void taskControl('resume', true)} onDecline={() => void taskControl('resume', false)} onCopy={(text) => void copyText(text)} onExport={(text) => exportMarkdown(text, 'opencode-research.md')} />}
        {tasks.filter((task) => task.kind === mode && task.id !== selectedTask?.id).slice(0, 5).length > 0 && <div className="task-history"><div className="history-heading"><strong>最近任务</strong></div>{tasks.filter((task) => task.kind === mode && task.id !== selectedTask?.id).slice(0, 5).map((task) => <button key={task.id} onClick={() => setSelectedTaskId(task.id)}><span>{task.task}</span><small>{task.status === 'completed' ? '已完成' : task.status === 'failed' ? '失败' : task.status}</small></button>)}</div>}
      </section>
      <div className="composer-area task-composer"><form className="composer" onSubmit={(event) => { event.preventDefault(); void startTask(mode); }}><textarea ref={composerRef} rows={2} value={taskInput} onChange={(e) => setTaskInput(e.target.value)} placeholder={mode === 'agent' ? '描述你希望完成的浏览器任务…' : '输入研究问题或主题…'} /><button className="send-button" disabled={!taskInput.trim() || ['running', 'paused', 'awaiting-confirmation'].includes(selectedTask?.status ?? '')}><span>开始</span><span className="send-arrow">↗</span></button></form><div className="composer-footer"><span><ShieldCheck size={12} /> {mode === 'agent' ? '敏感操作需确认 · 使用独立工作标签页' : '不限网页数 · 长页面分段读取'}</span><span>按 Enter 开始</span></div></div>
    </>}

    {status && !settingsOpen && <div className="toast-status" role="status"><CircleAlert size={14} />{status}<button onClick={() => setStatus('')}><X size={13} /></button></div>}
  </main>;
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="toggle-row"><span>{label}</span><button className={`toggle ${checked ? 'checked' : ''}`} type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}><i /></button></label>;
}

function Markdown({ content }: { content: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}<ExternalLink size={10} /></a>, pre: ({ children }) => <div className="code-shell"><button className="code-copy" onClick={(e) => { const text = (e.currentTarget.nextElementSibling?.textContent ?? ''); void navigator.clipboard.writeText(text); }}>复制</button><pre>{children}</pre></div> }}>{content}</ReactMarkdown>;
}

function TaskProgress({ task, onApprove, onDecline, onCopy, onExport }: { task: TaskRecord; onApprove: () => void; onDecline: () => void; onCopy: (text: string) => void; onExport: (text: string) => void }) {
  const statusLabel = { running: '正在执行', paused: '已暂停', 'awaiting-confirmation': '等待确认', completed: '已完成', stopped: '已停止', failed: '执行失败' }[task.status];
  const answer = task.report ?? task.answer;
  return <div className="task-progress"><div className="task-status-card"><div className={`status-dot ${task.status}`} /> <div><span>{statusLabel}</span><strong>{task.task}</strong></div><small>{task.steps.length} 步</small></div>
    {task.pendingConfirmation && <div className="confirmation-card"><div className="confirm-icon"><ShieldCheck size={17} /></div><div><strong>需要你的确认</strong><p>{task.pendingConfirmation.reason}</p><code>{task.pendingConfirmation.tool} {JSON.stringify(task.pendingConfirmation.arguments).slice(0, 180)}</code><div className="confirm-actions"><button className="secondary-button" onClick={onDecline}>拒绝</button><button className="primary-button" onClick={onApprove}>允许一次</button></div></div></div>}
    {task.error && <div className="error-card"><CircleAlert size={15} />{task.error}</div>}
    <div className="step-list">{task.steps.map((step) => <div className={`step-row ${step.status}`} key={`${task.id}-${step.index}`}><div className="step-icon">{step.status === 'running' ? <LoaderCircle size={14} className="spin" /> : step.status === 'done' ? <Check size={14} /> : step.status === 'blocked' ? <ShieldCheck size={14} /> : <CircleAlert size={14} />}</div><div><strong>{step.tool}</strong><code>{JSON.stringify(step.arguments)}</code>{step.result && <p>{step.result}</p>}</div></div>)}</div>
    {answer && <section className="final-answer"><div className="final-heading"><strong>{task.kind === 'research' ? '研究报告' : '执行结果'}</strong><div>{task.kind === 'research' && <button onClick={() => onExport(answer)}><FileDown size={13} /> 导出</button>}<button onClick={() => onCopy(answer)}><Copy size={13} /> 复制</button></div></div><Markdown content={answer} /></section>}
    {task.sources.length > 0 && <section className="sources-card"><div className="final-heading"><strong>已读取来源</strong><span>{task.sources.length}</span></div>{task.sources.map((source) => <a key={source.index} href={source.url} target="_blank" rel="noreferrer"><span>[{source.index}] {source.title}</span><ExternalLink size={12} /></a>)}</section>}
    {['running', 'paused', 'awaiting-confirmation'].includes(task.status) && <div className="task-controls">{task.status === 'running' ? <button className="secondary-button" onClick={() => void chrome.runtime.sendMessage({ type: 'TASK_CONTROL', taskId: task.id, action: 'pause' })}><Pause size={14} />暂停</button> : task.status === 'paused' ? <button className="secondary-button" onClick={() => void chrome.runtime.sendMessage({ type: 'TASK_CONTROL', taskId: task.id, action: 'resume' })}><Play size={14} />继续</button> : <span>等待你的确认</span>}<button className="secondary-button danger" onClick={() => void chrome.runtime.sendMessage({ type: 'TASK_CONTROL', taskId: task.id, action: 'stop' })}><Square size={12} />停止</button></div>}
  </div>;
}
