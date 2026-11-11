/**
 * SQLite connection for the personal library.
 *
 * This file is the *only* place that knows the database path and the
 * connection pragmas. Repositories receive the shared handle from here.
 *
 * Design notes:
 * - The database lives in `.data/personal/`, outside `dist/` and `src/`, so it
 *   survives builds and is never published as a static asset.
 * - WAL mode keeps reads concurrent with writes; `foreign_keys` is enabled per
 *   connection (SQLite defaults it OFF, which would silently disable the
 *   field-log cascade rules).
 * - The connection is cached on `globalThis` so Astro's module reloading in dev
 *   does not open a new handle on every HMR pass.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export type DB = Database.Database;

const DATABASE_DIR =
  process.env.PERSONAL_DATA_DIR ?? path.join(process.cwd(), '.data', 'personal');

export const DATABASE_PATH = path.join(DATABASE_DIR, 'journal.sqlite');

interface GlobalWithDb {
  __journalDb?: DB;
}

const globalRef = globalThis as unknown as GlobalWithDb;

function openDatabase(): DB {
  mkdirSync(DATABASE_DIR, { recursive: true });

  const database = new Database(DATABASE_PATH);

  // WAL is not available on some network filesystems; fall back quietly.
  try {
    database.pragma('journal_mode = WAL');
  } catch {
    /* keep the default journal mode */
  }

  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');

  return database;
}

/**
 * Shared connection. Created lazily on first use so importing this module has
 * no side effects during `astro build` page collection.
 */
export function getDb(): DB {
  globalRef.__journalDb ??= openDatabase();
  return globalRef.__journalDb;
}

/** Test/CLI hook: close the handle so the file can be moved or reopened. */
export function closeDb(): void {
  globalRef.__journalDb?.close();
  globalRef.__journalDb = undefined;
}

/** Run `fn` inside a transaction, rolling back on any thrown error. */
export function transaction<T>(fn: (db: DB) => T): T {
  const db = getDb();
  return db.transaction(fn)(db);
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Timestamp for an UPDATE. If the new value would equal `previous` (two writes
 * inside the same millisecond), advance by 1 ms so callers can reliably detect
 * that a record changed — `updated_at` must never look unchanged after a write.
 */
export function nextUpdatedAt(previous: string | null | undefined): string {
  const now = Date.now();
  const prior = previous ? Date.parse(previous) : Number.NaN;

  if (Number.isFinite(prior) && now <= prior) {
    return new Date(prior + 1).toISOString();
  }

  return new Date(now).toISOString();
}
