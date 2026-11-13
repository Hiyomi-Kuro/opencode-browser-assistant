import type { PageSnapshot, SourceRecord } from '../../shared/types';

export class SourceManager {
  private records: SourceRecord[] = [];
  add(snapshot: PageSnapshot, now = Date.now()): SourceRecord | undefined {
    try {
      const url = new URL(snapshot.url); url.hash = '';
      const canonical = url.toString().replace(/\/$/, '');
      if (!['http:', 'https:'].includes(url.protocol) || this.records.some((source) => source.url.replace(/\/$/, '') === canonical)) return undefined;
      const source = { index: this.records.length + 1, url: canonical, title: snapshot.title || canonical, accessedAt: now, excerpt: snapshot.text.slice(0, 900), status: 'read' as const };
      this.records.push(source); return source;
    } catch { return undefined; }
  }
  all(): SourceRecord[] { return this.records.map((source) => ({ ...source })); }
}
