/**
 * Field log repository — database-backed session logs.
 *
 * These are separate from the Markdown Content Collection entries under
 * `src/content/journal/`. Markdown files are never read, written, or deleted
 * here; the two sources are merged at display time only.
 */

import { randomUUID } from 'node:crypto';

import {
  PUBLICATION_STATUSES,
  type FieldLogWithGame,
  type PersonalFieldLog,
  type PublicationStatus,
} from '../../data/library/types';
import { getDb, nextUpdatedAt, nowIso, type DB } from './db';
import { ConflictError, NotFoundError, ValidationError, getGameById } from './library-repository';

interface LogRow {
  id: string;
  personal_game_id: string;
  title: string;
  session_date: string | null;
  duration_minutes: number | null;
  player_condition: string | null;
  mood: string | null;
  content_markdown: string;
  publication_status: PublicationStatus;
  created_at: string;
  updated_at: string;
  published_at: string | null;
}

interface JoinedLogRow extends LogRow {
  game_title: string;
}

const SELECT_COLUMNS = `
  id, personal_game_id, title, session_date, duration_minutes,
  player_condition, mood, content_markdown, publication_status,
  created_at, updated_at, published_at
`;

function mapLog(row: LogRow): PersonalFieldLog {
  return {
    id: row.id,
    personalGameId: row.personal_game_id,
    title: row.title,
    sessionDate: row.session_date,
    durationMinutes: row.duration_minutes,
    playerCondition: row.player_condition,
    mood: row.mood,
    contentMarkdown: row.content_markdown,
    publicationStatus: row.publication_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
  };
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

const MAX_TITLE = 200;
const MAX_MARKDOWN = 200_000;
const MAX_SHORT = 200;

function requireTitle(value: unknown): string {
  const title = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!title) throw new ValidationError('title', 'Judul catatan wajib diisi.');
  if (title.length > MAX_TITLE) {
    throw new ValidationError('title', `Judul maksimal ${MAX_TITLE} karakter.`);
  }
  return title;
}

function optionalShort(value: unknown, field: string, max = MAX_SHORT): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new ValidationError(field, `${field} harus berupa teks.`);

  const text = value.trim();
  if (!text) return null;
  if (text.length > max) throw new ValidationError(field, `${field} maksimal ${max} karakter.`);

  return text;
}

function optionalMarkdown(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new ValidationError('contentMarkdown', 'Isi catatan harus berupa teks.');
  if (value.length > MAX_MARKDOWN) {
    throw new ValidationError('contentMarkdown', 'Isi catatan terlalu panjang.');
  }
  return value;
}

function optionalDate(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new ValidationError(field, 'Tanggal tidak valid.');

  const raw = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new ValidationError(field, 'Format tanggal harus YYYY-MM-DD.');
  }
  if (Number.isNaN(new Date(`${raw}T00:00:00Z`).getTime())) {
    throw new ValidationError(field, 'Tanggal tidak valid.');
  }

  return raw;
}

function optionalDuration(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);

  if (!Number.isFinite(parsed)) {
    throw new ValidationError('durationMinutes', 'Durasi harus berupa angka.');
  }
  if (!Number.isInteger(parsed)) {
    throw new ValidationError('durationMinutes', 'Durasi harus bilangan bulat (menit).');
  }
  if (parsed < 0 || parsed > 24 * 60 * 14) {
    throw new ValidationError('durationMinutes', 'Durasi tidak masuk akal.');
  }

  return parsed;
}

/* ------------------------------------------------------------------ */
/* Read                                                               */
/* ------------------------------------------------------------------ */

export function listLogsForGame(personalGameId: string): PersonalFieldLog[] {
  const rows = getDb()
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM personal_field_logs
       WHERE personal_game_id = ?
       ORDER BY COALESCE(session_date, created_at) DESC, rowid DESC`,
    )
    .all(personalGameId) as LogRow[];

  return rows.map(mapLog);
}

export function getLogById(id: string): PersonalFieldLog | null {
  const row = getDb()
    .prepare(`SELECT ${SELECT_COLUMNS} FROM personal_field_logs WHERE id = ?`)
    .get(id) as LogRow | undefined;

  return row ? mapLog(row) : null;
}

export function getLogWithGame(id: string): FieldLogWithGame | null {
  const row = getDb()
    .prepare(
      `SELECT l.id, l.personal_game_id, l.title, l.session_date, l.duration_minutes,
              l.player_condition, l.mood, l.content_markdown, l.publication_status,
              l.created_at, l.updated_at, l.published_at,
              g.title AS game_title
       FROM personal_field_logs l
       JOIN personal_games g ON g.id = l.personal_game_id
       WHERE l.id = ?`,
    )
    .get(id) as JoinedLogRow | undefined;

  if (!row) return null;
  return { ...mapLog(row), gameTitle: row.game_title };
}

export function listAllLogs(options: { publicationStatus?: PublicationStatus } = {}): FieldLogWithGame[] {
  const db = getDb();
  const params: Record<string, unknown> = {};
  let clause = '';

  if (options.publicationStatus) {
    clause = 'WHERE l.publication_status = @status';
    params.status = options.publicationStatus;
  }

  const rows = db
    .prepare(
      `SELECT l.id, l.personal_game_id, l.title, l.session_date, l.duration_minutes,
              l.player_condition, l.mood, l.content_markdown, l.publication_status,
              l.created_at, l.updated_at, l.published_at,
              g.title AS game_title
       FROM personal_field_logs l
       JOIN personal_games g ON g.id = l.personal_game_id
       ${clause}
       ORDER BY COALESCE(l.session_date, l.created_at) DESC, l.rowid DESC`,
    )
    .all(params) as JoinedLogRow[];

  return rows.map((row) => ({ ...mapLog(row), gameTitle: row.game_title }));
}

export function listLogsByGameWithCounts(personalGameId: string) {
  const logs = listLogsForGame(personalGameId);
  return {
    total: logs.length,
    drafts: logs.filter((log) => log.publicationStatus === 'draft').length,
    published: logs.filter((log) => log.publicationStatus === 'published').length,
    logs,
  };
}

/* ------------------------------------------------------------------ */
/* Write                                                              */
/* ------------------------------------------------------------------ */

export interface CreateLogInput {
  personalGameId: string;
  title: unknown;
  sessionDate?: unknown;
  durationMinutes?: unknown;
  playerCondition?: unknown;
  mood?: unknown;
  contentMarkdown?: unknown;
  publicationStatus?: unknown;
}

export function createLog(input: CreateLogInput): PersonalFieldLog {
  const db = getDb();

  const game = getGameById(input.personalGameId);
  if (!game) throw new NotFoundError('Game tujuan tidak ditemukan.');

  const title = requireTitle(input.title);
  const status: PublicationStatus = PUBLICATION_STATUSES.includes(input.publicationStatus as PublicationStatus)
    ? (input.publicationStatus as PublicationStatus)
    : 'draft';

  const id = randomUUID();
  const now = nowIso();

  db.prepare(
    `
    INSERT INTO personal_field_logs (
      id, personal_game_id, title, session_date, duration_minutes,
      player_condition, mood, content_markdown, publication_status,
      created_at, updated_at, published_at
    ) VALUES (
      @id, @personal_game_id, @title, @session_date, @duration_minutes,
      @player_condition, @mood, @content_markdown, @publication_status,
      @created_at, @updated_at, @published_at
    )
  `,
  ).run({
    id,
    personal_game_id: input.personalGameId,
    title,
    session_date: optionalDate(input.sessionDate, 'sessionDate'),
    duration_minutes: optionalDuration(input.durationMinutes),
    player_condition: optionalShort(input.playerCondition, 'playerCondition'),
    mood: optionalShort(input.mood, 'mood'),
    content_markdown: optionalMarkdown(input.contentMarkdown),
    publication_status: status,
    created_at: now,
    updated_at: now,
    published_at: status === 'published' ? now : null,
  });

  const created = getLogById(id);
  if (!created) throw new Error('Insert succeeded but the log could not be read back.');

  return created;
}

export interface UpdateLogInput {
  title?: unknown;
  sessionDate?: unknown;
  durationMinutes?: unknown;
  playerCondition?: unknown;
  mood?: unknown;
  contentMarkdown?: unknown;
  publicationStatus?: unknown;
}

const UPDATABLE = new Set([
  'title',
  'sessionDate',
  'durationMinutes',
  'playerCondition',
  'mood',
  'contentMarkdown',
  'publicationStatus',
]);

export function updateLog(id: string, input: UpdateLogInput): PersonalFieldLog {
  const existing = getLogById(id);
  if (!existing) throw new NotFoundError('Field Log tidak ditemukan.');

  // Drop keys the caller did not actually send. Routes forward a fixed shape, so
  // an absent field arrives as `undefined`; treating that as "set to empty"
  // would wipe data on a partial update.
  const provided: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) provided[key] = value;
  }

  const unknownKey = Object.keys(provided).find((key) => !UPDATABLE.has(key));
  if (unknownKey) throw new ValidationError(unknownKey, `Field "${unknownKey}" tidak dapat diubah.`);

  const fields: string[] = [];
  const params: Record<string, unknown> = { id, updated_at: nextUpdatedAt(existing.updatedAt) };

  const has = (key: string) => Object.prototype.hasOwnProperty.call(provided, key);
  const value = (key: string) => provided[key];

  if (has('title')) {
    fields.push('title = @title');
    params.title = requireTitle(value('title'));
  }

  if (has('sessionDate')) {
    fields.push('session_date = @session_date');
    params.session_date = optionalDate(value('sessionDate'), 'sessionDate');
  }

  if (has('durationMinutes')) {
    fields.push('duration_minutes = @duration_minutes');
    params.duration_minutes = optionalDuration(value('durationMinutes'));
  }

  if (has('playerCondition')) {
    fields.push('player_condition = @player_condition');
    params.player_condition = optionalShort(value('playerCondition'), 'playerCondition');
  }

  if (has('mood')) {
    fields.push('mood = @mood');
    params.mood = optionalShort(value('mood'), 'mood');
  }

  if (has('contentMarkdown')) {
    fields.push('content_markdown = @content_markdown');
    params.content_markdown = optionalMarkdown(value('contentMarkdown'));
  }

  if (has('publicationStatus')) {
    if (!PUBLICATION_STATUSES.includes(value('publicationStatus') as PublicationStatus)) {
      throw new ValidationError('publicationStatus', 'Status publikasi tidak dikenal.');
    }

    const next = value('publicationStatus') as PublicationStatus;
    fields.push('publication_status = @publication_status');
    params.publication_status = next;

    // Stamp published_at the first time it is published; clearing it on revert.
    if (next === 'published' && !existing.publishedAt) {
      fields.push('published_at = @published_at');
      params.published_at = nowIso();
    } else if (next === 'draft') {
      fields.push('published_at = NULL');
    }
  }

  if (fields.length === 0) return existing;

  // See library-repository: the parameter must be referenced by the SET clause.
  fields.push('updated_at = @updated_at');

  getDb().prepare(`UPDATE personal_field_logs SET ${fields.join(', ')} WHERE id = @id`).run(params);

  const updated = getLogById(id);
  if (!updated) throw new NotFoundError('Field Log tidak ditemukan setelah pembaruan.');

  return updated;
}

export function publishLog(id: string): PersonalFieldLog {
  return updateLog(id, { publicationStatus: 'published' });
}

export function unpublishLog(id: string): PersonalFieldLog {
  return updateLog(id, { publicationStatus: 'draft' });
}

/**
 * Deletes a log. This is reversible only via a database backup — the caller
 * must have obtained explicit confirmation first.
 */
export function deleteLog(id: string): { removed: PersonalFieldLog } {
  const existing = getLogById(id);
  if (!existing) throw new NotFoundError('Field Log tidak ditemukan.');

  getDb().prepare('DELETE FROM personal_field_logs WHERE id = ?').run(id);

  return { removed: existing };
}

/** Deletes every log for a game. Used by the explicit "remove with logs" path. */
export function deleteLogsForGame(personalGameId: string, db: DB = getDb()): number {
  const result = db.prepare('DELETE FROM personal_field_logs WHERE personal_game_id = ?').run(personalGameId);
  return result.changes;
}

export function countLogsForGame(personalGameId: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS c FROM personal_field_logs WHERE personal_game_id = ?')
    .get(personalGameId) as { c: number };
  return row.c;
}

export { ConflictError };
