/**
 * Personal library repository.
 *
 * All SQL for personal games lives here. API routes and pages call these
 * functions; no component contains hand-written SQL.
 */

import { randomUUID } from 'node:crypto';

import {
  BACKLOG_STATUSES,
  GAME_STATUSES,
  PLATFORMS,
  PRIORITIES,
  type GameSource,
  type GameStatus,
  type LibraryOrder,
  type PersonalGame,
  type Priority,
} from '../../data/library/types';
import { getDb, nextUpdatedAt, nowIso, transaction, type DB } from './db';
import { seedLegacyBacklog } from './legacy-seed';

/* ------------------------------------------------------------------ */
/* Row mapping                                                         */
/* ------------------------------------------------------------------ */

interface GameRow {
  id: string;
  source: GameSource;
  steam_app_id: number | null;
  legacy_game_id: string | null;
  title: string;
  platform: string;
  franchise: string | null;
  release_year: number | null;
  cover_url: string | null;
  genre: string | null;
  status: GameStatus;
  priority: Priority;
  hours_played: number | null;
  progress_percent: number | null;
  personal_rating: number | null;
  notes: string | null;
  started_at: string | null;
  completed_at: string | null;
  registry: number | null;
  created_at: string;
  updated_at: string;
}

const SELECT_COLUMNS = `
  id, source, steam_app_id, legacy_game_id,
  title, platform, franchise, release_year, cover_url, genre,
  status, priority, hours_played, progress_percent, personal_rating,
  notes, started_at, completed_at, registry, created_at, updated_at
`;

function mapGame(row: GameRow): PersonalGame {
  return {
    id: row.id,
    source: row.source,
    steamAppId: row.steam_app_id,
    legacyGameId: row.legacy_game_id,
    title: row.title,
    platform: row.platform,
    franchise: row.franchise,
    releaseYear: row.release_year,
    coverUrl: row.cover_url,
    genre: row.genre,
    status: row.status,
    priority: row.priority,
    hoursPlayed: row.hours_played,
    progressPercent: row.progress_percent,
    personalRating: row.personal_rating,
    notes: row.notes,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    registry: row.registry,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export class ValidationError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
  }
}

export class DuplicateError extends Error {
  readonly existing: PersonalGame | null;

  constructor(message: string, existing: PersonalGame | null = null) {
    super(message);
    this.name = 'DuplicateError';
    this.existing = existing;
  }
}

export class NotFoundError extends Error {
  constructor(message = 'Record not found.') {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends Error {
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ConflictError';
    this.details = details;
  }
}

const MAX_TITLE = 200;
const MAX_TEXT = 4000;
const MAX_URL = 2000;

function requireTitle(value: unknown): string {
  const title = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

  if (!title) throw new ValidationError('title', 'Judul game wajib diisi.');
  if (title.length > MAX_TITLE) {
    throw new ValidationError('title', `Judul maksimal ${MAX_TITLE} karakter.`);
  }

  return title;
}

function optionalText(value: unknown, field: string, max = MAX_TEXT): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new ValidationError(field, `${field} harus berupa teks.`);

  const text = value.trim();
  if (!text) return null;
  if (text.length > max) throw new ValidationError(field, `${field} maksimal ${max} karakter.`);

  return text;
}

function optionalHttpUrl(value: unknown, field = 'coverUrl'): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new ValidationError(field, `${field} harus berupa URL.`);

  const raw = value.trim();
  if (!raw) return null;
  if (raw.length > MAX_URL) throw new ValidationError(field, `URL terlalu panjang.`);

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ValidationError(field, 'URL tidak valid.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError(field, 'URL harus http atau https.');
  }

  return parsed.href;
}

function optionalNumber(
  value: unknown,
  field: string,
  min: number,
  max: number,
  { integer = false }: { integer?: boolean } = {},
): number | null {
  if (value === null || value === undefined || value === '') return null;

  const parsed = typeof value === 'number' ? value : Number(value);

  if (!Number.isFinite(parsed)) throw new ValidationError(field, `${field} harus berupa angka.`);
  if (integer && !Number.isInteger(parsed)) {
    throw new ValidationError(field, `${field} harus bilangan bulat.`);
  }
  if (parsed < min || parsed > max) {
    throw new ValidationError(field, `${field} harus antara ${min} dan ${max}.`);
  }

  return parsed;
}

function optionalDate(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new ValidationError(field, `${field} tidak valid.`);

  const raw = value.trim();

  // Accept YYYY-MM-DD (from <input type="date">) only; store as ISO date.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new ValidationError(field, 'Format tanggal harus YYYY-MM-DD.');
  }

  const parsed = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) throw new ValidationError(field, 'Tanggal tidak valid.');

  return raw;
}

export function normaliseTitle(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/* ------------------------------------------------------------------ */
/* Read                                                               */
/* ------------------------------------------------------------------ */

export interface ListGamesOptions {
  search?: string;
  platform?: string | null;
  status?: string | null;
  priority?: string | null;
  order?: LibraryOrder;
  includeLegacy?: boolean;
}

const ORDER_SQL: Record<LibraryOrder, string> = {
  recent: 'created_at DESC, rowid DESC',
  title: 'title COLLATE NOCASE ASC',
  progress:
    'COALESCE(progress_percent, -1) DESC, COALESCE(hours_played, -1) DESC, title COLLATE NOCASE ASC',
};

export function listGames(options: ListGamesOptions = {}): PersonalGame[] {
  const db = getDb();
  const where: string[] = [];
  const params: Record<string, unknown> = {};

  if (options.search) {
    // Escaping LIKE wildcards keeps a literal "%" from matching everything.
    where.push(`LOWER(title) LIKE @search ESCAPE '\\'`);
    params.search = `%${options.search.toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  }

  if (options.platform) {
    where.push('platform = @platform');
    params.platform = options.platform;
  }

  if (options.status) {
    where.push('status = @status');
    params.status = options.status;
  }

  if (options.priority) {
    where.push('priority = @priority');
    params.priority = options.priority;
  }

  const order = ORDER_SQL[options.order ?? 'recent'] ?? ORDER_SQL.recent;
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM personal_games ${clause} ORDER BY ${order}`)
    .all(params) as GameRow[];

  return rows.map(mapGame);
}

export function getGameById(id: string): PersonalGame | null {
  const row = getDb()
    .prepare(`SELECT ${SELECT_COLUMNS} FROM personal_games WHERE id = ?`)
    .get(id) as GameRow | undefined;

  return row ? mapGame(row) : null;
}

export function getGameBySteamAppId(steamAppId: number): PersonalGame | null {
  const row = getDb()
    .prepare(`SELECT ${SELECT_COLUMNS} FROM personal_games WHERE steam_app_id = ?`)
    .get(steamAppId) as GameRow | undefined;

  return row ? mapGame(row) : null;
}

export function getGameByLegacyId(legacyGameId: string): PersonalGame | null {
  const row = getDb()
    .prepare(`SELECT ${SELECT_COLUMNS} FROM personal_games WHERE legacy_game_id = ?`)
    .get(legacyGameId) as GameRow | undefined;

  return row ? mapGame(row) : null;
}

export interface LibraryStats {
  total: number;
  playing: number;
  cleared: number;
  backlog: number;
  logged: number;
  fieldLogs: number;
  drafts: number;
}

export function getLibraryStats(): LibraryStats {
  const db = getDb();

  const games = db
    .prepare('SELECT status, COUNT(*) AS c FROM personal_games GROUP BY status')
    .all() as Array<{ status: GameStatus; c: number }>;

  const byStatus = new Map(games.map((row) => [row.status, row.c]));
  const total = games.reduce((sum, row) => sum + row.c, 0);

  const logs = db
    .prepare('SELECT publication_status AS s, COUNT(*) AS c FROM personal_field_logs GROUP BY publication_status')
    .all() as Array<{ s: string; c: number }>;

  const logCounts = new Map(logs.map((row) => [row.s, row.c]));

  return {
    total,
    playing: byStatus.get('Playing') ?? 0,
    cleared: byStatus.get('Cleared') ?? 0,
    logged: byStatus.get('Logged') ?? 0,
    backlog: BACKLOG_STATUSES.reduce((sum, status) => sum + (byStatus.get(status) ?? 0), 0),
    fieldLogs: (logCounts.get('published') ?? 0) + (logCounts.get('draft') ?? 0),
    drafts: logCounts.get('draft') ?? 0,
  };
}

/** Facets present in the library, for filter controls. */
export function getLibraryFacets() {
  const db = getDb();

  const platforms = db
    .prepare('SELECT DISTINCT platform FROM personal_games ORDER BY platform')
    .all()
    .map((row) => (row as { platform: string }).platform);

  return { platforms };
}

/* ------------------------------------------------------------------ */
/* Write                                                              */
/* ------------------------------------------------------------------ */

export interface AddSteamGameInput {
  steamAppId: number;
  /** Resolved server-side from the catalog; never trusted from the client. */
  title: string;
  platform?: string;
  genre?: string | null;
  coverUrl?: string | null;
  releaseYear?: number | null;
  franchise?: string | null;
}

export interface CreateManualGameInput {
  title: unknown;
  platform: unknown;
  franchise?: unknown;
  releaseYear?: unknown;
  genre?: unknown;
  coverUrl?: unknown;
  status?: unknown;
  priority?: unknown;
  notes?: unknown;
}

export function addSteamGame(input: AddSteamGameInput): PersonalGame {
  const db = getDb();

  if (!Number.isSafeInteger(input.steamAppId) || input.steamAppId <= 0) {
    throw new ValidationError('steamAppId', 'Steam AppID tidak valid.');
  }

  const title = requireTitle(input.title);
  const existing = getGameBySteamAppId(input.steamAppId);

  if (existing) {
    throw new DuplicateError('Game sudah ada di Personal Library.', existing);
  }

  const id = randomUUID();
  const now = nowIso();

  try {
    db.prepare(
      `
      INSERT INTO personal_games (
        id, source, steam_app_id, legacy_game_id,
        title, platform, franchise, release_year, cover_url, genre,
        status, priority, created_at, updated_at
      ) VALUES (
        @id, 'steam', @steam_app_id, NULL,
        @title, @platform, @franchise, @release_year, @cover_url, @genre,
        'Queued', 'Medium', @created_at, @updated_at
      )
    `,
    ).run({
      id,
      steam_app_id: input.steamAppId,
      title,
      platform: input.platform ?? 'PC',
      franchise: optionalText(input.franchise ?? null, 'franchise', 120),
      release_year: optionalNumber(input.releaseYear ?? null, 'releaseYear', 1950, 2100, { integer: true }),
      cover_url: optionalHttpUrl(input.coverUrl ?? null),
      genre: optionalText(input.genre ?? null, 'genre', 120),
      created_at: now,
      updated_at: now,
    });
  } catch (error) {
    // Rely on the UNIQUE constraint for concurrency safety.
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
      throw new DuplicateError('Game sudah ada di Personal Library.', getGameBySteamAppId(input.steamAppId));
    }
    throw error;
  }

  const created = getGameById(id);
  if (!created) throw new Error('Insert succeeded but the record could not be read back.');

  return created;
}

export function createManualGame(input: CreateManualGameInput): PersonalGame {
  const db = getDb();

  const title = requireTitle(input.title);

  const platformRaw = typeof input.platform === 'string' ? input.platform.trim() : '';
  if (!platformRaw) throw new ValidationError('platform', 'Platform wajib diisi.');
  if (platformRaw.length > 40) throw new ValidationError('platform', 'Platform terlalu panjang.');

  const status = input.status ?? 'Queued';
  if (!GAME_STATUSES.includes(status as GameStatus)) {
    throw new ValidationError('status', 'Status tidak dikenal.');
  }

  const priority = input.priority ?? 'Medium';
  if (!PRIORITIES.includes(priority as Priority)) {
    throw new ValidationError('priority', 'Prioritas tidak dikenal.');
  }

  const id = randomUUID();
  const now = nowIso();

  db.prepare(
    `
    INSERT INTO personal_games (
      id, source, steam_app_id, legacy_game_id,
      title, platform, franchise, release_year, cover_url, genre,
      status, priority, notes, created_at, updated_at
    ) VALUES (
      @id, 'manual', NULL, NULL,
      @title, @platform, @franchise, @release_year, @cover_url, @genre,
      @status, @priority, @notes, @created_at, @updated_at
    )
  `,
  ).run({
    id,
    title,
    platform: platformRaw,
    franchise: optionalText(input.franchise, 'franchise', 120),
    release_year: optionalNumber(input.releaseYear, 'releaseYear', 1950, 2100, { integer: true }),
    cover_url: optionalHttpUrl(input.coverUrl),
    genre: optionalText(input.genre, 'genre', 120),
    status,
    priority,
    notes: optionalText(input.notes, 'notes'),
    created_at: now,
    updated_at: now,
  });

  const created = getGameById(id);
  if (!created) throw new Error('Insert succeeded but the record could not be read back.');

  return created;
}

export interface UpdateGameInput {
  status?: unknown;
  platform?: unknown;
  priority?: unknown;
  hoursPlayed?: unknown;
  progressPercent?: unknown;
  personalRating?: unknown;
  notes?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;

  // Manual-only editable identity fields.
  title?: unknown;
  franchise?: unknown;
  releaseYear?: unknown;
  genre?: unknown;
  coverUrl?: unknown;
}

const UPDATABLE_KEYS = new Set([
  'status',
  'platform',
  'priority',
  'hoursPlayed',
  'progressPercent',
  'personalRating',
  'notes',
  'startedAt',
  'completedAt',
  'title',
  'franchise',
  'releaseYear',
  'genre',
  'coverUrl',
]);

export function updateGame(id: string, input: UpdateGameInput): PersonalGame {
  const db = getDb();
  const existing = getGameById(id);
  if (!existing) throw new NotFoundError('Game tidak ditemukan.');

  const fields: string[] = [];
  const params: Record<string, unknown> = { id, updated_at: nextUpdatedAt(existing.updatedAt) };

  // Routes forward a fixed shape, so an absent field arrives as `undefined`.
  // Only keys the caller actually sent may be written — otherwise a partial
  // update would clear unrelated columns.
  const provided: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) provided[key] = value;
  }

  const has = (key: string) => Object.prototype.hasOwnProperty.call(provided, key);
  const read = (key: string) => provided[key];

  const unknownKey = Object.keys(provided).find((key) => !UPDATABLE_KEYS.has(key));
  if (unknownKey) throw new ValidationError(unknownKey, `Field "${unknownKey}" tidak dapat diubah.`);

  if (has('status')) {
    if (!GAME_STATUSES.includes(read('status') as GameStatus)) {
      throw new ValidationError('status', 'Status tidak dikenal.');
    }
    fields.push('status = @status');
    params.status = read('status');
  }

  if (has('platform')) {
    const rawPlatform = read('platform');
    const platform = typeof rawPlatform === 'string' ? rawPlatform.trim() : '';
    if (!platform) throw new ValidationError('platform', 'Platform wajib diisi.');
    if (platform.length > 40) throw new ValidationError('platform', 'Platform terlalu panjang.');
    fields.push('platform = @platform');
    params.platform = platform;
  }

  if (has('priority')) {
    if (!PRIORITIES.includes(read('priority') as Priority)) {
      throw new ValidationError('priority', 'Prioritas tidak dikenal.');
    }
    fields.push('priority = @priority');
    params.priority = read('priority');
  }

  if (has('hoursPlayed')) {
    fields.push('hours_played = @hours_played');
    params.hours_played = optionalNumber(read('hoursPlayed'), 'hoursPlayed', 0, 100000);
  }

  if (has('progressPercent')) {
    fields.push('progress_percent = @progress_percent');
    params.progress_percent = optionalNumber(read('progressPercent'), 'progressPercent', 0, 100, {
      integer: true,
    });
  }

  if (has('personalRating')) {
    fields.push('personal_rating = @personal_rating');
    params.personal_rating = optionalNumber(read('personalRating'), 'personalRating', 1, 10, {
      integer: true,
    });
  }

  if (has('notes')) {
    fields.push('notes = @notes');
    params.notes = optionalText(read('notes'), 'notes');
  }

  if (has('startedAt')) {
    fields.push('started_at = @started_at');
    params.started_at = optionalDate(read('startedAt'), 'startedAt');
  }

  if (has('completedAt')) {
    fields.push('completed_at = @completed_at');
    params.completed_at = optionalDate(read('completedAt'), 'completedAt');
  }

  // Identity fields are only editable for manual entries: a Steam record's
  // title/cover belong to the catalog identity and must not drift from it.
  const identityKeys = ['title', 'franchise', 'releaseYear', 'genre', 'coverUrl'];
  const touchesIdentity = identityKeys.some((key) => has(key));

  if (touchesIdentity) {
    if (existing.source === 'steam') {
      throw new ValidationError(
        'title',
        'Game dari Steam mengikuti data katalog. Hanya field personal yang dapat diubah.',
      );
    }

    if (has('title')) {
      fields.push('title = @title');
      params.title = requireTitle(read('title'));
    }

    if (has('franchise')) {
      fields.push('franchise = @franchise');
      params.franchise = optionalText(read('franchise'), 'franchise', 120);
    }

    if (has('releaseYear')) {
      fields.push('release_year = @release_year');
      params.release_year = optionalNumber(read('releaseYear'), 'releaseYear', 1950, 2100, {
        integer: true,
      });
    }

    if (has('genre')) {
      fields.push('genre = @genre');
      params.genre = optionalText(read('genre'), 'genre', 120);
    }

    if (has('coverUrl')) {
      fields.push('cover_url = @cover_url');
      params.cover_url = optionalHttpUrl(read('coverUrl'));
    }
  }

  if (fields.length === 0) return existing;

  // `updated_at` is passed as a parameter, so it must also be part of the
  // SET clause — otherwise the timestamp would silently never be written.
  fields.push('updated_at = @updated_at');

  db.prepare(`UPDATE personal_games SET ${fields.join(', ')} WHERE id = @id`).run(params);

  const updated = getGameById(id);
  if (!updated) throw new NotFoundError('Game tidak ditemukan setelah pembaruan.');

  return updated;
}

/**
 * Removes a personal game.
 *
 * Safe policy: a game that still has field logs is NOT deleted. The caller gets
 * a ConflictError listing the logs, and must either delete them explicitly or
 * keep the game. This guarantees journal content is never lost implicitly.
 */
export function removeGame(id: string): { removed: PersonalGame } {
  return transaction((db: DB) => {
    const game = getGameById(id);
    if (!game) throw new NotFoundError('Game tidak ditemukan.');

    const logs = db
      .prepare('SELECT id, title, publication_status AS publicationStatus FROM personal_field_logs WHERE personal_game_id = ?')
      .all(id) as Array<{ id: string; title: string; publicationStatus: string }>;

    if (logs.length > 0) {
      throw new ConflictError(
        `Game ini masih memiliki ${logs.length} Field Log. Hapus Field Log terlebih dahulu, atau pilih arsipkan.`,
        { logs },
      );
    }

    db.prepare('DELETE FROM personal_games WHERE id = ?').run(id);

    return { removed: game };
  });
}

/** Marks a game as logged without deleting it (alternative to removal). */
export function archiveGame(id: string): PersonalGame {
  return updateGame(id, { status: 'Logged' });
}

/** Duplicate-title warning for manual entry. Never merges automatically. */
export function findSimilarGames(title: string): PersonalGame[] {
  const normalised = normaliseTitle(title);
  if (!normalised) return [];

  const all = listGames({ order: 'title' });

  return all.filter((game) => {
    const other = normaliseTitle(game.title);
    if (!other) return false;
    if (other === normalised) return true;
    // Substring match in either direction, for "Silent Hill" vs "Silent Hill 2".
    return other.includes(normalised) || normalised.includes(other);
  });
}

export function countGames(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS c FROM personal_games').get() as { c: number };
  return row.c;
}

/** Re-sync legacy rows from backlog.ts without touching personal edits. */
export function reseedLegacy(options: { force?: boolean } = {}) {
  return seedLegacyBacklog(options);
}

export const ALL_STATUSES = GAME_STATUSES;
export const ALL_PRIORITIES = PRIORITIES;
export const ALL_PLATFORMS = PLATFORMS;
