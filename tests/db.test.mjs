/**
 * Database, migration and legacy-seed tests.
 *
 * These exercise the compiled repository modules directly (no HTTP), including
 * reopening the database to prove persistence.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { buildServerModules, cleanupDir, makeTempDataDir } from './harness.mjs';

const DATA_DIR = makeTempDataDir('db');
process.env.PERSONAL_DATA_DIR = DATA_DIR;

let mod;

before(async () => {
  const bundle = await buildServerModules("db");

  // Windows absolute paths must be file:// URLs for the ESM loader.
  mod = await import(pathToFileURL(bundle).href);
});

after(() => {
  try {
    mod?.db.closeDb();
  } catch {
    /* ignore */
  }
  cleanupDir(DATA_DIR);
});

describe('database initialisation', () => {
  it('creates the schema and enables foreign keys', () => {
    const result = mod.migrations.migrate();

    assert.equal(result.currentVersion, 1);
    assert.deepEqual(result.applied, [1]);

    const db = mod.db.getDb();
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((row) => row.name);

    assert.ok(tables.includes('personal_games'));
    assert.ok(tables.includes('personal_field_logs'));
    assert.ok(tables.includes('schema_migrations'));
  });

  it('uses WAL journal mode', () => {
    const mode = mod.db.getDb().pragma('journal_mode', { simple: true });
    assert.equal(String(mode).toLowerCase(), 'wal');
  });

  it('is idempotent — re-running applies nothing', () => {
    const second = mod.migrations.migrate();
    assert.deepEqual(second.applied, []);
    assert.deepEqual(second.skipped, [1]);
    assert.equal(second.currentVersion, 1);
  });
});

describe('legacy backlog migration', () => {
  it('imports exactly one record per backlog entry', () => {
    const result = mod.seed.seedLegacyBacklog();

    assert.equal(result.total, 16);
    assert.equal(result.inserted, 16);
    assert.equal(result.existing, 0);

    // Exactly one row per legacy game id — no duplicates.
    const db = mod.db.getDb();
    const duplicates = db
      .prepare(
        'SELECT legacy_game_id, COUNT(*) c FROM personal_games GROUP BY legacy_game_id HAVING c > 1',
      )
      .all();

    assert.deepEqual(duplicates, []);
  });

  it('does not duplicate on repeated runs', () => {
    const again = mod.seed.seedLegacyBacklog();
    assert.equal(again.inserted, 0);
    assert.equal(again.existing, 16);
    assert.equal(mod.library.countGames(), 16);
  });

  it('preserves title, platform, status, priority and notes', () => {
    const signalis = mod.library.getGameByLegacyId('signalis');

    assert.ok(signalis, 'SIGNALIS should be migrated');
    assert.equal(signalis.title, 'SIGNALIS');
    assert.equal(signalis.platform, 'PC');
    assert.equal(signalis.status, 'Next');
    assert.equal(signalis.priority, 'High');
    assert.equal(signalis.source, 'legacy');
    assert.match(signalis.notes ?? '', /Retrofuturisme/);
    assert.equal(signalis.steamAppId, null);
  });

  it('preserves registry order', () => {
    const mothered = mod.library.getGameByLegacyId('mothered');
    assert.equal(mothered?.registry, 7);

    const village = mod.library.getGameByLegacyId('resident-evil-village');
    assert.equal(village?.registry, 16);
  });

  it('keeps the Logged status for MOTHERED rather than inventing completion', () => {
    const mothered = mod.library.getGameByLegacyId('mothered');
    assert.equal(mothered?.status, 'Logged');
    // No fabricated playtime/completion data.
    assert.equal(mothered?.hoursPlayed, null);
    assert.equal(mothered?.completedAt, null);
  });
});

describe('foreign key integrity', () => {
  it('reports no violations', () => {
    assert.deepEqual(mod.db.getDb().pragma('foreign_key_check'), []);
  });

  it('blocks a log pointing at a non-existent game', () => {
    const db = mod.db.getDb();

    assert.throws(() => {
      db.prepare(
        `INSERT INTO personal_field_logs
         (id, personal_game_id, title, content_markdown, publication_status, created_at, updated_at)
         VALUES ('x', 'does-not-exist', 'T', '', 'draft', '2026-01-01', '2026-01-01')`,
      ).run();
    }, /FOREIGN KEY/i);
  });

  it('blocks deleting a game that still has logs', () => {
    const game = mod.library.getGameByLegacyId('signalis');
    mod.logs.createLog({ personalGameId: game.id, title: 'FK guard' });

    assert.throws(() => {
      mod.db.getDb().prepare('DELETE FROM personal_games WHERE id = ?').run(game.id);
    }, /FOREIGN KEY/i);
  });
});

describe('persistence across reopen', () => {
  it('keeps records after closing and reopening the database file', () => {
    const before = mod.library.countGames();
    assert.ok(before >= 16);

    const file = mod.db.DATABASE_PATH;
    assert.ok(existsSync(file), 'database file should exist on disk');

    mod.db.closeDb();
    const countAfter = mod.library.countGames();

    assert.equal(countAfter, before);
  });
});
