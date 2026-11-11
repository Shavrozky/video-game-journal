#!/usr/bin/env node
/**
 * Database maintenance without Astro.
 *
 * Deliberately does NOT import the TypeScript source: it re-declares the schema
 * migration it needs and reads the legacy seed from a small JSON export, so it
 * keeps working even if the app fails to compile.
 *
 * For anything that must match app behaviour exactly, the app's own
 * `ensureDatabase()` runs the same migrations on first request.
 */

import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const DATA_DIR = process.env.PERSONAL_DATA_DIR ?? path.join(ROOT, '.data', 'personal');
const DB_PATH = path.join(DATA_DIR, 'journal.sqlite');
const BACKUP_DIR = path.join(ROOT, '.data', 'backups');

const command = process.argv[2] ?? 'status';

function open({ readonly = false } = {}) {
  mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH, { readonly });
  if (!readonly) {
    try {
      db.pragma('journal_mode = WAL');
    } catch {
      /* ignore */
    }
    db.pragma('foreign_keys = ON');
  }
  return db;
}

/* ---------------------------------------------------------------- */
/* Schema — must stay in sync with src/lib/server/migrations.ts      */
/* ---------------------------------------------------------------- */

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version),
  );

  const steps = [
    {
      version: 1,
      name: 'core_personal_games_and_field_logs',
      sql: `
        CREATE TABLE IF NOT EXISTS personal_games (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL CHECK (source IN ('steam','manual','legacy')),
          steam_app_id INTEGER UNIQUE,
          legacy_game_id TEXT UNIQUE,
          title TEXT NOT NULL,
          platform TEXT NOT NULL DEFAULT 'PC',
          franchise TEXT,
          release_year INTEGER,
          cover_url TEXT,
          genre TEXT,
          status TEXT NOT NULL DEFAULT 'Queued'
            CHECK (status IN ('Next','Queued','Playing','On Hold','Someday','Cleared','Abandoned','Logged')),
          priority TEXT NOT NULL DEFAULT 'Medium'
            CHECK (priority IN ('High','Medium','Low')),
          hours_played REAL,
          progress_percent INTEGER,
          personal_rating INTEGER,
          notes TEXT,
          started_at TEXT,
          completed_at TEXT,
          registry INTEGER,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK (hours_played IS NULL OR hours_played >= 0),
          CHECK (progress_percent IS NULL OR (progress_percent BETWEEN 0 AND 100)),
          CHECK (personal_rating IS NULL OR (personal_rating BETWEEN 1 AND 10)),
          CHECK (release_year IS NULL OR (release_year BETWEEN 1950 AND 2100))
        );
        CREATE INDEX IF NOT EXISTS idx_personal_games_created ON personal_games(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_personal_games_status ON personal_games(status);
        CREATE INDEX IF NOT EXISTS idx_personal_games_registry ON personal_games(registry);

        CREATE TABLE IF NOT EXISTS personal_field_logs (
          id TEXT PRIMARY KEY,
          personal_game_id TEXT NOT NULL REFERENCES personal_games(id) ON DELETE RESTRICT,
          title TEXT NOT NULL,
          session_date TEXT,
          duration_minutes INTEGER,
          player_condition TEXT,
          mood TEXT,
          content_markdown TEXT NOT NULL DEFAULT '',
          publication_status TEXT NOT NULL DEFAULT 'draft'
            CHECK (publication_status IN ('draft','published')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          published_at TEXT,
          CHECK (duration_minutes IS NULL OR duration_minutes >= 0)
        );
        CREATE INDEX IF NOT EXISTS idx_field_logs_game
          ON personal_field_logs(personal_game_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_field_logs_status
          ON personal_field_logs(publication_status);
      `,
    },
  ];

  const appliedNow = [];

  for (const step of steps) {
    if (applied.has(step.version)) continue;

    db.transaction(() => {
      db.exec(step.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?,?,?)').run(
        step.version,
        step.name,
        new Date().toISOString(),
      );
      db.pragma(`user_version = ${step.version}`);
    })();

    appliedNow.push(step.version);
  }

  return appliedNow;
}

/* ---------------------------------------------------------------- */
/* Legacy seed — parsed from backlog.ts without executing TS         */
/* ---------------------------------------------------------------- */

/**
 * Read the legacy backlog without a TypeScript toolchain.
 *
 * `backlog.ts` is a pure data module: interfaces + one exported array literal.
 * We strip the type annotations and evaluate the array in an isolated `vm`
 * context, so the CLI sees exactly the same 16 records the app does — a regex
 * extraction would drift silently as soon as a field is reformatted.
 */
function readLegacyGames() {
  const file = path.join(ROOT, 'src', 'data', 'backlog.ts');
  const source = readFileSync(file, 'utf8');

  // Drop declarations that are pure TypeScript, then the `export` keyword and
  // the remaining type annotations, so the file parses as plain JavaScript.
  const stripped = source
    .replace(/^\s*import[^;]*;?\s*$/gm, '')
    .replace(/export\s+interface\s+\w+\s*\{[\s\S]*?^\}/gm, '')
    .replace(/export\s+type\s+\w+\s*=[^;]*;/gm, '')
    .replace(/^export\s+/gm, '')
    // `const backlogGames: BacklogGame[] = [` -> `const backlogGames = [`
    .replace(/^(const\s+\w+)\s*:\s*[^=]+=/gm, '$1 =')
    // `function findGame(id: string)` -> `function findGame(id)`
    .replace(/\((?:(\w+)\s*:\s*[^,)]+)\)/g, '($1)')
    .replace(/\bas\s+const\b/g, '');

  const sandbox = { console: { log: () => {} } };
  const context = vm.createContext(sandbox);

  vm.runInContext(`${stripped}\nglobalThis.__games = backlogGames;`, context, { timeout: 2000 });

  const games = sandbox.__games;
  if (!Array.isArray(games) || games.length === 0) {
    throw new Error('backlogGames could not be evaluated from src/data/backlog.ts');
  }

  return games;
}

function seed(db, { force = false } = {}) {
  const games = readLegacyGames();
  if (games.length === 0) throw new Error('No legacy games parsed from src/data/backlog.ts');

  const exists = db.prepare('SELECT id FROM personal_games WHERE legacy_game_id = ?');
  const insert = db.prepare(`
    INSERT INTO personal_games (
      id, source, steam_app_id, legacy_game_id, title, platform, franchise,
      release_year, cover_url, genre, status, priority, notes, registry,
      created_at, updated_at
    ) VALUES (@id,'legacy',NULL,@legacy_game_id,@title,@platform,@franchise,
      @release_year,@cover_url,@genre,@status,@priority,@notes,@registry,@ts,@ts)
  `);

  const now = new Date().toISOString();
  const result = { inserted: 0, existing: 0, total: games.length };

  db.transaction(() => {
    for (const game of games) {
      if (exists.get(game.id)) {
        result.existing += 1;
        if (force) {
          db.prepare(
            'UPDATE personal_games SET title=?, platform=?, franchise=?, release_year=?, cover_url=?, genre=?, registry=?, updated_at=? WHERE legacy_game_id=?',
          ).run(
            game.title,
            game.platform,
            game.franchise ?? null,
            game.year ? Number(game.year) : null,
            game.cover ?? null,
            game.genre ?? null,
            game.registry ? Number(game.registry) : null,
            now,
            game.id,
          );
        }
        continue;
      }

      insert.run({
        id: `legacy-${game.id}`,
        legacy_game_id: game.id,
        title: game.title,
        platform: game.platform,
        franchise: game.franchise ?? null,
        release_year: game.year ? Number(game.year) : null,
        cover_url: game.cover ?? null,
        genre: game.genre ?? null,
        status: game.status ?? 'Queued',
        priority: game.priority ?? 'Medium',
        notes: game.reason ?? null,
        registry: game.registry ? Number(game.registry) : null,
        ts: now,
      });
      result.inserted += 1;
    }
  })();

  return result;
}

/* ---------------------------------------------------------------- */
/* Commands                                                          */
/* ---------------------------------------------------------------- */

function cmdMigrate() {
  const db = open();
  const applied = migrate(db);
  console.log(applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Schema already up to date.');
  db.close();
}

function cmdSeed() {
  const db = open();
  migrate(db);
  const result = seed(db);
  console.log(
    `Legacy seed: ${result.inserted} inserted, ${result.existing} already present (${result.total} in backlog.ts).`,
  );
  db.close();
}

function cmdStatus() {
  if (!existsSync(DB_PATH)) {
    console.log(`No database yet at ${DB_PATH}`);
    console.log('Run: npm run db:migrate && npm run db:seed');
    return;
  }

  const db = open({ readonly: true });

  const version = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v ?? 0;
  const games = db.prepare('SELECT COUNT(*) AS c FROM personal_games').get().c;
  const logs = db.prepare('SELECT COUNT(*) AS c FROM personal_field_logs').get().c;
  const drafts = db
    .prepare("SELECT COUNT(*) AS c FROM personal_field_logs WHERE publication_status='draft'")
    .get().c;
  const bySource = db.prepare('SELECT source, COUNT(*) AS c FROM personal_games GROUP BY source').all();

  console.log('Personal journal database');
  console.log(`  path        : ${DB_PATH}`);
  console.log(`  size        : ${(statSync(DB_PATH).size / 1024).toFixed(1)} KB`);
  console.log(`  schema      : v${version}`);
  console.log(`  games       : ${games}`);
  console.log(`  field logs  : ${logs} (${drafts} draft)`);
  console.log(`  by source   : ${bySource.map((r) => `${r.source}=${r.c}`).join(', ') || 'none'}`);

  db.close();
}

function cmdBackup() {
  if (!existsSync(DB_PATH)) {
    console.error('No database to back up yet.');
    process.exit(1);
  }

  mkdirSync(BACKUP_DIR, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const target = path.join(BACKUP_DIR, `journal-${stamp}.sqlite`);

  // Use SQLite's own backup so WAL contents are included consistently.
  const db = open({ readonly: true });
  db.backup(target)
    .then(() => {
      console.log(`Backup written: ${target}`);
      console.log(`Size: ${(statSync(target).size / 1024).toFixed(1)} KB`);
      db.close();
    })
    .catch((error) => {
      console.error('Backup failed:', error.message);
      db.close();
      process.exit(1);
    });
}

function cmdRestore() {
  const file = process.argv[3];

  if (!file) {
    console.error('Usage: npm run db:restore -- <path-to-backup.sqlite>');
    process.exit(1);
  }

  const source = path.resolve(file);
  if (!existsSync(source)) {
    console.error(`Backup not found: ${source}`);
    process.exit(1);
  }

  // Keep the current database, never silently destroy it.
  if (existsSync(DB_PATH)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const aside = path.join(BACKUP_DIR, `pre-restore-${stamp}.sqlite`);
    mkdirSync(BACKUP_DIR, { recursive: true });
    copyFileSync(DB_PATH, aside);
    console.log(`Current database saved as ${aside}`);
  }

  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${DB_PATH}${suffix}`;
    if (existsSync(sidecar)) unlinkSync(sidecar);
  }

  copyFileSync(source, DB_PATH);
  console.log(`Restored ${source} -> ${DB_PATH}`);
}

function cmdListBackups() {
  if (!existsSync(BACKUP_DIR)) {
    console.log('No backups directory yet.');
    return;
  }

  const files = readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.sqlite') || f.endsWith('.gz'));
  if (files.length === 0) {
    console.log('No backups yet. Run: npm run db:backup');
    return;
  }

  for (const file of files.sort().reverse()) {
    const full = path.join(BACKUP_DIR, file);
    console.log(`${file}  ${(statSync(full).size / 1024).toFixed(1)} KB`);
  }
}

switch (command) {
  case 'migrate':
    cmdMigrate();
    break;
  case 'seed':
    cmdSeed();
    break;
  case 'status':
    cmdStatus();
    break;
  case 'backup':
    cmdBackup();
    break;
  case 'restore':
    cmdRestore();
    break;
  case 'backups':
    cmdListBackups();
    break;
  default:
    console.error(`Unknown command "${command}". Use: migrate | seed | status | backup | restore | backups`);
    process.exit(1);
}
