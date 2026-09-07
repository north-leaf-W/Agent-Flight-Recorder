import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

import { createTwoFilesPatch } from "diff";

const EXCLUDED_DIRECTORIES = new Set([".git", ".afr", "node_modules", "dist", "build"]);

export type FileState = {
  path: string;
  hash: string;
  byteSize: number;
  content?: string;
  text: boolean;
};

export type FileChange = {
  action: "created" | "modified" | "deleted";
  path: string;
  before?: FileState;
  after?: FileState;
  diff?: string;
  diffUnavailableReason?: string;
};

export async function snapshotFiles(root: string): Promise<Map<string, FileState>> {
  const files = new Map<string, FileState>();
  await visit(root, root, files);
  return files;
}

export function compareSnapshots(
  before: ReadonlyMap<string, FileState>,
  after: ReadonlyMap<string, FileState>
): FileChange[] {
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changes: FileChange[] = [];

  for (const path of paths) {
    const previous = before.get(path);
    const current = after.get(path);
    if (previous?.hash === current?.hash) {
      continue;
    }
    const action = previous === undefined ? "created" : current === undefined ? "deleted" : "modified";
    const change: FileChange = {
      action,
      path,
      ...(previous === undefined ? {} : { before: previous }),
      ...(current === undefined ? {} : { after: current })
    };
    if ((previous?.text ?? true) && (current?.text ?? true)) {
      change.diff = createTwoFilesPatch(
        `a/${path}`,
        `b/${path}`,
        previous?.content ?? "",
        current?.content ?? "",
        "before",
        "after",
        { context: 3 }
      );
    } else {
      change.diffUnavailableReason = "binary_file";
    }
    changes.push(change);
  }

  return changes;
}

async function visit(root: string, directory: string, result: Map<string, FileState>): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".DS_Store") {
      continue;
    }
    const absolutePath = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRECTORIES.has(entry.name)) {
        await visit(root, absolutePath, result);
      }
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }

    const metadata = await lstat(absolutePath);
    const buffer = await readFile(absolutePath);
    const text = !buffer.includes(0);
    const path = relative(root, absolutePath).split("\\").join("/");
    result.set(path, {
      path,
      hash: createHash("sha256").update(buffer).digest("hex"),
      byteSize: metadata.size,
      text,
      ...(text ? { content: buffer.toString("utf8") } : {})
    });
  }
}
