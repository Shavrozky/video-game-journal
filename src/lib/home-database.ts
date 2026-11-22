/**
 * Row model for the home page "Database View".
 *
 * Joins two real sources and invents nothing:
 *   1. `getCollection('journal')` — the Markdown field logs (always available).
 *   2. The personal library SQLite table — via the repository, when imported.
 *
 * Field availability in this project (verified, not assumed):
 *   - journal schema has `score`, `genre`, `releaseYear`, `owned` as OPTIONAL
 *     fields; most entries do not set them, so those cells render "—".
 *   - `status` vocabulary differs between the two sources ("Cleared" vs
 *     "Completed"), so both are normalised to one bucket for filtering.
 *   - `gameId` may point at a game that is NOT in the backlog (e.g. `rdr2`),
 *     which is why every lookup here is nullable.
 */

import type { JournalEntry } from './journal';
import { gameForEntry, journalPath } from './journal';
import type { PersonalGame } from '../data/library/types';
import { backlogGames } from '../data/backlog';

/** Normalised status bucket used by the filter chips. */
export type StatusBucket = 'Completed' | 'Playing' | 'Backlog' | 'Other';

export interface DatabaseRow {
  /** Stable key for DOM diffing / testing. */
  key: string;

  title: string;
  /** Journal title, shown as the secondary line under the game name. */
  noteTitle: string | null;

  href: string;
  hrefLabel: string;

  coverUrl: string | null;
  platform: string;

  score: number | null;
  genres: string[];
  releaseYear: number | null;
  lastPlayedYear: number | null;

  /** Raw status as written by the author. */
  statusLabel: string;
  statusBucket: StatusBucket;

  /** null when the collection simply does not record ownership. */
  owned: boolean | null;

  /** 1 = highest. Used by "Favorite Order". */
  favoriteRank: number;
}

/* ------------------------------------------------------------------ */
/* Mapping helpers                                                     */
/* ------------------------------------------------------------------ */

const BACKLOG_ORDER = new Map(backlogGames.map((game, index) => [game.id, index + 1]));

const BACKLOG_BY_ID = new Map(backlogGames.map((game) => [game.id, game]));

function yearOf(value: unknown): number | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.getUTCFullYear();
  }

  if (typeof value === 'string') {
    const match = /^(\d{4})/.exec(value.trim());
    return match ? Number(match[1]) : null;
  }

  if (typeof value === 'number' && Number.isInteger(value)) return value;

  return null;
}

function splitGenres(value: unknown): string[] {
  if (typeof value !== 'string') return [];

  return value
    .split(/[,/]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 3);
}

/**
 * Table subtitles must stay one short line. Any longer value is truncated so a
 * stray multi-paragraph note can never blow up a row's height.
 */
function subtitle(value: unknown, max = 80): string | null {
  if (typeof value !== 'string') return null;

  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return null;

  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Collapse the two status vocabularies into one bucket. */
export function statusBucket(status: string, entryType?: string): StatusBucket {
  const value = status.toLowerCase();

  if (value === 'cleared' || value === 'completed' || value === 'masterpiece') return 'Completed';
  if (value === 'in progress' || value === 'playing') return 'Playing';
  if (value === 'next' || value === 'queued' || value === 'on hold' || value === 'someday') {
    return 'Backlog';
  }

  // Curated notes about games that are planned but not yet played.
  if (entryType === 'overview' || value === 'planned') return 'Backlog';

  return 'Other';
}

/* ------------------------------------------------------------------ */
/* Journal-sourced rows                                                */
/* ------------------------------------------------------------------ */

export function rowsFromJournals(entries: JournalEntry[]): DatabaseRow[] {
  return entries.map((entry) => {
    const data = entry.data;
    const backlogGame = gameForEntry(entry);
    const linkedGame = data.gameId ? BACKLOG_BY_ID.get(data.gameId) : undefined;

    // Favourite ranking falls back to the backlog registry number, then to a
    // stable alphabetical position so the order is deterministic either way.
    const favoriteRank =
      (data.gameId ? BACKLOG_ORDER.get(data.gameId) : undefined) ??
      (backlogGame ? BACKLOG_ORDER.get(backlogGame.id) : undefined) ??
      999;

    return {
      key: `journal:${entry.id}`,
      title: data.game,
      noteTitle: subtitle(data.title),
      href: journalPath(entry),
      hrefLabel: 'Read journal',

      coverUrl: data.boxArtUrl ?? backlogGame?.cover ?? null,
      platform: data.platform,

      score: typeof data.score === 'number' ? data.score : null,
      genres: splitGenres(data.genre),
      releaseYear: data.releaseYear ?? linkedGame?.year ?? backlogGame?.year ?? null,
      lastPlayedYear: yearOf(data.publishDate),

      statusLabel: data.status,
      statusBucket: statusBucket(data.status, data.entryType),
      owned: typeof data.owned === 'boolean' ? data.owned : null,

      favoriteRank,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Library-sourced rows                                                */
/* ------------------------------------------------------------------ */

export function rowsFromLibrary(games: PersonalGame[]): DatabaseRow[] {
  return games.map((game) => ({
    key: `library:${game.id}`,
    title: game.title,
    // Only the short, deliberate fields belong in a table subtitle. Falling
    // back to `notes` would dump a whole journal entry into a table cell.
    noteTitle: subtitle(game.franchise),

    href: `/library/${game.id}`,
    hrefLabel: 'Open record',

    coverUrl: game.coverUrl,
    platform: game.platform,

    score: game.personalRating,
    genres: game.genre ? splitGenres(game.genre) : [],
    releaseYear: game.releaseYear,
    lastPlayedYear: yearOf(game.completedAt ?? game.startedAt ?? game.updatedAt),

    statusLabel: game.status,
    statusBucket: statusBucket(game.status),
    // The library does not track physical ownership, so this stays unknown
    // rather than being guessed.
    owned: null,

    favoriteRank: game.registry ?? 500,
  }));
}

/**
 * Combine both sources, de-duplicated.
 *
 * A journal entry and a library record describing the same game are merged into
 * one row (journal metadata wins for score/genre, because it is the hand-written
 * source). Matching is by `legacyGameId` then by normalised title.
 */
export function combineRows(journalRows: DatabaseRow[], libraryRows: DatabaseRow[]): DatabaseRow[] {
  const normalise = (value: string) =>
    value
      .toLowerCase()
      .replace(/\s*\(\d{4}\)\s*$/, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();

  const byTitle = new Map(journalRows.map((row) => [normalise(row.title), row]));
  const merged: DatabaseRow[] = [...journalRows];

  for (const row of libraryRows) {
    const key = normalise(row.title);
    const existing = byTitle.get(key);

    if (!existing) {
      merged.push(row);
      byTitle.set(key, row);
      continue;
    }

    // Fill gaps from the library record without overwriting journal data.
    existing.coverUrl ??= row.coverUrl;
    existing.releaseYear ??= row.releaseYear;
    existing.score ??= row.score;
    if (existing.genres.length === 0) existing.genres = row.genres;
    existing.owned ??= row.owned;
  }

  return merged;
}

/* ------------------------------------------------------------------ */
/* Sorting                                                             */
/* ------------------------------------------------------------------ */

export type SortMode = 'favorite' | 'score' | 'alpha';

export function sortRows(rows: DatabaseRow[], mode: SortMode): DatabaseRow[] {
  const copy = [...rows];

  switch (mode) {
    case 'score':
      // Unscored entries always sink to the bottom, whatever the sort.
      return copy.sort((a, b) => {
        if (a.score === null && b.score === null) return a.title.localeCompare(b.title, 'en');
        if (a.score === null) return 1;
        if (b.score === null) return -1;
        return b.score - a.score || a.title.localeCompare(b.title, 'en');
      });

    case 'alpha':
      return copy.sort((a, b) => a.title.localeCompare(b.title, 'en'));

    case 'favorite':
    default:
      return copy.sort(
        (a, b) => a.favoriteRank - b.favoriteRank || a.title.localeCompare(b.title, 'en'),
      );
  }
}

/** Search across title, genre and platform. */
export function filterRows(rows: DatabaseRow[], query: string, bucket: StatusBucket | 'All'): DatabaseRow[] {
  const needle = query.trim().toLowerCase();

  return rows.filter((row) => {
    if (bucket !== 'All' && row.statusBucket !== bucket) return false;
    if (!needle) return true;

    const haystack = [row.title, row.platform, row.statusLabel, ...row.genres]
      .join(' ')
      .toLowerCase();

    return haystack.includes(needle);
  });
}
