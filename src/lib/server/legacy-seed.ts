/**
 * One-time (idempotent) import of the 16 hand-curated entries in
 * `src/data/backlog.ts` into SQLite.
 *
 * Guarantees:
 * - Runs inside a single transaction (all 16 or none).
 * - Keyed on `legacy_game_id`, so repeated runs never duplicate rows.
 * - Does not modify `backlog.ts`; that file stays as the seed + fallback.
 * - Preserves title, platform, status, priority, reason→notes, cover,
 *   franchise, year, genre and registry order.
 * - Nothing is invented: optional fields absent from the source stay null.
 */

import { backlogGames, type BacklogGame } from '../../data/backlog';
import { getDb, transaction, nowIso, type DB } from './db';

export interface SeedResult {
  inserted: number;
  existing: number;
  total: number;
}

function toSeedRow(game: BacklogGame, timestamp: string) {
  return {
    id: `legacy-${game.id}`,
    source: 'legacy' as const,
    steam_app_id: null,
    legacy_game_id: game.id,
    title: game.title,
    platform: game.platform,
    franchise: game.franchise,
    release_year: game.year,
    cover_url: game.cover ?? null,
    genre: game.genre,
    // The legacy status vocabulary is a subset of the library vocabulary.
    status: game.status === 'Logged' ? 'Logged' : game.status,
    priority: game.priority,
    notes: game.reason,
    registry: game.registry,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

const INSERT_SQL = `
  INSERT INTO personal_games (
    id, source, steam_app_id, legacy_game_id,
    title, platform, franchise, release_year, cover_url, genre,
    status, priority, notes, registry,
    created_at, updated_at
  ) VALUES (
    @id, @source, @steam_app_id, @legacy_game_id,
    @title, @platform, @franchise, @release_year, @cover_url, @genre,
    @status, @priority, @notes, @registry,
    @created_at, @updated_at
  )
`;

/**
 * Seeds legacy backlog rows.
 *
 * @param options.force  re-sync fields from backlog.ts even for rows that
 *                       already exist (never touches personal edits unless
 *                       `force` is explicitly requested).
 */
export function seedLegacyBacklog(options: { force?: boolean } = {}): SeedResult {
  const force = options.force ?? false;

  return transaction((db: DB) => {
    const insert = db.prepare(INSERT_SQL);
    const exists = db.prepare('SELECT id FROM personal_games WHERE legacy_game_id = ?');
    const update = db.prepare(`
      UPDATE personal_games SET
        title = @title,
        platform = @platform,
        franchise = @franchise,
        release_year = @release_year,
        cover_url = @cover_url,
        genre = @genre,
        registry = @registry,
        updated_at = @updated_at
      WHERE legacy_game_id = @legacy_game_id
    `);

    const timestamp = nowIso();
    let inserted = 0;
    let existing = 0;

    for (const game of backlogGames) {
      const row = toSeedRow(game, timestamp);

      if (exists.get(game.id)) {
        existing += 1;
        if (force) update.run(row);
        continue;
      }

      insert.run(row);
      inserted += 1;
    }

    const total = (db.prepare('SELECT COUNT(*) AS c FROM personal_games').get() as { c: number }).c;

    return { inserted, existing, total };
  });
}

/** Number of rows that came from the legacy backlog seed. */
export function legacyCount(): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS c FROM personal_games WHERE source = 'legacy'")
    .get() as { c: number };
  return row.c;
}
