import type { ChatTurn } from '../api/opencode-client';
import type { ToolCall } from '../../shared/types';

export function appendPlannerToolCall(messages: ChatTurn[], action: ToolCall, nativeToolsSupported = true) {
  if (!nativeToolsSupported) {
    messages.push({ role: 'assistant', content: JSON.stringify({ action: 'tool', tool: action.name, arguments: action.arguments }) });
    return;
  }
  messages.push({ role: 'assistant', content: null, tool_calls: [{
    id: action.id,
    type: 'function',
    function: { name: action.name, arguments: JSON.stringify(action.arguments) },
  }] });
}

export function appendPlannerToolResult(messages: ChatTurn[], action: ToolCall, content: string, nativeToolsSupported = true) {
  const limit = 16000;
  const boundedContent = content.length > limit ? `${content.slice(0, limit)}\n[…tool output truncated at ${limit} characters]` : content;
  if (nativeToolsSupported) {
    messages.push({ role: 'tool', name: action.name, tool_call_id: action.id, content: boundedContent });
    return;
  }
  messages.push({ role: 'user', content: `Tool result for ${action.name}: ${boundedContent}` });
}

export function trimPlannerHistory(messages: ChatTurn[], maxMessages = 28) {
  if (messages.length <= maxMessages) return;

  const prefixLength = Math.min(2, messages.length);
  const recentLength = Math.max(0, maxMessages - prefixLength);
  let start = Math.max(prefixLength, messages.length - recentLength);

  // A tool result is valid only while its assistant tool call is still present.
  while (start < messages.length && messages[start]?.role === 'tool') start += 1;
  messages.splice(prefixLength, start - prefixLength);
}
