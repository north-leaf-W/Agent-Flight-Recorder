import { StringDecoder } from "node:string_decoder";

export class CodexJsonlLineTooLongError extends Error {
  constructor(readonly maxLineBytes: number) {
    super(`Codex JSONL line exceeds ${maxLineBytes} bytes`);
    this.name = "CodexJsonlLineTooLongError";
  }
}

export class CodexJsonlDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private buffered = "";

  constructor(private readonly maxLineBytes = 1024 * 1024) {}

  push(chunk: Buffer | string): string[] {
    this.buffered += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    return this.takeCompleteLines();
  }

  finish(): string[] {
    this.buffered += this.decoder.end();
    const complete = this.takeCompleteLines();
    if (this.buffered.length === 0) return complete;
    this.assertWithinLimit(this.buffered);
    const finalLine = stripCarriageReturn(this.buffered);
    this.buffered = "";
    return [...complete, finalLine];
  }

  private takeCompleteLines(): string[] {
    const lines: string[] = [];
    for (;;) {
      const newline = this.buffered.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffered.slice(0, newline);
      this.assertWithinLimit(line);
      lines.push(stripCarriageReturn(line));
      this.buffered = this.buffered.slice(newline + 1);
    }
    this.assertWithinLimit(this.buffered);
    return lines;
  }

  private assertWithinLimit(value: string): void {
    if (Buffer.byteLength(value) > this.maxLineBytes) {
      throw new CodexJsonlLineTooLongError(this.maxLineBytes);
    }
  }
}

function stripCarriageReturn(value: string): string {
  return value.endsWith("\r") ? value.slice(0, -1) : value;
}
