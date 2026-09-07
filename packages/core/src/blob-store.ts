import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, join, relative } from "node:path";

import { redactText, type RedactionReport } from "./redaction.js";

export type StoredBlob = {
  hash: string;
  byteSize: number;
  relativePath: string;
  alreadyExisted: boolean;
  redactionState: "redacted" | "scanned" | "unscanned";
  redactionReport?: RedactionReport;
};

export class BlobIntegrityError extends Error {
  constructor(readonly expectedHash: string, readonly actualHash: string) {
    super(`Blob integrity check failed: expected ${expectedHash}, received ${actualHash}`);
    this.name = "BlobIntegrityError";
  }
}

export class BlobStore {
  readonly rootPath: string;
  readonly tempPath: string;

  constructor(readonly dataDir: string) {
    this.rootPath = join(dataDir, "blobs", "sha256");
    this.tempPath = join(dataDir, "runtime", "blob-tmp");
    mkdirSync(this.rootPath, { recursive: true, mode: 0o700 });
    mkdirSync(this.tempPath, { recursive: true, mode: 0o700 });
  }

  put(content: Uint8Array, mediaType = "application/octet-stream"): StoredBlob {
    const source = Buffer.from(content);
    const textMedia = isTextMediaType(mediaType);
    const redaction = textMedia ? redactText(source.toString("utf8")) : undefined;
    const buffer = redaction === undefined ? source : Buffer.from(redaction.value, "utf8");
    const redactionState =
      redaction === undefined ? "unscanned" : redaction.report.total > 0 ? "redacted" : "scanned";
    const redactionFields =
      redaction !== undefined && redaction.report.total > 0
        ? { redactionReport: redaction.report }
        : {};
    const hash = createHash("sha256").update(buffer).digest("hex");
    const destination = this.pathFor(hash);
    const relativePath = relative(this.dataDir, destination);

    if (existsSync(destination)) {
      this.assertIntegrity(destination, hash);
      return {
        hash,
        byteSize: buffer.byteLength,
        relativePath,
        alreadyExisted: true,
        redactionState,
        ...redactionFields
      };
    }

    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = join(this.tempPath, `${randomUUID()}.tmp`);
    const descriptor = openSync(temporary, "wx", 0o600);

    try {
      writeFileSync(descriptor, buffer);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }

    if (existsSync(destination)) {
      rmSync(temporary);
      this.assertIntegrity(destination, hash);
      return {
        hash,
        byteSize: buffer.byteLength,
        relativePath,
        alreadyExisted: true,
        redactionState,
        ...redactionFields
      };
    }

    renameSync(temporary, destination);
    chmodSync(destination, 0o600);
    return {
      hash,
      byteSize: buffer.byteLength,
      relativePath,
      alreadyExisted: false,
      redactionState,
      ...redactionFields
    };
  }

  read(hash: string): Buffer {
    const source = this.pathFor(hash);
    this.assertIntegrity(source, hash);
    return readFileSync(source);
  }

  removeTemporaryFiles(): number {
    let removed = 0;
    for (const entry of readdirSync(this.tempPath, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".tmp")) {
        rmSync(join(this.tempPath, entry.name));
        removed += 1;
      }
    }
    return removed;
  }

  has(hash: string): boolean {
    return existsSync(this.pathFor(hash));
  }

  private pathFor(hash: string): string {
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      throw new TypeError("Blob hash must be a lowercase SHA-256 digest");
    }
    return join(this.rootPath, hash.slice(0, 2), hash);
  }

  private assertIntegrity(path: string, expectedHash: string): void {
    const size = statSync(path).size;
    const content = readFileSync(path);
    if (content.byteLength !== size) {
      throw new Error(`Blob changed while being read: ${expectedHash}`);
    }
    const actualHash = createHash("sha256").update(content).digest("hex");
    if (actualHash !== expectedHash) {
      throw new BlobIntegrityError(expectedHash, actualHash);
    }
  }
}

function isTextMediaType(mediaType: string): boolean {
  const normalized = mediaType.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  return (
    normalized.startsWith("text/") ||
    normalized === "application/json" ||
    normalized.endsWith("+json") ||
    normalized === "application/xml" ||
    normalized.endsWith("+xml") ||
    normalized === "application/javascript" ||
    normalized === "application/x-www-form-urlencoded"
  );
}
