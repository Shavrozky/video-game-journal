/**
 * Shared types for the personal library (SQLite-backed).
 *
 * These are the *personal* records. They are deliberately separate from
 * `src/data/catalog/types.ts`, which describes the read-only Steam catalog.
 */

export const GAME_STATUSES = [
  'Next',
  'Queued',
  'Playing',
  'On Hold',
  'Someday',
  'Cleared',
  'Abandoned',
  'Logged',
] as const;

export type GameStatus = (typeof GAME_STATUSES)[number];

export const PRIORITIES = ['High', 'Medium', 'Low'] as const;

export type Priority = (typeof PRIORITIES)[number];

export const GAME_SOURCES = ['steam', 'manual', 'legacy'] as const;

export type GameSource = (typeof GAME_SOURCES)[number];

export const PLATFORMS = ['PC', 'PS1', 'PS2', 'PS3', 'PS4', 'PS5', 'Switch', 'Other'] as const;

export type Platform = (typeof PLATFORMS)[number];

/** Which statuses count as "in the backlog" (i.e. not yet finished). */
export const BACKLOG_STATUSES: readonly GameStatus[] = [
  'Next',
  'Queued',
  'Playing',
  'On Hold',
  'Someday',
];

export interface PersonalGame {
  id: string;
  source: GameSource;

  steamAppId: number | null;
  legacyGameId: string | null;

  title: string;
  platform: string;
  franchise: string | null;
  releaseYear: number | null;
  coverUrl: string | null;
  genre: string | null;

  status: GameStatus;
  priority: Priority;

  hoursPlayed: number | null;
  progressPercent: number | null;
  personalRating: number | null;

  notes: string | null;

  startedAt: string | null;
  completedAt: string | null;

  registry: number | null;

  createdAt: string;
  updatedAt: string;
}

export const PUBLICATION_STATUSES = ['draft', 'published'] as const;

export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];

export interface PersonalFieldLog {
  id: string;
  personalGameId: string;

  title: string;
  sessionDate: string | null;
  durationMinutes: number | null;

  playerCondition: string | null;
  mood: string | null;

  contentMarkdown: string;

  publicationStatus: PublicationStatus;

  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}

/** Field log joined with its game, for listings. */
export interface FieldLogWithGame extends PersonalFieldLog {
  gameTitle: string;
}

export const SORTABLE_LIBRARY_ORDERS = ['recent', 'title', 'progress'] as const;
export type LibraryOrder = (typeof SORTABLE_LIBRARY_ORDERS)[number];

export function isGameStatus(value: unknown): value is GameStatus {
  return typeof value === 'string' && (GAME_STATUSES as readonly string[]).includes(value);
}

export function isPriority(value: unknown): value is Priority {
  return typeof value === 'string' && (PRIORITIES as readonly string[]).includes(value);
}

export function isPublicationStatus(value: unknown): value is PublicationStatus {
  return typeof value === 'string' && (PUBLICATION_STATUSES as readonly string[]).includes(value);
}

export function isLibraryOrder(value: unknown): value is LibraryOrder {
  return typeof value === 'string' && (SORTABLE_LIBRARY_ORDERS as readonly string[]).includes(value);
}
