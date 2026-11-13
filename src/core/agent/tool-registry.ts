import type { ToolDefinition } from '../../shared/types';

type Property = Record<string, unknown>;
const str = (description: string, maxLength = 1000) => ({ type: 'string', description, minLength: 1, maxLength });
const num = (description: string, minimum: number, maximum: number) => ({ type: 'number', description, minimum, maximum });
const tool = (name: string, description: string, properties: Record<string, Property> = {}, required: string[] = [], readOnly = false): ToolDefinition => ({
  name, description, readOnly, parameters: { type: 'object', properties, required, additionalProperties: false },
});

export const TOOL_REGISTRY: ToolDefinition[] = [
  tool('browser.open_url', 'Open an HTTP or HTTPS URL in the agent workspace tab.', { url: str('HTTP(S) URL', 4096) }, ['url']),
  tool('browser.back', 'Navigate backward in the workspace tab history.'), tool('browser.forward', 'Navigate forward in the workspace tab history.'), tool('browser.reload', 'Reload the workspace tab.'),
  tool('browser.get_page_info', 'Return current URL, title and loading status.', {}, [], true), tool('browser.get_text', 'Read the first section of visible page text and its total length; use browser.read_page_chunk to continue.', {}, [], true),
  tool('browser.read_page_chunk', 'Read the requested section of the current page text or Markdown. Repeat from nextOffset until done is true; if restartRequired is true, restart from offset 0. There is no total page length limit.', { format: { type: 'string', enum: ['text', 'markdown'] }, offset: num('Character offset from the start of this page representation', 0, 1000000000000), length: num('Characters to read in this response (maximum 8000)', 1, 8000) }, ['format', 'offset', 'length'], true),
  tool('browser.get_dom', 'Return a compact accessibility-oriented element snapshot with fresh element IDs.', {}, [], true),
  tool('browser.get_links', 'List visible page links.', {}, [], true), tool('browser.get_forms', 'List forms and nonsensitive field labels; never return field values.', {}, [], true),
  tool('browser.get_elements', 'List interactive elements with IDs from the latest observation.', {}, [], true),
  tool('browser.click', 'Click an element from the latest snapshot by element_id.', { element_id: str('Fresh element ID', 80) }, ['element_id']),
  tool('browser.type', 'Enter text into a nonsensitive field from the latest snapshot.', { element_id: str('Fresh element ID', 80), text: str('Text to enter', 5000) }, ['element_id', 'text']),
  tool('browser.clear', 'Clear a nonsensitive field from the latest snapshot.', { element_id: str('Fresh element ID', 80) }, ['element_id']),
  tool('browser.select', 'Select an option in a nonsensitive select control.', { element_id: str('Fresh element ID', 80), value: str('Option value or label', 500) }, ['element_id', 'value']),
  tool('browser.scroll', 'Scroll the page by a bounded number of pixels.', { direction: { type: 'string', enum: ['up', 'down'] }, pixels: num('Pixels', 80, 1200) }, ['direction']),
  tool('browser.wait', 'Wait briefly for page content to settle.', { milliseconds: num('Wait duration', 100, 5000) }, ['milliseconds']),
  tool('browser.submit', 'Submit a form. Requires user confirmation.', { element_id: str('Form or submit button ID', 80) }, ['element_id']),
  tool('browser.extract_markdown', 'Read the first Markdown section. The page is recorded as a research source after all sections are read with browser.read_page_chunk.', {}, [], true),
  tool('browser.extract_table', 'Extract visible HTML tables as rows.', {}, [], true), tool('browser.extract_metadata', 'Read title, URL, author and publication metadata.', {}, [], true),
  tool('browser.find_text', 'Find a text phrase in the visible page.', { query: str('Text to find', 500) }, ['query'], true),
  tool('browser.search', 'Search Bing or Google for a research query and open the results page.', { query: str('Search terms', 500) }, ['query']),
  tool('browser.new_tab', 'Open an HTTP(S) URL in an agent-owned tab.', { url: str('HTTP(S) URL', 4096) }, ['url']),
  tool('browser.switch_tab', 'Switch the agent workspace to one of its own tabs.', { tab_id: num('Agent-owned tab ID', 1, 2147483647) }, ['tab_id']),
  tool('browser.list_tabs', 'List browser tabs and identify agent-owned tabs.', {}, [], true),
  tool('browser.close_tab', 'Close an agent-owned tab. Closing a user tab needs confirmation.', { tab_id: num('Tab ID', 1, 2147483647) }, ['tab_id']),
  tool('browser.download', 'Download an HTTP(S) file. Requires user confirmation.', { url: str('HTTP(S) file URL', 4096), filename: str('Suggested filename', 180) }, ['url']),
  tool('browser.save_markdown', 'Save the latest readable page as a Markdown download.', {}, [], false),
];

export function asOpenAiTools(definitions = TOOL_REGISTRY) {
  return definitions.map((definition) => ({ type: 'function', function: { name: definition.name, description: definition.description, parameters: definition.parameters } }));
}

export function validateToolArguments(name: string, value: unknown): { ok: true; arguments: Record<string, unknown> } | { ok: false; error: string } {
  const definition = TOOL_REGISTRY.find((item) => item.name === name);
  if (!definition) return { ok: false, error: `Unknown tool: ${name}` };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'Tool arguments must be a JSON object.' };
  const args = value as Record<string, unknown>;
  const schema = definition.parameters as { properties: Record<string, Property>; required: string[] };
  for (const key of Object.keys(args)) if (!(key in schema.properties)) return { ok: false, error: `Unexpected argument: ${key}` };
  for (const key of schema.required) if (!(key in args)) return { ok: false, error: `Missing required argument: ${key}` };
  for (const [key, item] of Object.entries(args)) {
    const property = schema.properties[key];
    if (property.type === 'string' && (typeof item !== 'string' || !item.trim() || item.length > Number(property.maxLength ?? 1000))) return { ok: false, error: `${key} must be a non-empty string within its length limit.` };
    if (property.type === 'number' && (typeof item !== 'number' || !Number.isFinite(item) || item < Number(property.minimum ?? -Infinity) || item > Number(property.maximum ?? Infinity))) return { ok: false, error: `${key} is outside its allowed range.` };
    if (property.enum && !(property.enum as unknown[]).includes(item)) return { ok: false, error: `${key} has an unsupported value.` };
  }
  if (typeof args.url === 'string' && !isSafeHttpUrl(args.url)) return { ok: false, error: 'Only HTTP and HTTPS URLs are allowed.' };
  return { ok: true, arguments: args };
}

export function isSafeHttpUrl(value: string): boolean {
  try { const url = new URL(value); return (url.protocol === 'https:' || url.protocol === 'http:') && !!url.hostname; } catch { return false; }
}

export type ActionProtocol = { kind: 'final'; answer: string } | { kind: 'tool'; tool: string; arguments: Record<string, unknown> };
export function parseActionProtocol(text: string): ActionProtocol | undefined {
  const candidate = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    if (parsed.action === 'final' && typeof parsed.answer === 'string') return { kind: 'final', answer: parsed.answer };
    if (parsed.action === 'tool' && typeof parsed.tool === 'string' && parsed.arguments && typeof parsed.arguments === 'object' && !Array.isArray(parsed.arguments)) {
      return { kind: 'tool', tool: parsed.tool, arguments: parsed.arguments as Record<string, unknown> };
    }
  } catch { return undefined; }
  return undefined;
}
