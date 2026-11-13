export type SseEvent = { data: string; event?: string; id?: string };

export function createSseParser(onEvent: (event: SseEvent) => void) {
  let pending = '';
  let fields: string[] = [];
  const dispatch = () => {
    if (!fields.length) return;
    let data = ''; let event: string | undefined; let id: string | undefined;
    for (const line of fields) {
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const key = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (key === 'data') data += `${data ? '\n' : ''}${value}`;
      if (key === 'event') event = value;
      if (key === 'id' && !value.includes('\0')) id = value;
    }
    if (data || event || id) onEvent({ data, event, id });
    fields = [];
  };
  return {
    feed(chunk: string) {
      pending += chunk;
      const lines = pending.split(/\r\n|\n|\r/);
      pending = lines.pop() ?? '';
      for (const line of lines) { if (line === '') dispatch(); else fields.push(line); }
    },
    finish() { if (pending) fields.push(pending); pending = ''; dispatch(); },
  };
}
