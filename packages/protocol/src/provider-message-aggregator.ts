
export type ProviderMessageFlushReason =
  "sentence" | "newline" | "max_chars" | "max_chunks" | "force";

export interface ProviderMessageAggregatorOptions {
  /** Soft max characters before a forced flush (default 280). */
  maxChars?: number;
  /** Soft max chunks before a forced flush (default 48). */
  maxChunks?: number;
  /** Absolute hard cap for a single flushed message (default 500 — ProgressEvent.message max). */
  hardMaxChars?: number;
}

export interface ProviderMessageFlush {
  text: string;
  reason: ProviderMessageFlushReason;
  chunkCount: number;
}

const DEFAULT_MAX_CHARS = 280;
const DEFAULT_MAX_CHUNKS = 48;
const DEFAULT_HARD_MAX = 500;

/**
 * Buffer provider-visible text deltas into bounded messages.
 * Call flush() at turn boundaries so trailing text is not lost.
 */
export class ProviderMessageAggregator {
  private readonly maxChars: number;
  private readonly maxChunks: number;
  private readonly hardMaxChars: number;
  private buffer = "";
  private chunks = 0;

  public constructor(options?: ProviderMessageAggregatorOptions) {
    this.maxChars = options?.maxChars ?? DEFAULT_MAX_CHARS;
    this.maxChunks = options?.maxChunks ?? DEFAULT_MAX_CHUNKS;
    this.hardMaxChars = options?.hardMaxChars ?? DEFAULT_HARD_MAX;
  }

  /** Push one stream delta. Returns a flush when a boundary is reached; otherwise undefined. */
  public push(chunk: string): ProviderMessageFlush | undefined {
    if (typeof chunk !== "string" || chunk.length === 0) {
      return undefined;
    }
    this.buffer += chunk;
    this.chunks += 1;

    const sentenceEnd = findSentenceBoundary(this.buffer);
    if (sentenceEnd !== undefined) {
      return this.take(sentenceEnd, "sentence");
    }
    const newlineEnd = this.buffer.indexOf("\n");
    if (newlineEnd >= 0) {
      return this.take(newlineEnd + 1, "newline");
    }
    if (this.buffer.length >= this.maxChars) {
      return this.take(this.buffer.length, "max_chars");
    }
    if (this.chunks >= this.maxChunks) {
      return this.take(this.buffer.length, "max_chunks");
    }
    return undefined;
  }

  /** Flush any remaining buffered text (e.g. end of turn). */
  public flush(): ProviderMessageFlush | undefined {
    if (!this.buffer.trim()) {
      this.buffer = "";
      this.chunks = 0;
      return undefined;
    }
    return this.take(this.buffer.length, "force");
  }

  public reset(): void {
    this.buffer = "";
    this.chunks = 0;
  }

  public pendingChars(): number {
    return this.buffer.length;
  }

  private take(end: number, reason: ProviderMessageFlushReason): ProviderMessageFlush {
    const raw = this.buffer.slice(0, end);
    this.buffer = this.buffer.slice(end).replace(/^\s+/, "");
    const chunkCount = this.chunks;
    this.chunks = this.buffer.length > 0 ? 1 : 0;
    let text = raw.replace(/\s+/g, " ").trim();
    if (text.length > this.hardMaxChars) {
      text = text.slice(0, this.hardMaxChars);
    }
    return { text, reason, chunkCount };
  }
}

function findSentenceBoundary(buffer: string): number | undefined {
  const match = /[.!?](?:\s|$)/.exec(buffer);
  if (!match || match.index === undefined) {
    return undefined;
  }
  const end = match.index + 1;
  if (end < buffer.length && !/\s/.test(buffer[end] ?? "")) {
    return undefined;
  }
  return end;
}
