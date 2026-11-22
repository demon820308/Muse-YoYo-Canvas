// [yoyo-local] 数据层：bun:sqlite + Drizzle（与源工程特征测试同一组合）。
// 启动时按文件名序执行 drizzle/0001–0014 中尚未记录的迁移，
// 已执行清单落在 _local_migrations 表，重启不重跑、失败不登记。

import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as schema from "../server/src/schema";
import { DATA_DIR, DB_PATH, DRIZZLE_DIR } from "./config";

export type LocalDb = BunSQLiteDatabase<typeof schema>;

export function openDb(): { db: LocalDb; sqlite: Database } {
  mkdirSync(DATA_DIR, { recursive: true });
  const sqlite = new Database(DB_PATH, { create: true });
  sqlite.exec("PRAGMA busy_timeout = 5000");
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  runMigrations(sqlite);
  const db = drizzle(sqlite, { schema });
  attachBatch(db, sqlite);
  return { db, sqlite };
}

/** bun-sqlite 驱动没有平台 SpaceDb 表面里的 batch（drizzle 0.45 只有
 * LibSQL 等异步驱动带）。本地补齐：同一事务内顺序执行各语句，
 * 任一失败整批回滚——与 LibSQL batch 的原子语义一致。调用点只有
 * saveGraph 的批量删除与 deleteProject 的三表删除（projects.ts /
 * graph.ts），都是 delete builder，用其 run() 执行。 */
function attachBatch(db: LocalDb, sqlite: Database): void {
  const anyDb = db as unknown as { batch?: unknown };
  if (typeof anyDb.batch === "function") return;
  anyDb.batch = async (items: readonly unknown[]) => {
    const results: unknown[] = [];
    sqlite.exec("BEGIN");
    try {
      for (const item of items) {
        const runnable = item as {
          run?: () => unknown;
          then?: unknown;
        };
        if (typeof runnable.run === "function") {
          results.push(runnable.run());
        } else {
          results.push(await item);
        }
      }
      sqlite.exec("COMMIT");
    } catch (err) {
      sqlite.exec("ROLLBACK");
      throw err;
    }
    return results;
  };
}

function runMigrations(sqlite: Database): void {
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS _local_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  const applied = new Set(
    sqlite
      .query<{ name: string }, []>("SELECT name FROM _local_migrations")
      .all()
      .map((r) => r.name),
  );
  const files = readdirSync(DRIZZLE_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sqlText = readFileSync(join(DRIZZLE_DIR, file), "utf8");
    sqlite.exec("BEGIN");
    try {
      sqlite.exec(sqlText);
      sqlite
        .query("INSERT INTO _local_migrations (name, applied_at) VALUES (?, ?)")
        .run(file, Date.now());
      sqlite.exec("COMMIT");
    } catch (err) {
      sqlite.exec("ROLLBACK");
      throw new Error(`本地迁移 ${file} 执行失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
