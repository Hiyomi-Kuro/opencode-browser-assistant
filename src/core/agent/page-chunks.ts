export const PAGE_CHUNK_LENGTH = 8000;

export interface PageChunk {
  text: string;
  offset: number;
  endOffset: number;
  totalLength: number;
  done: boolean;
}

export function slicePageChunk(content: string, offset: number, length = PAGE_CHUNK_LENGTH): PageChunk {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('Page chunk offset must be a non-negative safe integer.');
  if (!Number.isSafeInteger(length) || length < 1 || length > PAGE_CHUNK_LENGTH) throw new RangeError(`Page chunk length must be between 1 and ${PAGE_CHUNK_LENGTH}.`);
  const start = Math.min(offset, content.length);
  const text = content.slice(start, start + length);
  const endOffset = start + text.length;
  return { text, offset: start, endOffset, totalLength: content.length, done: endOffset >= content.length };
}
