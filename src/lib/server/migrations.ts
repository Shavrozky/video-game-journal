/**
 * Versioned, idempotent schema migrations.
 *
 * Rules followed here:
 * - Never drop or rewrite existing rows. Every migration is additive.
 * - Each migration runs inside a transaction and is recorded in
 *   `schema_migrations`, so re-running is a no-op.
 * - `user_version` is kept in sync for tooling that prefers PRAGMA.
 */

import { getDb, nowIso, transaction, type DB } from './db';

interface Migration {
  version: number;
  name: string;
  up: (db: DB) => void;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'core_personal_games_and_field_logs',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS personal_games (
          id                TEXT PRIMARY KEY,
          source            TEXT NOT NULL
                              CHECK (source IN ('steam', 'manual', 'legacy')),

          -- Unique when present: a Steam game may only be saved once.
          steam_app_id      INTEGER UNIQUE,
          -- Preserved so legacy routes/links keep resolving.
          legacy_game_id    TEXT UNIQUE,

          title             TEXT NOT NULL,
          platform          TEXT NOT NULL DEFAULT 'PC',
          franchise         TEXT,
          release_year      INTEGER,
          cover_url         TEXT,
          genre             TEXT,

          status            TEXT NOT NULL DEFAULT 'Queued'
                              CHECK (status IN ('Next','Queued','Playing','On Hold',
                                                'Someday','Cleared','Abandoned','Logged')),
          priority          TEXT NOT NULL DEFAULT 'Medium'
                              CHECK (priority IN ('High','Medium','Low')),

          hours_played      REAL,
          progress_percent  INTEGER,
          personal_rating   INTEGER,

          notes             TEXT,

          started_at        TEXT,
          completed_at      TEXT,

          -- Preserves the original registry order of the seeded backlog.
          registry          INTEGER,

          created_at        TEXT NOT NULL,
          updated_at        TEXT NOT NULL,

          CHECK (hours_played IS NULL OR hours_played >= 0),
          CHECK (progress_percent IS NULL OR (progress_percent BETWEEN 0 AND 100)),
          CHECK (personal_rating IS NULL OR (personal_rating BETWEEN 1 AND 10)),
          CHECK (release_year IS NULL OR (release_year BETWEEN 1950 AND 2100))
        );

        CREATE INDEX IF NOT EXISTS idx_personal_games_created
          ON personal_games(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_personal_games_status
          ON personal_games(status);
        CREATE INDEX IF NOT EXISTS idx_personal_games_registry
          ON personal_games(registry);

        CREATE TABLE IF NOT EXISTS personal_field_logs (
          id                  TEXT PRIMARY KEY,
          personal_game_id    TEXT NOT NULL
                                REFERENCES personal_games(id) ON DELETE RESTRICT,

          title               TEXT NOT NULL,
          session_date        TEXT,
          duration_minutes    INTEGER,
          player_condition    TEXT,
          mood                TEXT,

          content_markdown    TEXT NOT NULL DEFAULT '',

          publication_status  TEXT NOT NULL DEFAULT 'draft'
                                CHECK (publication_status IN ('draft','published')),

          created_at          TEXT NOT NULL,
          updated_at          TEXT NOT NULL,
          published_at        TEXT,

          CHECK (duration_minutes IS NULL OR duration_minutes >= 0)
        );

        CREATE INDEX IF NOT EXISTS idx_field_logs_game
          ON personal_field_logs(personal_game_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_field_logs_status
          ON personal_field_logs(publication_status);
      `);
    },
  },
];

export interface MigrationResult {
  applied: number[];
  skipped: number[];
  currentVersion: number;
}

function ensureMigrationsTable(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

export function migrate(): MigrationResult {
  const db = getDb();
  ensureMigrationsTable(db);

  const appliedVersions = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((row) => (row as { version: number }).version),
  );

  const result: MigrationResult = { applied: [], skipped: [], currentVersion: 0 };

  for (const migration of MIGRATIONS) {
    if (appliedVersions.has(migration.version)) {
      result.skipped.push(migration.version);
      continue;
    }

    transaction((tx) => {
      migration.up(tx);
      tx.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        nowIso(),
      );
      tx.pragma(`user_version = ${migration.version}`);
    });

    result.applied.push(migration.version);
  }

  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
  result.currentVersion = row.v ?? 0;

  return result;
}

/** True when the schema has been created at least once. */
export function isInitialised(): boolean {
  const db = getDb();
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='personal_games'")
    .get();
  return !!table;
}
