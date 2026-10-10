
export class NdjsonLineTooLongError extends Error {
  public readonly code = "ndjson_line_too_long" as const;
  public constructor(
    message: string,
    public readonly maxLineBytes: number
  ) {
    super(message);
    this.name = "NdjsonLineTooLongError";
  }
}

export interface NdjsonLineBufferOptions {
  /** Maximum bytes allowed in the incomplete-line buffer (default 1 MiB). */
  maxLineBytes?: number;
}

const DEFAULT_MAX_LINE_BYTES = 1_048_576;

export class NdjsonLineBuffer {
  private readonly maxLineBytes: number;
  private pending = "";

  public constructor(options?: NdjsonLineBufferOptions) {
    this.maxLineBytes = options?.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  }

  /** Push a stdout chunk; returns complete lines (without trailing newlines). */
  public push(chunk: string): string[] {
    if (!chunk) {
      return [];
    }
    this.pending += chunk;
    if (this.pending.length > this.maxLineBytes && !/[\r\n]/.test(this.pending)) {
      const length = this.pending.length;
      this.pending = "";
      throw new NdjsonLineTooLongError(
        `NDJSON line exceeded ${this.maxLineBytes} bytes without a newline (saw ${length}).`,
        this.maxLineBytes
      );
    }

    const lines: string[] = [];
    while (true) {
      const match = /\r?\n/.exec(this.pending);
      if (!match || match.index === undefined) {
        break;
      }
      const line = this.pending.slice(0, match.index);
      this.pending = this.pending.slice(match.index + match[0].length);
      if (line.length > this.maxLineBytes) {
        throw new NdjsonLineTooLongError(
          `NDJSON line exceeded ${this.maxLineBytes} bytes.`,
          this.maxLineBytes
        );
      }
      lines.push(line);
    }

    if (this.pending.length > this.maxLineBytes) {
      const length = this.pending.length;
      this.pending = "";
      throw new NdjsonLineTooLongError(
        `NDJSON line exceeded ${this.maxLineBytes} bytes without a newline (saw ${length}).`,
        this.maxLineBytes
      );
    }
    return lines;
  }

  /**
   * Flush remaining trailing fragment at process close.
   * Empty / whitespace-only fragments are dropped.
   */
  public flush(): string | undefined {
    const trailing = this.pending;
    this.pending = "";
    const trimmed = trailing.trim();
    return trimmed ? trailing : undefined;
  }

  public pendingBytes(): number {
    return this.pending.length;
  }

  public reset(): void {
    this.pending = "";
  }
}
