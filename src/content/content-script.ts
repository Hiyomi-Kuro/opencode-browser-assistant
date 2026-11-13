import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import type { PageSnapshot } from '../shared/types';
import { PAGE_CHUNK_LENGTH, slicePageChunk } from '../core/agent/page-chunks';

type ContentRequest = { type: string; elementId?: string; text?: string; value?: string; direction?: 'up' | 'down'; pixels?: number; query?: string; format?: 'text' | 'markdown'; offset?: number; length?: number };
type InteractiveInfo = { id: string; tag: string; role: string; label: string; type: string; href?: string; disabled: boolean; sensitive: boolean };
let epoch = 0;
let observer: MutationObserver | undefined;
let latestElements = new Map<string, Element>();
let pageContentCache: { url: string; text: string; markdown: string } | undefined;
let contentRevision = 0;

function installPageObserver() {
  if (observer || !document.documentElement) return;
  observer = new MutationObserver((records) => {
    if (!records.some((record) => record.type !== 'attributes' || record.attributeName !== 'data-opencode-id')) return;
    epoch += 1; contentRevision += 1; latestElements.clear(); pageContentCache = undefined;
    document.querySelectorAll('[data-opencode-id]').forEach((element) => element.removeAttribute('data-opencode-id'));
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-label', 'aria-expanded', 'disabled', 'hidden', 'class', 'style', 'href', 'value'] });
}

function visible(element: Element): boolean {
  const rect = element.getBoundingClientRect(); const style = getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0;
}

function labelFor(element: Element): string {
  const input = element as HTMLInputElement;
  const id = element.getAttribute('id');
  const explicit = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent : '';
  return [element.getAttribute('aria-label'), element.getAttribute('title'), explicit, (element as HTMLElement).innerText, input.placeholder, input.type === 'password' ? 'password field' : ''].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 180);
}

function isSensitive(element: Element): boolean {
  const input = element as HTMLInputElement;
  const descriptor = `${input.type} ${input.autocomplete} ${input.name} ${input.id} ${labelFor(element)}`;
  return input.type === 'password' || /password|one-time-code|cc-|credit.?card|card.?number|cvv|cvc|payment|billing|security.?code|otp/i.test(descriptor);
}

function observeElements(): InteractiveInfo[] {
  installPageObserver(); observer?.disconnect();
  epoch += 1; latestElements = new Map();
  document.querySelectorAll('[data-opencode-id]').forEach((element) => element.removeAttribute('data-opencode-id'));
  const candidates = Array.from(document.querySelectorAll('a[href],button,input,select,textarea,[role="button"],[role="link"],[role="textbox"],[contenteditable="true"],[tabindex]:not([tabindex="-1"])'))
    .filter((element) => visible(element)).slice(0, 250);
  const result = candidates.map((element, index) => {
    const id = `e${epoch}-${index + 1}`; element.setAttribute('data-opencode-id', id); latestElements.set(id, element);
    const input = element as HTMLInputElement;
    return { id, tag: element.tagName.toLowerCase(), role: element.getAttribute('role') ?? '', label: labelFor(element), type: input.type ?? '', href: element instanceof HTMLAnchorElement ? element.href : undefined, disabled: 'disabled' in element && Boolean((element as HTMLInputElement).disabled), sensitive: isSensitive(element) };
  });
  observer?.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-label', 'aria-expanded', 'disabled', 'hidden', 'class', 'style', 'href', 'value'] });
  return result;
}

function snapshot(): PageSnapshot & { elements: InteractiveInfo[]; forms: unknown[]; readyState: string } {
  if (pageContentCache?.url !== location.href) pageContentCache = undefined;
  const article = new Readability(document.cloneNode(true) as Document, { charThreshold: 80 }).parse();
  const source = article?.content ?? document.querySelector('main, article, [role="main"]')?.innerHTML ?? document.body?.innerHTML ?? '';
  const body = new DOMParser().parseFromString(source, 'text/html');
  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  turndown.remove(['script', 'style', 'noscript', 'nav', 'footer', 'header', 'aside', 'form', 'button', 'input', 'select', 'textarea', 'iframe']);
  const headings = Array.from(body.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((el) => ({ level: Number(el.tagName.slice(1)), text: el.textContent?.trim() ?? '' })).filter((item) => item.text);
  const links = Array.from(body.querySelectorAll('a[href]')).map((el) => ({ text: el.textContent?.trim() || el.getAttribute('aria-label') || '', url: new URL(el.getAttribute('href')!, location.href).href })).filter((item) => item.text).slice(0, 200);
  const images = Array.from(body.querySelectorAll('img')).map((el) => ({ alt: el.alt, url: new URL(el.getAttribute('src') ?? '', location.href).href })).slice(0, 100);
  const tables = Array.from(body.querySelectorAll('table')).slice(0, 40).map((table) => Array.from(table.querySelectorAll('tr')).map((row) => Array.from(row.querySelectorAll('th,td')).map((cell) => cell.textContent?.trim() ?? '')));
  const elements = observeElements();
  const forms = Array.from(document.forms).slice(0, 40).map((form) => ({ id: form.id, name: form.name, label: form.getAttribute('aria-label') ?? '', fields: Array.from(form.elements).filter((field) => field instanceof HTMLElement).slice(0, 50).map((field) => ({ tag: field.tagName.toLowerCase(), type: (field as HTMLInputElement).type ?? '', label: labelFor(field), sensitive: isSensitive(field), disabled: 'disabled' in field && Boolean((field as HTMLInputElement).disabled) })) }));
  const markdown = turndown.turndown(body.body.innerHTML);
  const text = (article?.textContent || body.body.innerText || '').replace(/\s+/g, ' ');
  pageContentCache = { url: location.href, text, markdown };
  return {
    title: article?.title || document.title, url: location.href, markdown: markdown.slice(0, PAGE_CHUNK_LENGTH), markdownLength: markdown.length,
    text: text.slice(0, PAGE_CHUNK_LENGTH), textLength: text.length, contentRevision, headings, links, images, tables,
    author: article?.byline || document.querySelector('meta[name="author"]')?.getAttribute('content') || undefined,
    publishedAt: document.querySelector('meta[property="article:published_time"],meta[name="date"],time[datetime]')?.getAttribute('content') || undefined,
    selectedText: window.getSelection()?.toString().trim().slice(0, 12000), elements,
    forms, readyState: document.readyState,
  };
}

function findElement(id?: string): Element {
  if (!id || !latestElements.has(id) || !id.startsWith(`e${epoch}-`)) throw new Error('Element ID is stale. Observe the page again and use a fresh ID.');
  const element = latestElements.get(id)!;
  if (!element.isConnected || !visible(element)) throw new Error('The target element is no longer visible. Observe the page again.');
  if (isSensitive(element)) throw new Error('Password, payment, and secret fields cannot be read or filled.');
  return element;
}

function setFieldText(element: Element, text: string) {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value');
    if (descriptor?.set) descriptor.set.call(element, text); else element.value = text;
  } else if (element instanceof HTMLElement && element.isContentEditable) element.textContent = text;
  else throw new Error('The target is not an editable text field.');
}

async function handle(request: ContentRequest): Promise<unknown> {
  if (request.type === 'PING') return { ready: true };
  if (request.type === 'PAGE_SNAPSHOT') return snapshot();
  if (request.type === 'PAGE_CHUNK') {
    if (request.format !== undefined && request.format !== 'text' && request.format !== 'markdown') throw new Error('Page chunk format must be text or markdown.');
    if (pageContentCache?.url !== location.href) snapshot();
    const content = request.format === 'markdown' ? pageContentCache?.markdown : pageContentCache?.text;
    if (content === undefined) throw new Error('Page content is not available.');
    return { url: location.href, format: request.format ?? 'text', revision: contentRevision, ...slicePageChunk(content, request.offset ?? 0, request.length ?? PAGE_CHUNK_LENGTH) };
  }
  if (request.type === 'CLICK') { const element = findElement(request.elementId) as HTMLElement; element.click(); return { ok: true, label: labelFor(element), pageChanged: true }; }
  if (request.type === 'TYPE') { const element = findElement(request.elementId); if (!(element instanceof HTMLElement)) throw new Error('The target is not an editable element.'); if (isSensitive(element)) throw new Error('Sensitive input is blocked.'); element.focus(); setFieldText(element, request.text ?? ''); element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); return { ok: true, label: labelFor(element) }; }
  if (request.type === 'CLEAR') { const element = findElement(request.elementId); if (!(element instanceof HTMLElement)) throw new Error('The target is not an editable element.'); element.focus(); setFieldText(element, ''); element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); return { ok: true }; }
  if (request.type === 'SELECT') { const element = findElement(request.elementId) as HTMLSelectElement; const option = Array.from(element.options).find((item) => item.value === request.value || item.textContent?.trim() === request.value); if (!option) throw new Error('Option not found.'); element.value = option.value; element.dispatchEvent(new Event('change', { bubbles: true })); return { ok: true, selected: option.textContent }; }
  if (request.type === 'SCROLL') { window.scrollBy({ top: (request.direction === 'up' ? -1 : 1) * Math.min(1200, Math.max(80, request.pixels ?? 600)), behavior: 'smooth' }); return { ok: true, pageChanged: false }; }
  if (request.type === 'WAIT') { await new Promise((resolve) => setTimeout(resolve, Math.min(5000, Math.max(100, request.pixels ?? 800)))); return { ok: true }; }
  if (request.type === 'SUBMIT') { const element = findElement(request.elementId); const form = element instanceof HTMLFormElement ? element : element.closest('form'); if (!form) throw new Error('No form found for this element.'); form.requestSubmit(); return { ok: true, pageChanged: true }; }
  if (request.type === 'FIND_TEXT') { const needle = (request.query ?? '').toLocaleLowerCase(); const text = document.body.innerText; const index = text.toLocaleLowerCase().indexOf(needle); return { found: index >= 0, excerpt: index >= 0 ? text.slice(Math.max(0, index - 180), index + needle.length + 260) : '' }; }
  throw new Error(`Unsupported page operation: ${request.type}`);
}

chrome.runtime.onMessage.addListener((message: ContentRequest, _sender, sendResponse) => {
  if (!message?.type || !['PING', 'PAGE_SNAPSHOT', 'PAGE_CHUNK', 'CLICK', 'TYPE', 'CLEAR', 'SELECT', 'SCROLL', 'WAIT', 'SUBMIT', 'FIND_TEXT'].includes(message.type)) return;
  handle(message).then((result) => sendResponse({ ok: true, result })).catch((error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : 'Page operation failed.' }));
  return true;
});
