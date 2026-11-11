import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DATABASE_PATH = resolve(
  process.cwd(),
  ".data",
  "personal",
  "journal.sqlite",
);

mkdirSync(dirname(DATABASE_PATH), {
  recursive: true,
});

export const db = new Database(DATABASE_PATH);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS personal_games (
    id TEXT PRIMARY KEY,

    source TEXT NOT NULL
      CHECK (source IN ('steam', 'manual', 'legacy')),

    steam_app_id INTEGER UNIQUE,

    title TEXT NOT NULL,
    platform TEXT NOT NULL DEFAULT 'PC',
    cover_url TEXT,

    status TEXT NOT NULL DEFAULT 'Queued',

    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS
    idx_personal_games_created
    ON personal_games(created_at DESC);
`);

export interface PersonalGame {
  id: string;
  source: "steam" | "manual" | "legacy";
  steamAppId: number | null;
  title: string;
  platform: string;
  coverUrl: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export function getPersonalGames(): PersonalGame[] {
  return db
    .prepare(
      `
    SELECT
      id,
      source,
      steam_app_id AS steamAppId,
      title,
      platform,
      cover_url AS coverUrl,
      status,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM personal_games
    WHERE source = 'steam'
    ORDER BY created_at DESC, rowid DESC
  `,
    )
    .all() as PersonalGame[];
}

export function findSteamGame(steamAppId: number): PersonalGame | undefined {
  return db
    .prepare(
      `
    SELECT
      id,
      source,
      steam_app_id AS steamAppId,
      title,
      platform,
      cover_url AS coverUrl,
      status,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM personal_games
    WHERE steam_app_id = ?
  `,
    )
    .get(steamAppId) as PersonalGame | undefined;
}
