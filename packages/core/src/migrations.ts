import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type Database from "better-sqlite3";

export const MIGRATIONS = [
  "0001_initial.sql",
  "0002_approvals.sql",
  "0003_gateway.sql",
  "0004_replay.sql",
  "0005_provider_sessions.sql",
  "0006_hosted_workspaces_provider_events.sql",
  "0007_provider_action_requests.sql",
  "0008_patch_promotions.sql",
  "0009_network_mediation.sql"
] as const;

export const LATEST_MIGRATION_VERSION = MIGRATIONS.at(-1)?.replace(/\.sql$/, "") ?? "unknown";

type AppliedMigration = { version: string; checksum: string };

export function applyMigrations(
  database: Database.Database,
  beforeApply?: (pendingVersions: string[]) => void
): string[] {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL,
      checksum TEXT NOT NULL
    );
  `);

  const getApplied = database.prepare(
    "SELECT version, checksum FROM schema_migrations WHERE version = ?"
  );
  const insertApplied = database.prepare(
    "INSERT INTO schema_migrations (version, applied_at, checksum) VALUES (?, ?, ?)"
  );
  const pending: Array<{ version: string; sql: string; checksum: string }> = [];

  for (const filename of MIGRATIONS) {
    const version = filename.replace(/\.sql$/, "");
    const sqlPath = fileURLToPath(new URL(`../migrations/${filename}`, import.meta.url));
    const sql = readFileSync(sqlPath, "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const existing = getApplied.get(version) as AppliedMigration | undefined;

    if (existing !== undefined) {
      if (existing.checksum !== checksum) {
        throw new Error(`Migration checksum mismatch: ${version}`);
      }
      continue;
    }
    pending.push({ version, sql, checksum });
  }

  if (pending.length === 0) return [];
  beforeApply?.(pending.map(({ version }) => version));

  database.transaction(() => {
    for (const { version, sql, checksum } of pending) {
      database.exec(sql);
      insertApplied.run(version, new Date().toISOString(), checksum);
    }
  })();

  return pending.map(({ version }) => version);
}
