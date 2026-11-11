import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
// \0rolldown/runtime.js
var __defProp = Object.defineProperty;
var __exportAll = (all, no_symbols) => {
	let target = {};
	for (var name in all) __defProp(target, name, {
		get: all[name],
		enumerable: true
	});
	if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });
	return target;
};
// src/lib/server/db.ts
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
var db_exports = /* @__PURE__ */ __exportAll({
	DATABASE_PATH: () => DATABASE_PATH,
	closeDb: () => closeDb,
	getDb: () => getDb,
	nextUpdatedAt: () => nextUpdatedAt,
	nowIso: () => nowIso,
	transaction: () => transaction
});
var DATABASE_DIR = process.env.PERSONAL_DATA_DIR ?? path.join(process.cwd(), ".data", "personal");
var DATABASE_PATH = path.join(DATABASE_DIR, "journal.sqlite");
var globalRef = globalThis;
function openDatabase() {
	mkdirSync(DATABASE_DIR, { recursive: true });
	const database = new Database(DATABASE_PATH);
	try {
		database.pragma("journal_mode = WAL");
	} catch {}
	database.pragma("foreign_keys = ON");
	database.pragma("busy_timeout = 5000");
	return database;
}
/**
* Shared connection. Created lazily on first use so importing this module has
* no side effects during `astro build` page collection.
*/
function getDb() {
	globalRef.__journalDb ??= openDatabase();
	return globalRef.__journalDb;
}
/** Test/CLI hook: close the handle so the file can be moved or reopened. */
function closeDb() {
	globalRef.__journalDb?.close();
	globalRef.__journalDb = void 0;
}
/** Run `fn` inside a transaction, rolling back on any thrown error. */
function transaction(fn) {
	const db = getDb();
	return db.transaction(fn)(db);
}
function nowIso() {
	return (/* @__PURE__ */ new Date()).toISOString();
}
/**
* Timestamp for an UPDATE. If the new value would equal `previous` (two writes
* inside the same millisecond), advance by 1 ms so callers can reliably detect
* that a record changed — `updated_at` must never look unchanged after a write.
*/
function nextUpdatedAt(previous) {
	const now = Date.now();
	const prior = previous ? Date.parse(previous) : NaN;
	if (Number.isFinite(prior) && now <= prior) return new Date(prior + 1).toISOString();
	return new Date(now).toISOString();
}
// src/lib/server/migrations.ts
/**
* Versioned, idempotent schema migrations.
*
* Rules followed here:
* - Never drop or rewrite existing rows. Every migration is additive.
* - Each migration runs inside a transaction and is recorded in
*   `schema_migrations`, so re-running is a no-op.
* - `user_version` is kept in sync for tooling that prefers PRAGMA.
*/
var migrations_exports = /* @__PURE__ */ __exportAll({
	isInitialised: () => isInitialised,
	migrate: () => migrate
});
var MIGRATIONS = [{
	version: 1,
	name: "core_personal_games_and_field_logs",
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
	}
}];
function ensureMigrationsTable(db) {
	db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}
function migrate() {
	const db = getDb();
	ensureMigrationsTable(db);
	const appliedVersions = new Set(db.prepare("SELECT version FROM schema_migrations").all().map((row) => row.version));
	const result = {
		applied: [],
		skipped: [],
		currentVersion: 0
	};
	for (const migration of MIGRATIONS) {
		if (appliedVersions.has(migration.version)) {
			result.skipped.push(migration.version);
			continue;
		}
		transaction((tx) => {
			migration.up(tx);
			tx.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(migration.version, migration.name, nowIso());
			tx.pragma(`user_version = ${migration.version}`);
		});
		result.applied.push(migration.version);
	}
	result.currentVersion = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v ?? 0;
	return result;
}
/** True when the schema has been created at least once. */
function isInitialised() {
	return !!getDb().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='personal_games'").get();
}
// src/data/backlog.ts
var backlogGames = [
	{
		id: "signalis",
		registry: 1,
		title: "SIGNALIS",
		platform: "PC",
		year: 2022,
		cover: "https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=500",
		franchise: "Indie Horror",
		status: "Next",
		priority: "High",
		genre: "Survival Horror",
		reason: "Retrofuturisme, isolasi, dan narasi psikologis yang berlapis."
	},
	{
		id: "whos-lila",
		registry: 2,
		title: "Who's Lila?",
		platform: "PC",
		year: 2022,
		cover: "https://images.unsplash.com/photo-1509198397868-475647b2a1e5?w=500",
		franchise: "Indie Horror",
		status: "Queued",
		priority: "High",
		genre: "Psychological Horror",
		reason: "Ekspresi wajah menjadi bagian dari mekanik interaksi."
	},
	{
		id: "silent-hill-2",
		registry: 3,
		title: "Silent Hill 2 (2001)",
		platform: "PS2",
		year: 2001,
		franchise: "Silent Hill",
		status: "Queued",
		priority: "High",
		genre: "Psychological Horror",
		reason: "Rasa bersalah, kehilangan, kabut, dan simbolisme."
	},
	{
		id: "crow-country",
		registry: 4,
		title: "Crow Country",
		platform: "PC",
		year: 2024,
		cover: "https://images.unsplash.com/photo-1534447677768-be436bb09401?w=500",
		franchise: "Indie Horror",
		status: "Someday",
		priority: "Medium",
		genre: "Survival Horror",
		reason: "Eksplorasi taman hiburan dengan estetika retro 3D."
	},
	{
		id: "mouthwashing",
		registry: 5,
		title: "Mouthwashing",
		platform: "PC",
		year: 2024,
		cover: "https://images.unsplash.com/photo-1519608487953-e999c86e7455?w=500",
		franchise: "Indie Horror",
		status: "Next",
		priority: "High",
		genre: "Psychological Horror",
		reason: "Narasi menekan dengan hubungan antarkarakter yang kompleks."
	},
	{
		id: "paratopic",
		registry: 6,
		title: "Paratopic",
		platform: "PC",
		year: 2018,
		cover: "https://images.unsplash.com/photo-1542751371-adc38448a05e?w=500",
		franchise: "Indie Horror",
		status: "On Hold",
		priority: "Low",
		genre: "Experimental Horror",
		reason: "Eksperimen horor low-poly dan cerita nonlinier."
	},
	{
		id: "mothered",
		registry: 7,
		title: "MOTHERED",
		platform: "PC",
		year: 2021,
		cover: "https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?w=500",
		franchise: "Indie Horror",
		status: "Logged",
		priority: "Low",
		genre: "Psychological Horror",
		reason: "Memiliki Field Log tentang manekin, rutinitas, dan paranoia."
	},
	{
		id: "silent-hill-1",
		registry: 8,
		title: "Silent Hill",
		platform: "PS1",
		year: 1999,
		franchise: "Silent Hill",
		status: "Queued",
		priority: "Medium",
		genre: "Psychological Horror",
		reason: "Kabut, keterbatasan visual, dan ketakutan terhadap sesuatu yang tidak terlihat."
	},
	{
		id: "silent-hill-3",
		registry: 9,
		title: "Silent Hill 3",
		platform: "PS2",
		year: 2003,
		franchise: "Silent Hill",
		status: "Queued",
		priority: "Medium",
		genre: "Psychological Horror",
		reason: "Identitas Heather Mason dan ruang yang kehilangan rasa aman."
	},
	{
		id: "silent-hill-4",
		registry: 10,
		title: "Silent Hill 4: The Room",
		platform: "PS2",
		year: 2004,
		franchise: "Silent Hill",
		status: "Someday",
		priority: "Medium",
		genre: "Psychological Horror",
		reason: "Apartemen sebagai tempat berlindung sekaligus sumber ancaman."
	},
	{
		id: "silent-hill-2-remake",
		registry: 11,
		title: "Silent Hill 2 Remake",
		platform: "PS5",
		year: 2024,
		franchise: "Silent Hill",
		status: "Queued",
		priority: "Medium",
		genre: "Psychological Horror",
		reason: "Perbandingan atmosfer, kamera, dan ritme dengan versi 2001."
	},
	{
		id: "resident-evil-1",
		registry: 12,
		title: "Resident Evil",
		platform: "PS1",
		year: 1996,
		franchise: "Resident Evil",
		status: "Queued",
		priority: "Medium",
		genre: "Survival Horror",
		reason: "Akar survival horror klasik dengan eksplorasi dan keterbatasan sumber daya."
	},
	{
		id: "resident-evil-2-remake",
		registry: 13,
		title: "Resident Evil 2 Remake",
		platform: "PS4",
		year: 2019,
		franchise: "Resident Evil",
		status: "Queued",
		priority: "High",
		genre: "Survival Horror",
		reason: "Ketegangan lewat ruang, rute, musuh, dan manajemen amunisi."
	},
	{
		id: "resident-evil-4",
		registry: 14,
		title: "Resident Evil 4 (2005)",
		platform: "PS2",
		year: 2005,
		franchise: "Resident Evil",
		status: "Someday",
		priority: "Medium",
		genre: "Action Horror",
		reason: "Perubahan desain survival horror menuju aksi yang lebih dominan."
	},
	{
		id: "resident-evil-7",
		registry: 15,
		title: "Resident Evil 7: Biohazard",
		platform: "PC",
		year: 2017,
		franchise: "Resident Evil",
		status: "Queued",
		priority: "High",
		genre: "Survival Horror",
		reason: "Perspektif orang pertama, rumah terpencil, dan rasa terisolasi."
	},
	{
		id: "resident-evil-village",
		registry: 16,
		title: "Resident Evil Village",
		platform: "PS5",
		year: 2021,
		franchise: "Resident Evil",
		status: "Someday",
		priority: "Medium",
		genre: "Survival / Action Horror",
		reason: "Eksplorasi variasi atmosfer, aksi, dan ancaman dalam satu permainan."
	}
];
backlogGames.filter((game) => game.status !== "Logged").slice(0, 4);
// src/lib/server/legacy-seed.ts
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
var legacy_seed_exports = /* @__PURE__ */ __exportAll({
	legacyCount: () => legacyCount,
	seedLegacyBacklog: () => seedLegacyBacklog
});
function toSeedRow(game, timestamp) {
	return {
		id: `legacy-${game.id}`,
		source: "legacy",
		steam_app_id: null,
		legacy_game_id: game.id,
		title: game.title,
		platform: game.platform,
		franchise: game.franchise,
		release_year: game.year,
		cover_url: game.cover ?? null,
		genre: game.genre,
		status: game.status === "Logged" ? "Logged" : game.status,
		priority: game.priority,
		notes: game.reason,
		registry: game.registry,
		created_at: timestamp,
		updated_at: timestamp
	};
}
var INSERT_SQL = `
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
function seedLegacyBacklog(options = {}) {
	const force = options.force ?? false;
	return transaction((db) => {
		const insert = db.prepare(INSERT_SQL);
		const exists = db.prepare("SELECT id FROM personal_games WHERE legacy_game_id = ?");
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
		const total = db.prepare("SELECT COUNT(*) AS c FROM personal_games").get().c;
		return {
			inserted,
			existing,
			total
		};
	});
}
/** Number of rows that came from the legacy backlog seed. */
function legacyCount() {
	return getDb().prepare("SELECT COUNT(*) AS c FROM personal_games WHERE source = 'legacy'").get().c;
}
// src/data/library/types.ts
/**
* Shared types for the personal library (SQLite-backed).
*
* These are the *personal* records. They are deliberately separate from
* `src/data/catalog/types.ts`, which describes the read-only Steam catalog.
*/
var GAME_STATUSES = [
	"Next",
	"Queued",
	"Playing",
	"On Hold",
	"Someday",
	"Cleared",
	"Abandoned",
	"Logged"
];
var PRIORITIES = [
	"High",
	"Medium",
	"Low"
];
var PLATFORMS = [
	"PC",
	"PS1",
	"PS2",
	"PS3",
	"PS4",
	"PS5",
	"Switch",
	"Other"
];
/** Which statuses count as "in the backlog" (i.e. not yet finished). */
var BACKLOG_STATUSES = [
	"Next",
	"Queued",
	"Playing",
	"On Hold",
	"Someday"
];
var PUBLICATION_STATUSES = ["draft", "published"];
// src/lib/server/library-repository.ts
/**
* Personal library repository.
*
* All SQL for personal games lives here. API routes and pages call these
* functions; no component contains hand-written SQL.
*/
var library_repository_exports = /* @__PURE__ */ __exportAll({
	ALL_PLATFORMS: () => ALL_PLATFORMS,
	ALL_PRIORITIES: () => ALL_PRIORITIES,
	ALL_STATUSES: () => ALL_STATUSES,
	ConflictError: () => ConflictError,
	DuplicateError: () => DuplicateError,
	NotFoundError: () => NotFoundError,
	ValidationError: () => ValidationError,
	addSteamGame: () => addSteamGame,
	archiveGame: () => archiveGame,
	countGames: () => countGames,
	createManualGame: () => createManualGame,
	findSimilarGames: () => findSimilarGames,
	getGameById: () => getGameById,
	getGameByLegacyId: () => getGameByLegacyId,
	getGameBySteamAppId: () => getGameBySteamAppId,
	getLibraryFacets: () => getLibraryFacets,
	getLibraryStats: () => getLibraryStats,
	listGames: () => listGames,
	normaliseTitle: () => normaliseTitle,
	removeGame: () => removeGame,
	reseedLegacy: () => reseedLegacy,
	updateGame: () => updateGame
});
var SELECT_COLUMNS$1 = `
  id, source, steam_app_id, legacy_game_id,
  title, platform, franchise, release_year, cover_url, genre,
  status, priority, hours_played, progress_percent, personal_rating,
  notes, started_at, completed_at, registry, created_at, updated_at
`;
function mapGame(row) {
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
		updatedAt: row.updated_at
	};
}
var ValidationError = class extends Error {
	field;
	constructor(field, message) {
		super(message);
		this.name = "ValidationError";
		this.field = field;
	}
};
var DuplicateError = class extends Error {
	existing;
	constructor(message, existing = null) {
		super(message);
		this.name = "DuplicateError";
		this.existing = existing;
	}
};
var NotFoundError = class extends Error {
	constructor(message = "Record not found.") {
		super(message);
		this.name = "NotFoundError";
	}
};
var ConflictError = class extends Error {
	details;
	constructor(message, details = {}) {
		super(message);
		this.name = "ConflictError";
		this.details = details;
	}
};
var MAX_TITLE$1 = 200;
var MAX_TEXT = 4e3;
var MAX_URL = 2e3;
function requireTitle$1(value) {
	const title = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
	if (!title) throw new ValidationError("title", "Judul game wajib diisi.");
	if (title.length > MAX_TITLE$1) throw new ValidationError("title", `Judul maksimal ${MAX_TITLE$1} karakter.`);
	return title;
}
function optionalText(value, field, max = MAX_TEXT) {
	if (value === null || value === void 0) return null;
	if (typeof value !== "string") throw new ValidationError(field, `${field} harus berupa teks.`);
	const text = value.trim();
	if (!text) return null;
	if (text.length > max) throw new ValidationError(field, `${field} maksimal ${max} karakter.`);
	return text;
}
function optionalHttpUrl(value, field = "coverUrl") {
	if (value === null || value === void 0) return null;
	if (typeof value !== "string") throw new ValidationError(field, `${field} harus berupa URL.`);
	const raw = value.trim();
	if (!raw) return null;
	if (raw.length > MAX_URL) throw new ValidationError(field, `URL terlalu panjang.`);
	let parsed;
	try {
		parsed = new URL(raw);
	} catch {
		throw new ValidationError(field, "URL tidak valid.");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new ValidationError(field, "URL harus http atau https.");
	return parsed.href;
}
function optionalNumber(value, field, min, max, { integer = false } = {}) {
	if (value === null || value === void 0 || value === "") return null;
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(parsed)) throw new ValidationError(field, `${field} harus berupa angka.`);
	if (integer && !Number.isInteger(parsed)) throw new ValidationError(field, `${field} harus bilangan bulat.`);
	if (parsed < min || parsed > max) throw new ValidationError(field, `${field} harus antara ${min} dan ${max}.`);
	return parsed;
}
function optionalDate$1(value, field) {
	if (value === null || value === void 0 || value === "") return null;
	if (typeof value !== "string") throw new ValidationError(field, `${field} tidak valid.`);
	const raw = value.trim();
	if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new ValidationError(field, "Format tanggal harus YYYY-MM-DD.");
	const parsed = /* @__PURE__ */ new Date(`${raw}T00:00:00Z`);
	if (Number.isNaN(parsed.getTime())) throw new ValidationError(field, "Tanggal tidak valid.");
	return raw;
}
function normaliseTitle(title) {
	return title.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
var ORDER_SQL = {
	recent: "created_at DESC, rowid DESC",
	title: "title COLLATE NOCASE ASC",
	progress: "COALESCE(progress_percent, -1) DESC, COALESCE(hours_played, -1) DESC, title COLLATE NOCASE ASC"
};
function listGames(options = {}) {
	const db = getDb();
	const where = [];
	const params = {};
	if (options.search) {
		where.push(`LOWER(title) LIKE @search ESCAPE '\\'`);
		params.search = `%${options.search.toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
	}
	if (options.platform) {
		where.push("platform = @platform");
		params.platform = options.platform;
	}
	if (options.status) {
		where.push("status = @status");
		params.status = options.status;
	}
	if (options.priority) {
		where.push("priority = @priority");
		params.priority = options.priority;
	}
	const order = ORDER_SQL[options.order ?? "recent"] ?? ORDER_SQL.recent;
	const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
	return db.prepare(`SELECT ${SELECT_COLUMNS$1} FROM personal_games ${clause} ORDER BY ${order}`).all(params).map(mapGame);
}
function getGameById(id) {
	const row = getDb().prepare(`SELECT ${SELECT_COLUMNS$1} FROM personal_games WHERE id = ?`).get(id);
	return row ? mapGame(row) : null;
}
function getGameBySteamAppId(steamAppId) {
	const row = getDb().prepare(`SELECT ${SELECT_COLUMNS$1} FROM personal_games WHERE steam_app_id = ?`).get(steamAppId);
	return row ? mapGame(row) : null;
}
function getGameByLegacyId(legacyGameId) {
	const row = getDb().prepare(`SELECT ${SELECT_COLUMNS$1} FROM personal_games WHERE legacy_game_id = ?`).get(legacyGameId);
	return row ? mapGame(row) : null;
}
function getLibraryStats() {
	const db = getDb();
	const games = db.prepare("SELECT status, COUNT(*) AS c FROM personal_games GROUP BY status").all();
	const byStatus = new Map(games.map((row) => [row.status, row.c]));
	const total = games.reduce((sum, row) => sum + row.c, 0);
	const logs = db.prepare("SELECT publication_status AS s, COUNT(*) AS c FROM personal_field_logs GROUP BY publication_status").all();
	const logCounts = new Map(logs.map((row) => [row.s, row.c]));
	return {
		total,
		playing: byStatus.get("Playing") ?? 0,
		cleared: byStatus.get("Cleared") ?? 0,
		logged: byStatus.get("Logged") ?? 0,
		backlog: BACKLOG_STATUSES.reduce((sum, status) => sum + (byStatus.get(status) ?? 0), 0),
		fieldLogs: (logCounts.get("published") ?? 0) + (logCounts.get("draft") ?? 0),
		drafts: logCounts.get("draft") ?? 0
	};
}
/** Facets present in the library, for filter controls. */
function getLibraryFacets() {
	return { platforms: getDb().prepare("SELECT DISTINCT platform FROM personal_games ORDER BY platform").all().map((row) => row.platform) };
}
function addSteamGame(input) {
	const db = getDb();
	if (!Number.isSafeInteger(input.steamAppId) || input.steamAppId <= 0) throw new ValidationError("steamAppId", "Steam AppID tidak valid.");
	const title = requireTitle$1(input.title);
	const existing = getGameBySteamAppId(input.steamAppId);
	if (existing) throw new DuplicateError("Game sudah ada di Personal Library.", existing);
	const id = randomUUID();
	const now = nowIso();
	try {
		db.prepare(`
      INSERT INTO personal_games (
        id, source, steam_app_id, legacy_game_id,
        title, platform, franchise, release_year, cover_url, genre,
        status, priority, created_at, updated_at
      ) VALUES (
        @id, 'steam', @steam_app_id, NULL,
        @title, @platform, @franchise, @release_year, @cover_url, @genre,
        'Queued', 'Medium', @created_at, @updated_at
      )
    `).run({
			id,
			steam_app_id: input.steamAppId,
			title,
			platform: input.platform ?? "PC",
			franchise: optionalText(input.franchise ?? null, "franchise", 120),
			release_year: optionalNumber(input.releaseYear ?? null, "releaseYear", 1950, 2100, { integer: true }),
			cover_url: optionalHttpUrl(input.coverUrl ?? null),
			genre: optionalText(input.genre ?? null, "genre", 120),
			created_at: now,
			updated_at: now
		});
	} catch (error) {
		if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) throw new DuplicateError("Game sudah ada di Personal Library.", getGameBySteamAppId(input.steamAppId));
		throw error;
	}
	const created = getGameById(id);
	if (!created) throw new Error("Insert succeeded but the record could not be read back.");
	return created;
}
function createManualGame(input) {
	const db = getDb();
	const title = requireTitle$1(input.title);
	const platformRaw = typeof input.platform === "string" ? input.platform.trim() : "";
	if (!platformRaw) throw new ValidationError("platform", "Platform wajib diisi.");
	if (platformRaw.length > 40) throw new ValidationError("platform", "Platform terlalu panjang.");
	const status = input.status ?? "Queued";
	if (!GAME_STATUSES.includes(status)) throw new ValidationError("status", "Status tidak dikenal.");
	const priority = input.priority ?? "Medium";
	if (!PRIORITIES.includes(priority)) throw new ValidationError("priority", "Prioritas tidak dikenal.");
	const id = randomUUID();
	const now = nowIso();
	db.prepare(`
    INSERT INTO personal_games (
      id, source, steam_app_id, legacy_game_id,
      title, platform, franchise, release_year, cover_url, genre,
      status, priority, notes, created_at, updated_at
    ) VALUES (
      @id, 'manual', NULL, NULL,
      @title, @platform, @franchise, @release_year, @cover_url, @genre,
      @status, @priority, @notes, @created_at, @updated_at
    )
  `).run({
		id,
		title,
		platform: platformRaw,
		franchise: optionalText(input.franchise, "franchise", 120),
		release_year: optionalNumber(input.releaseYear, "releaseYear", 1950, 2100, { integer: true }),
		cover_url: optionalHttpUrl(input.coverUrl),
		genre: optionalText(input.genre, "genre", 120),
		status,
		priority,
		notes: optionalText(input.notes, "notes"),
		created_at: now,
		updated_at: now
	});
	const created = getGameById(id);
	if (!created) throw new Error("Insert succeeded but the record could not be read back.");
	return created;
}
var UPDATABLE_KEYS = /* @__PURE__ */ new Set([
	"status",
	"platform",
	"priority",
	"hoursPlayed",
	"progressPercent",
	"personalRating",
	"notes",
	"startedAt",
	"completedAt",
	"title",
	"franchise",
	"releaseYear",
	"genre",
	"coverUrl"
]);
function updateGame(id, input) {
	const db = getDb();
	const existing = getGameById(id);
	if (!existing) throw new NotFoundError("Game tidak ditemukan.");
	const fields = [];
	const params = {
		id,
		updated_at: nextUpdatedAt(existing.updatedAt)
	};
	const unknownKey = Object.keys(input).find((key) => !UPDATABLE_KEYS.has(key));
	if (unknownKey) throw new ValidationError(unknownKey, `Field "${unknownKey}" tidak dapat diubah.`);
	if ("status" in input) {
		if (!GAME_STATUSES.includes(input.status)) throw new ValidationError("status", "Status tidak dikenal.");
		fields.push("status = @status");
		params.status = input.status;
	}
	if ("platform" in input) {
		const platform = typeof input.platform === "string" ? input.platform.trim() : "";
		if (!platform) throw new ValidationError("platform", "Platform wajib diisi.");
		if (platform.length > 40) throw new ValidationError("platform", "Platform terlalu panjang.");
		fields.push("platform = @platform");
		params.platform = platform;
	}
	if ("priority" in input) {
		if (!PRIORITIES.includes(input.priority)) throw new ValidationError("priority", "Prioritas tidak dikenal.");
		fields.push("priority = @priority");
		params.priority = input.priority;
	}
	if ("hoursPlayed" in input) {
		fields.push("hours_played = @hours_played");
		params.hours_played = optionalNumber(input.hoursPlayed, "hoursPlayed", 0, 1e5);
	}
	if ("progressPercent" in input) {
		fields.push("progress_percent = @progress_percent");
		params.progress_percent = optionalNumber(input.progressPercent, "progressPercent", 0, 100, { integer: true });
	}
	if ("personalRating" in input) {
		fields.push("personal_rating = @personal_rating");
		params.personal_rating = optionalNumber(input.personalRating, "personalRating", 1, 10, { integer: true });
	}
	if ("notes" in input) {
		fields.push("notes = @notes");
		params.notes = optionalText(input.notes, "notes");
	}
	if ("startedAt" in input) {
		fields.push("started_at = @started_at");
		params.started_at = optionalDate$1(input.startedAt, "startedAt");
	}
	if ("completedAt" in input) {
		fields.push("completed_at = @completed_at");
		params.completed_at = optionalDate$1(input.completedAt, "completedAt");
	}
	if ([
		"title",
		"franchise",
		"releaseYear",
		"genre",
		"coverUrl"
	].some((key) => key in input)) {
		if (existing.source === "steam") throw new ValidationError("title", "Game dari Steam mengikuti data katalog. Hanya field personal yang dapat diubah.");
		if ("title" in input) {
			fields.push("title = @title");
			params.title = requireTitle$1(input.title);
		}
		if ("franchise" in input) {
			fields.push("franchise = @franchise");
			params.franchise = optionalText(input.franchise, "franchise", 120);
		}
		if ("releaseYear" in input) {
			fields.push("release_year = @release_year");
			params.release_year = optionalNumber(input.releaseYear, "releaseYear", 1950, 2100, { integer: true });
		}
		if ("genre" in input) {
			fields.push("genre = @genre");
			params.genre = optionalText(input.genre, "genre", 120);
		}
		if ("coverUrl" in input) {
			fields.push("cover_url = @cover_url");
			params.cover_url = optionalHttpUrl(input.coverUrl);
		}
	}
	if (fields.length === 0) return existing;
	db.prepare(`UPDATE personal_games SET ${fields.join(", ")} WHERE id = @id`).run(params);
	const updated = getGameById(id);
	if (!updated) throw new NotFoundError("Game tidak ditemukan setelah pembaruan.");
	return updated;
}
/**
* Removes a personal game.
*
* Safe policy: a game that still has field logs is NOT deleted. The caller gets
* a ConflictError listing the logs, and must either delete them explicitly or
* keep the game. This guarantees journal content is never lost implicitly.
*/
function removeGame(id) {
	return transaction((db) => {
		const game = getGameById(id);
		if (!game) throw new NotFoundError("Game tidak ditemukan.");
		const logs = db.prepare("SELECT id, title, publication_status AS publicationStatus FROM personal_field_logs WHERE personal_game_id = ?").all(id);
		if (logs.length > 0) throw new ConflictError(`Game ini masih memiliki ${logs.length} Field Log. Hapus Field Log terlebih dahulu, atau pilih arsipkan.`, { logs });
		db.prepare("DELETE FROM personal_games WHERE id = ?").run(id);
		return { removed: game };
	});
}
/** Marks a game as logged without deleting it (alternative to removal). */
function archiveGame(id) {
	return updateGame(id, { status: "Logged" });
}
/** Duplicate-title warning for manual entry. Never merges automatically. */
function findSimilarGames(title) {
	const normalised = normaliseTitle(title);
	if (!normalised) return [];
	return listGames({ order: "title" }).filter((game) => {
		const other = normaliseTitle(game.title);
		if (!other) return false;
		if (other === normalised) return true;
		return other.includes(normalised) || normalised.includes(other);
	});
}
function countGames() {
	return getDb().prepare("SELECT COUNT(*) AS c FROM personal_games").get().c;
}
/** Re-sync legacy rows from backlog.ts without touching personal edits. */
function reseedLegacy(options = {}) {
	return seedLegacyBacklog(options);
}
var ALL_STATUSES = GAME_STATUSES;
var ALL_PRIORITIES = PRIORITIES;
var ALL_PLATFORMS = PLATFORMS;
// src/lib/server/field-log-repository.ts
/**
* Field log repository — database-backed session logs.
*
* These are separate from the Markdown Content Collection entries under
* `src/content/journal/`. Markdown files are never read, written, or deleted
* here; the two sources are merged at display time only.
*/
var field_log_repository_exports = /* @__PURE__ */ __exportAll({
	ConflictError: () => ConflictError,
	countLogsForGame: () => countLogsForGame,
	createLog: () => createLog,
	deleteLog: () => deleteLog,
	deleteLogsForGame: () => deleteLogsForGame,
	getLogById: () => getLogById,
	getLogWithGame: () => getLogWithGame,
	listAllLogs: () => listAllLogs,
	listLogsByGameWithCounts: () => listLogsByGameWithCounts,
	listLogsForGame: () => listLogsForGame,
	publishLog: () => publishLog,
	unpublishLog: () => unpublishLog,
	updateLog: () => updateLog
});
var SELECT_COLUMNS = `
  id, personal_game_id, title, session_date, duration_minutes,
  player_condition, mood, content_markdown, publication_status,
  created_at, updated_at, published_at
`;
function mapLog(row) {
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
		publishedAt: row.published_at
	};
}
var MAX_TITLE = 200;
var MAX_MARKDOWN = 2e5;
var MAX_SHORT = 200;
function requireTitle(value) {
	const title = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
	if (!title) throw new ValidationError("title", "Judul catatan wajib diisi.");
	if (title.length > MAX_TITLE) throw new ValidationError("title", `Judul maksimal ${MAX_TITLE} karakter.`);
	return title;
}
function optionalShort(value, field, max = MAX_SHORT) {
	if (value === null || value === void 0) return null;
	if (typeof value !== "string") throw new ValidationError(field, `${field} harus berupa teks.`);
	const text = value.trim();
	if (!text) return null;
	if (text.length > max) throw new ValidationError(field, `${field} maksimal ${max} karakter.`);
	return text;
}
function optionalMarkdown(value) {
	if (value === null || value === void 0) return "";
	if (typeof value !== "string") throw new ValidationError("contentMarkdown", "Isi catatan harus berupa teks.");
	if (value.length > MAX_MARKDOWN) throw new ValidationError("contentMarkdown", "Isi catatan terlalu panjang.");
	return value;
}
function optionalDate(value, field) {
	if (value === null || value === void 0 || value === "") return null;
	if (typeof value !== "string") throw new ValidationError(field, "Tanggal tidak valid.");
	const raw = value.trim();
	if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new ValidationError(field, "Format tanggal harus YYYY-MM-DD.");
	if (Number.isNaN((/* @__PURE__ */ new Date(`${raw}T00:00:00Z`)).getTime())) throw new ValidationError(field, "Tanggal tidak valid.");
	return raw;
}
function optionalDuration(value) {
	if (value === null || value === void 0 || value === "") return null;
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(parsed)) throw new ValidationError("durationMinutes", "Durasi harus berupa angka.");
	if (!Number.isInteger(parsed)) throw new ValidationError("durationMinutes", "Durasi harus bilangan bulat (menit).");
	if (parsed < 0 || parsed > 20160) throw new ValidationError("durationMinutes", "Durasi tidak masuk akal.");
	return parsed;
}
function listLogsForGame(personalGameId) {
	return getDb().prepare(`SELECT ${SELECT_COLUMNS} FROM personal_field_logs
       WHERE personal_game_id = ?
       ORDER BY COALESCE(session_date, created_at) DESC, rowid DESC`).all(personalGameId).map(mapLog);
}
function getLogById(id) {
	const row = getDb().prepare(`SELECT ${SELECT_COLUMNS} FROM personal_field_logs WHERE id = ?`).get(id);
	return row ? mapLog(row) : null;
}
function getLogWithGame(id) {
	const row = getDb().prepare(`SELECT l.id, l.personal_game_id, l.title, l.session_date, l.duration_minutes,
              l.player_condition, l.mood, l.content_markdown, l.publication_status,
              l.created_at, l.updated_at, l.published_at,
              g.title AS game_title
       FROM personal_field_logs l
       JOIN personal_games g ON g.id = l.personal_game_id
       WHERE l.id = ?`).get(id);
	if (!row) return null;
	return {
		...mapLog(row),
		gameTitle: row.game_title
	};
}
function listAllLogs(options = {}) {
	const db = getDb();
	const params = {};
	let clause = "";
	if (options.publicationStatus) {
		clause = "WHERE l.publication_status = @status";
		params.status = options.publicationStatus;
	}
	return db.prepare(`SELECT l.id, l.personal_game_id, l.title, l.session_date, l.duration_minutes,
              l.player_condition, l.mood, l.content_markdown, l.publication_status,
              l.created_at, l.updated_at, l.published_at,
              g.title AS game_title
       FROM personal_field_logs l
       JOIN personal_games g ON g.id = l.personal_game_id
       ${clause}
       ORDER BY COALESCE(l.session_date, l.created_at) DESC, l.rowid DESC`).all(params).map((row) => ({
		...mapLog(row),
		gameTitle: row.game_title
	}));
}
function listLogsByGameWithCounts(personalGameId) {
	const logs = listLogsForGame(personalGameId);
	return {
		total: logs.length,
		drafts: logs.filter((log) => log.publicationStatus === "draft").length,
		published: logs.filter((log) => log.publicationStatus === "published").length,
		logs
	};
}
function createLog(input) {
	const db = getDb();
	if (!getGameById(input.personalGameId)) throw new NotFoundError("Game tujuan tidak ditemukan.");
	const title = requireTitle(input.title);
	const status = PUBLICATION_STATUSES.includes(input.publicationStatus) ? input.publicationStatus : "draft";
	const id = randomUUID();
	const now = nowIso();
	db.prepare(`
    INSERT INTO personal_field_logs (
      id, personal_game_id, title, session_date, duration_minutes,
      player_condition, mood, content_markdown, publication_status,
      created_at, updated_at, published_at
    ) VALUES (
      @id, @personal_game_id, @title, @session_date, @duration_minutes,
      @player_condition, @mood, @content_markdown, @publication_status,
      @created_at, @updated_at, @published_at
    )
  `).run({
		id,
		personal_game_id: input.personalGameId,
		title,
		session_date: optionalDate(input.sessionDate, "sessionDate"),
		duration_minutes: optionalDuration(input.durationMinutes),
		player_condition: optionalShort(input.playerCondition, "playerCondition"),
		mood: optionalShort(input.mood, "mood"),
		content_markdown: optionalMarkdown(input.contentMarkdown),
		publication_status: status,
		created_at: now,
		updated_at: now,
		published_at: status === "published" ? now : null
	});
	const created = getLogById(id);
	if (!created) throw new Error("Insert succeeded but the log could not be read back.");
	return created;
}
var UPDATABLE = /* @__PURE__ */ new Set([
	"title",
	"sessionDate",
	"durationMinutes",
	"playerCondition",
	"mood",
	"contentMarkdown",
	"publicationStatus"
]);
function updateLog(id, input) {
	const existing = getLogById(id);
	if (!existing) throw new NotFoundError("Field Log tidak ditemukan.");
	const unknownKey = Object.keys(input).find((key) => !UPDATABLE.has(key));
	if (unknownKey) throw new ValidationError(unknownKey, `Field "${unknownKey}" tidak dapat diubah.`);
	const fields = [];
	const params = {
		id,
		updated_at: nextUpdatedAt(existing.updatedAt)
	};
	if ("title" in input) {
		fields.push("title = @title");
		params.title = requireTitle(input.title);
	}
	if ("sessionDate" in input) {
		fields.push("session_date = @session_date");
		params.session_date = optionalDate(input.sessionDate, "sessionDate");
	}
	if ("durationMinutes" in input) {
		fields.push("duration_minutes = @duration_minutes");
		params.duration_minutes = optionalDuration(input.durationMinutes);
	}
	if ("playerCondition" in input) {
		fields.push("player_condition = @player_condition");
		params.player_condition = optionalShort(input.playerCondition, "playerCondition");
	}
	if ("mood" in input) {
		fields.push("mood = @mood");
		params.mood = optionalShort(input.mood, "mood");
	}
	if ("contentMarkdown" in input) {
		fields.push("content_markdown = @content_markdown");
		params.content_markdown = optionalMarkdown(input.contentMarkdown);
	}
	if ("publicationStatus" in input) {
		if (!PUBLICATION_STATUSES.includes(input.publicationStatus)) throw new ValidationError("publicationStatus", "Status publikasi tidak dikenal.");
		const next = input.publicationStatus;
		fields.push("publication_status = @publication_status");
		params.publication_status = next;
		if (next === "published" && !existing.publishedAt) {
			fields.push("published_at = @published_at");
			params.published_at = nowIso();
		} else if (next === "draft") fields.push("published_at = NULL");
	}
	if (fields.length === 0) return existing;
	getDb().prepare(`UPDATE personal_field_logs SET ${fields.join(", ")} WHERE id = @id`).run(params);
	const updated = getLogById(id);
	if (!updated) throw new NotFoundError("Field Log tidak ditemukan setelah pembaruan.");
	return updated;
}
function publishLog(id) {
	return updateLog(id, { publicationStatus: "published" });
}
function unpublishLog(id) {
	return updateLog(id, { publicationStatus: "draft" });
}
/**
* Deletes a log. This is reversible only via a database backup — the caller
* must have obtained explicit confirmation first.
*/
function deleteLog(id) {
	const existing = getLogById(id);
	if (!existing) throw new NotFoundError("Field Log tidak ditemukan.");
	getDb().prepare("DELETE FROM personal_field_logs WHERE id = ?").run(id);
	return { removed: existing };
}
/** Deletes every log for a game. Used by the explicit "remove with logs" path. */
function deleteLogsForGame(personalGameId, db = getDb()) {
	return db.prepare("DELETE FROM personal_field_logs WHERE personal_game_id = ?").run(personalGameId).changes;
}
function countLogsForGame(personalGameId) {
	return getDb().prepare("SELECT COUNT(*) AS c FROM personal_field_logs WHERE personal_game_id = ?").get(personalGameId).c;
}
// src/lib/server/markdown.ts
/**
* Safe Markdown rendering.
*
* Journal content is authored by the app's own user, but it is still rendered
* into HTML, so it is sanitised with an allow-list. Raw HTML in the source is
* escaped by `marked` (we do not enable its `html` option), and the result is
* additionally run through `sanitize-html` to strip any `javascript:` URLs,
* `<script>`, inline event handlers, etc.
*/
var markdown_exports = /* @__PURE__ */ __exportAll({
	markdownExcerpt: () => markdownExcerpt,
	markdownStats: () => markdownStats,
	renderMarkdown: () => renderMarkdown
});
marked.setOptions({
	gfm: true,
	breaks: true
});
var SANITIZE_OPTIONS = {
	allowedTags: [
		"h1",
		"h2",
		"h3",
		"h4",
		"h5",
		"h6",
		"p",
		"br",
		"hr",
		"strong",
		"em",
		"del",
		"s",
		"code",
		"pre",
		"blockquote",
		"ul",
		"ol",
		"li",
		"a",
		"img",
		"table",
		"thead",
		"tbody",
		"tr",
		"th",
		"td"
	],
	allowedAttributes: {
		a: [
			"href",
			"title",
			"rel",
			"target"
		],
		img: [
			"src",
			"alt",
			"title",
			"loading"
		],
		code: ["class"],
		th: ["align"],
		td: ["align"]
	},
	allowedSchemes: [
		"http",
		"https",
		"mailto"
	],
	allowedSchemesByTag: { img: ["http", "https"] },
	allowProtocolRelative: false,
	nonTextTags: [
		"style",
		"script",
		"textarea",
		"option",
		"noscript"
	],
	transformTags: { a: (tagName, attribs) => {
		const href = attribs.href ?? "";
		const isExternal = /^https?:\/\//i.test(href);
		return {
			tagName,
			attribs: {
				...attribs,
				...isExternal ? {
					target: "_blank",
					rel: "noopener noreferrer"
				} : {}
			}
		};
	} }
};
function renderMarkdown(source) {
	if (!source || !source.trim()) return "";
	const raw = marked.parse(source, { async: false });
	return sanitizeHtml(raw, SANITIZE_OPTIONS);
}
/** Plain-text excerpt for cards and previews. */
function markdownExcerpt(source, max = 200) {
	const text = source.replace(/```[\s\S]*?```/g, " ").replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[#>*_`~-]/g, " ").replace(/\s+/g, " ").trim();
	return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
/** Rough word/char counts shown in the editor footer. */
function markdownStats(source) {
	const trimmed = source.trim();
	return {
		words: trimmed ? trimmed.split(/\s+/).length : 0,
		characters: source.length
	};
}
// src/lib/server/write-guard.ts
/**
* Write-path protection for the personal library.
*
* Threat model: this is a single-user local journal, but it will eventually sit
* behind a reverse proxy or be port-forwarded by accident. Writes must therefore
* fail closed unless one of these is true:
*
*   1. `JOURNAL_ALLOW_WRITES=true` is set explicitly (opt-in, for a trusted
*      private deployment) — still requires a same-origin request and a CSRF
*      token, but drops the localhost-only restriction.
*   2. The request is a genuine same-origin request AND the server is bound to
*      localhost (dev server `astro dev`, or a local `node dist/server/entry.mjs`).
*
* `JOURNAL_REQUIRE_REMOTE_AUTH=true` (default when NODE_ENV=production) makes
* the check stricter: writes are refused outright, because no authentication
* layer exists yet. That is deliberate — an unauthenticated public write endpoint
* would let anyone edit or delete the journal.
*
* Note: Origin/Referer checks and CSRF tokens defend against *cross-site* request
* forgery. They are NOT authentication. They do not stop a same-origin attacker
* who already controls the browser.
*/
var write_guard_exports = /* @__PURE__ */ __exportAll({
	CSRF_COOKIE: () => CSRF_COOKIE,
	CSRF_HEADER: () => CSRF_HEADER,
	csrfCookie: () => csrfCookie,
	evaluateWriteAccess: () => evaluateWriteAccess,
	hasValidCsrfToken: () => hasValidCsrfToken,
	newCsrfToken: () => newCsrfToken
});
var CSRF_COOKIE = "journal_csrf";
var CSRF_HEADER = "x-journal-csrf";
/**
* Hosts considered local. `.localhost` covers the browser's IPv6 loopback
* resolution quirks without opening anything routable.
*/
var LOCAL_HOSTNAMES = /* @__PURE__ */ new Set([
	"localhost",
	"127.0.0.1",
	"::1",
	"[::1]",
	"0.0.0.0"
]);
function isLocalHostname(hostname) {
	const host = hostname.toLowerCase();
	return LOCAL_HOSTNAMES.has(host) || host.endsWith(".localhost");
}
function hostnameOfOrigin(origin) {
	try {
		return new URL(origin).hostname;
	} catch {
		return null;
	}
}
/**
* Decide whether a mutation may proceed.
*
* `request` is the incoming Request; `originHeader` is read from it so callers
* cannot forget to pass it.
*/
function evaluateWriteAccess(request) {
	const explicitOptIn = process.env.JOURNAL_ALLOW_WRITES === "true";
	const requireAuth = process.env.JOURNAL_REQUIRE_REMOTE_AUTH === "true";
	const isProduction = process.env.NODE_ENV === "production";
	const requestUrl = new URL(request.url);
	const origin = request.headers.get("origin");
	const referer = request.headers.get("referer");
	const site = request.headers.get("sec-fetch-site");
	if (origin) {
		if (hostnameOfOrigin(origin) === null) return {
			allowed: false,
			status: 403,
			error: "Origin tidak valid."
		};
		if (!sameOrigin(origin, requestUrl)) return {
			allowed: false,
			status: 403,
			error: "Origin tidak diizinkan."
		};
	} else if (referer) {
		const refererHost = hostnameOfOrigin(referer);
		if (!refererHost || !isSameHost(refererHost, requestUrl.hostname)) return {
			allowed: false,
			status: 403,
			error: "Referer tidak diizinkan."
		};
	}
	if (site && !["same-origin", "none"].includes(site)) return {
		allowed: false,
		status: 403,
		error: "Permintaan lintas situs ditolak."
	};
	if (!hasValidCsrfToken(request)) return {
		allowed: false,
		status: 403,
		error: "Token CSRF tidak valid atau tidak ada."
	};
	if (isProduction && requireAuth && !explicitOptIn) return {
		allowed: false,
		status: 403,
		error: "Penulisan data dinonaktifkan pada deployment publik tanpa autentikasi. Set JOURNAL_ALLOW_WRITES=true hanya jika akses sudah dibatasi."
	};
	if (isProduction && !explicitOptIn) return {
		allowed: false,
		status: 403,
		error: "Penulisan data dinonaktifkan pada mode produksi tanpa autentikasi. Jalankan secara lokal, atau set JOURNAL_ALLOW_WRITES=true di balik akses privat."
	};
	if (!explicitOptIn) {
		if (!isLocalHostname(requestUrl.hostname)) return {
			allowed: false,
			status: 403,
			error: `Penulisan data hanya diizinkan dari localhost (Host: ${requestUrl.hostname}).`
		};
	}
	return { allowed: true };
}
function isSameHost(a, b) {
	return a.toLowerCase() === b.toLowerCase();
}
function sameOrigin(origin, requestUrl) {
	try {
		const parsed = new URL(origin);
		const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
		const requestPort = requestUrl.port || (requestUrl.protocol === "https:" ? "443" : "80");
		return isSameHost(parsed.hostname, requestUrl.hostname) && port === requestPort;
	} catch {
		return false;
	}
}
function readCookie(request, name) {
	const header = request.headers.get("cookie");
	if (!header) return null;
	for (const pair of header.split(";")) {
		const index = pair.indexOf("=");
		if (index === -1) continue;
		if (pair.slice(0, index).trim() === name) return decodeURIComponent(pair.slice(index + 1).trim());
	}
	return null;
}
function hasValidCsrfToken(request) {
	const cookieToken = readCookie(request, CSRF_COOKIE);
	const headerToken = request.headers.get(CSRF_HEADER);
	if (!cookieToken || !headerToken) return false;
	if (cookieToken.length !== headerToken.length) return false;
	try {
		return timingSafeEqual(Buffer.from(cookieToken), Buffer.from(headerToken));
	} catch {
		return false;
	}
}
function newCsrfToken() {
	return randomBytes(32).toString("hex");
}
/** Serialised Set-Cookie value for the double-submit token. */
function csrfCookie(token, secure) {
	return [
		`${CSRF_COOKIE}=${encodeURIComponent(token)}`,
		"Path=/",
		"SameSite=Strict",
		"HttpOnly=false",
		secure ? "Secure" : "",
		"Max-Age=86400"
	].filter(Boolean).join("; ");
}
// src/lib/server/http.ts
/**
* Shared API helpers: JSON responses, body parsing, and a single place that
* turns repository errors into HTTP status codes.
*
* Raw SQL errors never reach the client; unexpected failures are logged
* server-side and returned as a generic 500.
*/
var http_exports = /* @__PURE__ */ __exportAll({
	CSRF_HEADER_REFLECT: () => CSRF_HEADER_REFLECT,
	NO_STORE: () => NO_STORE,
	ensureDatabase: () => ensureDatabase,
	errorResponse: () => errorResponse,
	guardWrite: () => guardWrite,
	json: () => json,
	jsonError: () => jsonError,
	readId: () => readId,
	readJsonBody: () => readJsonBody
});
/** Response header used only to bootstrap the token for non-JS clients. */
var CSRF_HEADER_REFLECT = "x-journal-csrf-issued";
var bootstrapped = false;
/**
* Ensure the schema exists and the legacy backlog is seeded.
*
* Safe to call on every request: migrations are versioned and the seed is keyed
* on `legacy_game_id`, so this is a no-op after the first run.
*/
function ensureDatabase() {
	if (bootstrapped) return { seeded: false };
	migrate();
	const result = seedLegacyBacklog();
	bootstrapped = true;
	if (result.inserted > 0) console.log(`[library] seeded ${result.inserted} legacy backlog record(s)`);
	return { seeded: result.inserted > 0 };
}
var NO_STORE = {
	"Content-Type": "application/json; charset=utf-8",
	"Cache-Control": "no-store"
};
function json(data, status = 200, headers = {}) {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			...NO_STORE,
			...headers
		}
	});
}
function jsonError(status, error, extra = {}) {
	return json({
		error,
		...extra
	}, status);
}
/** Parse a JSON body, rejecting non-objects and oversized payloads. */
async function readJsonBody(request, maxBytes = 524288) {
	if (!(request.headers.get("content-type")?.toLowerCase() ?? "").startsWith("application/json")) throw new ValidationError("content-type", "Content-Type harus application/json.");
	const text = await request.text();
	if (text.length > maxBytes) throw new ValidationError("body", "Payload terlalu besar.");
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new ValidationError("body", "JSON tidak valid.");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ValidationError("body", "Payload harus berupa objek JSON.");
	return parsed;
}
/**
* Apply write protection. Returns either an error Response or the headers to
* merge into the success response (issuing a CSRF cookie when the client has
* none yet, so a first-run form works without a separate bootstrap call).
*/
function guardWrite(request) {
	const decision = evaluateWriteAccess(request);
	if (!decision.allowed) return {
		ok: false,
		response: jsonError(decision.status, decision.error)
	};
	const headers = {};
	if (!request.headers.get("cookie")?.includes("journal_csrf")) {
		const token = newCsrfToken();
		headers["Set-Cookie"] = csrfCookie(token, new URL(request.url).protocol === "https:");
		headers[CSRF_HEADER_REFLECT] = token;
	}
	return {
		ok: true,
		headers
	};
}
/**
* Convert a thrown repository error into a Response. Unknown errors are logged
* and reported generically.
*/
function errorResponse(error, context) {
	if (error instanceof ValidationError) return jsonError(400, error.message, { field: error.field });
	if (error instanceof NotFoundError) return jsonError(404, error.message);
	if (error instanceof DuplicateError) return jsonError(409, error.message, { game: error.existing });
	if (error instanceof ConflictError) return jsonError(409, error.message, error.details);
	console.error(`[library:${context}]`, error);
	return jsonError(500, "Terjadi kesalahan pada server.");
}
/** Narrow an unknown route param to a plausible record id. */
function readId(value) {
	if (!value) return null;
	const id = value.trim();
	if (!id || id.length > 100) return null;
	return id;
}
export { db_exports as db, write_guard_exports as guard, http_exports as http, library_repository_exports as library, field_log_repository_exports as logs, markdown_exports as markdown, migrations_exports as migrations, legacy_seed_exports as seed };
