/**
 * Personal library, Field Log, Markdown-safety and write-guard tests.
 *
 * Everything runs against the compiled repository code with a throwaway
 * database, so no real journal data is touched.
 */

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { buildServerModules, cleanupDir, makeTempDataDir } from './harness.mjs';

const DATA_DIR = makeTempDataDir('library');
process.env.PERSONAL_DATA_DIR = DATA_DIR;

// Vite's build sets NODE_ENV=production, which would make later assertions in
// this file run against the production write policy. Pin the policy inputs so
// every test sees an explicit, known environment.
delete process.env.JOURNAL_ALLOW_WRITES;
delete process.env.JOURNAL_REQUIRE_REMOTE_AUTH;
process.env.NODE_ENV = 'development';

let mod;

before(async () => {
  const bundle = await buildServerModules("library");
  mod = await import(pathToFileURL(bundle).href);

  mod.migrations.migrate();
  mod.seed.seedLegacyBacklog();
});

after(() => {
  try {
    mod?.db.closeDb();
  } catch {
    /* ignore */
  }
  cleanupDir(DATA_DIR);
});

/* ------------------------------------------------------------------ */
/* Personal library                                                    */
/* ------------------------------------------------------------------ */

describe('personal library', () => {
  it('starts with the 16 legacy games', () => {
    assert.equal(mod.library.countGames(), 16);
  });

  it('adds a Steam game with catalog-resolved metadata', () => {
    const game = mod.library.addSteamGame({
      steamAppId: 304240,
      title: 'Resident Evil',
      genre: 'Action',
      coverUrl: 'https://shared.akamai.steamstatic.com/x/header.jpg',
      releaseYear: 2015,
    });

    assert.equal(game.source, 'steam');
    assert.equal(game.steamAppId, 304240);
    assert.equal(game.status, 'Queued', 'new Steam games default to Queued');
    assert.equal(game.title, 'Resident Evil');
    assert.equal(game.hoursPlayed, null, 'no fabricated playtime');
    assert.equal(game.personalRating, null, 'no fabricated rating');
    assert.equal(game.completedAt, null, 'no fabricated completion date');
  });

  it('rejects a duplicate Steam AppID', () => {
    assert.throws(
      () => mod.library.addSteamGame({ steamAppId: 304240, title: 'Resident Evil' }),
      (error) => error.name === 'DuplicateError' && error.existing?.steamAppId === 304240,
    );

    assert.equal(mod.library.countGames(), 17, 'no extra row was inserted');
  });

  it('rejects an invalid Steam AppID', () => {
    assert.throws(
      () => mod.library.addSteamGame({ steamAppId: -5, title: 'Nope' }),
      /AppID tidak valid/,
    );
  });

  it('finds the saved game by Steam AppID', () => {
    const found = mod.library.getGameBySteamAppId(304240);
    assert.equal(found?.title, 'Resident Evil');
  });

  it('creates a manual game with a null Steam AppID', () => {
    const game = mod.library.createManualGame({
      title: 'SIGNALIS',
      platform: 'PC',
      franchise: 'Indie Horror',
      releaseYear: 2022,
      genre: 'Survival Horror',
      status: 'Queued',
      priority: 'High',
      notes: 'Retrofuturisme.',
    });

    assert.equal(game.source, 'manual');
    assert.equal(game.steamAppId, null, 'manual records have no Steam AppID');
    assert.equal(game.legacyGameId, null);
    assert.equal(game.status, 'Queued');
  });

  it('rejects a manual game without a title', () => {
    assert.throws(
      () => mod.library.createManualGame({ title: '   ', platform: 'PC' }),
      /Judul game wajib diisi/,
    );
  });

  it('rejects a manual game without a platform', () => {
    assert.throws(
      () => mod.library.createManualGame({ title: 'Test', platform: '' }),
      /Platform wajib diisi/,
    );
  });

  it('warns about similar titles without merging', () => {
    const matches = mod.library.findSimilarGames('signalis');
    assert.ok(matches.length >= 1, 'case-insensitive substring match should find SIGNALIS');
    assert.ok(matches.some((game) => game.title === 'SIGNALIS'));

    // Advisory only: creating the record anyway is allowed.
    const before = mod.library.countGames();
    mod.library.createManualGame({ title: 'SIGNALIS (Art Book Edition)', platform: 'PC' });
    assert.equal(mod.library.countGames(), before + 1);
  });

  it('validates numeric ranges', () => {
    const game = mod.library.createManualGame({ title: 'Range Test', platform: 'PC' });

    assert.throws(() => mod.library.updateGame(game.id, { progressPercent: 150 }), /antara 0 dan 100/);
    assert.throws(() => mod.library.updateGame(game.id, { personalRating: 0 }), /antara 1 dan 10/);
    assert.throws(() => mod.library.updateGame(game.id, { hoursPlayed: -3 }), /antara 0/);
  });

  it('updates status, progress and playtime', () => {
    const steam = mod.library.getGameBySteamAppId(304240);
    const updated = mod.library.updateGame(steam.id, {
      status: 'Playing',
      progressPercent: 40,
      hoursPlayed: 6.5,
      personalRating: 8,
    });

    assert.equal(updated.status, 'Playing');
    assert.equal(updated.progressPercent, 40);
    assert.equal(updated.hoursPlayed, 6.5);
    assert.equal(updated.personalRating, 8);
    assert.notEqual(updated.updatedAt, steam.updatedAt, 'updated_at must change');
  });

  it('refuses to rewrite a Steam record identity', () => {
    const steam = mod.library.getGameBySteamAppId(304240);

    assert.throws(
      () => mod.library.updateGame(steam.id, { title: 'Hacked Title' }),
      /mengikuti data katalog/,
    );
  });

  it('filters by status, platform and priority', () => {
    assert.ok(mod.library.listGames({ status: 'Playing' }).every((g) => g.status === 'Playing'));
    assert.ok(mod.library.listGames({ platform: 'PS2' }).every((g) => g.platform === 'PS2'));
    assert.ok(mod.library.listGames({ priority: 'High' }).every((g) => g.priority === 'High'));
  });

  it('searches case-insensitively', () => {
    const lower = mod.library.listGames({ search: 'silent hill' });
    const upper = mod.library.listGames({ search: 'SILENT HILL' });

    assert.ok(lower.length > 0);
    assert.equal(lower.length, upper.length);
  });

  it('treats LIKE wildcards literally', () => {
    // A bare "%" must not match every row.
    const all = mod.library.countGames();
    const wildcard = mod.library.listGames({ search: '%' });
    assert.ok(wildcard.length < all, '"%" should not behave as a wildcard');
  });

  it('sorts by title and by progress', () => {
    const byTitle = mod.library.listGames({ order: 'title' });
    const sorted = [...byTitle].sort((a, b) => a.title.localeCompare(b.title, 'en'));
    assert.equal(byTitle[0].id, sorted[0].id);

    const byProgress = mod.library.listGames({ order: 'progress' });
    const first = byProgress[0].progressPercent ?? -1;
    const last = byProgress[byProgress.length - 1].progressPercent ?? -1;
    assert.ok(first >= last, 'progress order should be descending');
  });
});

/* ------------------------------------------------------------------ */
/* Field logs                                                          */
/* ------------------------------------------------------------------ */

describe('field logs', () => {
  let gameId;

  before(() => {
    gameId = mod.library.getGameByLegacyId('mothered').id;
  });

  it('creates a draft linked to the right game', () => {
    const log = mod.logs.createLog({
      personalGameId: gameId,
      title: 'Sesi manekin',
      sessionDate: '2026-02-01',
      durationMinutes: 90,
      playerCondition: 'Gelisah',
      mood: 'Sunyi',
      contentMarkdown: '## Catatan\n\nRumah itu terasa **hidup**.',
    });

    assert.equal(log.personalGameId, gameId);
    assert.equal(log.publicationStatus, 'draft');
    assert.equal(log.publishedAt, null);
    assert.equal(log.durationMinutes, 90);
  });

  it('edits draft content and persists it', () => {
    const [log] = mod.logs.listLogsForGame(gameId);
    const updated = mod.logs.updateLog(log.id, { contentMarkdown: '# Revisi\n\nIsi baru.' });

    assert.match(updated.contentMarkdown, /Revisi/);

    const reread = mod.logs.getLogById(log.id);
    assert.match(reread.contentMarkdown, /Revisi/);
  });

  it('publishes and stamps published_at', () => {
    const [log] = mod.logs.listLogsForGame(gameId);
    const published = mod.logs.publishLog(log.id);

    assert.equal(published.publicationStatus, 'published');
    assert.ok(published.publishedAt, 'published_at should be set');
  });

  it('reverting to draft clears published_at', () => {
    const [log] = mod.logs.listLogsForGame(gameId);
    const draft = mod.logs.unpublishLog(log.id);

    assert.equal(draft.publicationStatus, 'draft');
    assert.equal(draft.publishedAt, null);
  });

  it('rejects a log for a non-existent game', () => {
    assert.throws(
      () => mod.logs.createLog({ personalGameId: 'nope', title: 'X' }),
      /Game tujuan tidak ditemukan/,
    );
  });

  it('rejects a log without a title', () => {
    assert.throws(
      () => mod.logs.createLog({ personalGameId: gameId, title: '  ' }),
      /Judul catatan wajib diisi/,
    );
  });

  it('blocks deleting a game that has logs', () => {
    assert.throws(
      () => mod.library.removeGame(gameId),
      (error) => error.name === 'ConflictError' && Array.isArray(error.details.logs),
    );

    assert.ok(mod.library.getGameById(gameId), 'game must still exist');
  });

  it('cascades explicitly when deleteLogs is requested', () => {
    const before = mod.logs.listLogsForGame(gameId).length;
    assert.ok(before > 0);

    mod.db.transaction((db) => {
      mod.logs.deleteLogsForGame(gameId, db);
      mod.library.removeGame(gameId);
    });

    assert.equal(mod.library.getGameById(gameId), null);
    assert.equal(mod.logs.listLogsForGame(gameId).length, 0);
  });

  it('deletes an individual log', () => {
    const other = mod.library.getGameByLegacyId('paratopic').id;
    const log = mod.logs.createLog({ personalGameId: other, title: 'Temp' });

    const { removed } = mod.logs.deleteLog(log.id);

    assert.equal(removed.id, log.id);
    assert.equal(mod.logs.getLogById(log.id), null);
  });
});

/* ------------------------------------------------------------------ */
/* Markdown safety                                                     */
/* ------------------------------------------------------------------ */

describe('markdown rendering', () => {
  it('renders ordinary markdown', () => {
    const html = mod.markdown.renderMarkdown('# Title\n\nSome **bold** text.');
    assert.match(html, /<h1/);
    assert.match(html, /<strong>bold<\/strong>/);
  });

  it('strips script tags', () => {
    const html = mod.markdown.renderMarkdown('Hello <script>alert(1)</script> world');
    assert.ok(!/script/i.test(html), `script tag survived: ${html}`);
    assert.ok(!/alert\(1\)/.test(html), 'script body survived');
  });

  it('strips inline event handlers', () => {
    const html = mod.markdown.renderMarkdown('<img src="x" onerror="alert(1)">');
    assert.ok(!/onerror/i.test(html), `onerror survived: ${html}`);
  });

  it('strips javascript: URLs', () => {
    const html = mod.markdown.renderMarkdown('[click](javascript:alert(1))');
    assert.ok(!/javascript:/i.test(html), `javascript: URL survived: ${html}`);
  });

  it('keeps safe links and adds rel for external ones', () => {
    const html = mod.markdown.renderMarkdown('[Steam](https://store.steampowered.com)');
    assert.match(html, /href="https:\/\/store\.steampowered\.com"/);
    assert.match(html, /rel="noopener noreferrer"/);
  });

  it('produces a plain-text excerpt', () => {
    const excerpt = mod.markdown.markdownExcerpt('# Heading\n\nSome **bold** and [a link](https://x.test).', 60);
    assert.ok(!excerpt.includes('#'));
    assert.ok(!excerpt.includes('**'));
    assert.ok(excerpt.length <= 61);
  });
});

/* ------------------------------------------------------------------ */
/* Write guard                                                         */
/* ------------------------------------------------------------------ */

describe('write guard', () => {
  const origin = 'http://localhost:4321';

  function makeRequest(path, { headers = {}, method = 'POST' } = {}) {
    return new Request(`${origin}${path}`, { method, headers });
  }

  it('rejects a cross-site Origin', () => {
    const decision = mod.guard.evaluateWriteAccess(
      makeRequest('/api/library/games', { headers: { origin: 'https://evil.example' } }),
    );

    assert.equal(decision.allowed, false);
    assert.equal(decision.status, 403);
  });

  it('rejects a missing CSRF token', () => {
    const decision = mod.guard.evaluateWriteAccess(
      makeRequest('/api/library/games', { headers: { origin } }),
    );

    assert.equal(decision.allowed, false);
    assert.match(decision.error, /CSRF/i);
  });

  it('rejects a mismatched CSRF token', () => {
    const decision = mod.guard.evaluateWriteAccess(
      makeRequest('/api/library/games', {
        headers: {
          origin,
          cookie: 'journal_csrf=aaa',
          'x-journal-csrf': 'bbb',
        },
      }),
    );

    assert.equal(decision.allowed, false);
  });

  it('allows a same-origin request with a matching token', () => {
    const token = 'test-token-1234567890';

    const decision = mod.guard.evaluateWriteAccess(
      makeRequest('/api/library/games', {
        headers: {
          origin,
          cookie: `journal_csrf=${token}`,
          'x-journal-csrf': token,
        },
      }),
    );

    assert.equal(
      decision.allowed,
      true,
      `guard denied: ${JSON.stringify(decision)} (NODE_ENV=${process.env.NODE_ENV})`,
    );
  });

  it('rejects sec-fetch-site: cross-site', () => {
    const token = 'test-token-1234567890';

    const decision = mod.guard.evaluateWriteAccess(
      makeRequest('/api/library/games', {
        headers: {
          origin,
          'sec-fetch-site': 'cross-site',
          cookie: `journal_csrf=${token}`,
          'x-journal-csrf': token,
        },
      }),
    );

    assert.equal(decision.allowed, false);
  });
});

/* ------------------------------------------------------------------ */
/* SQL injection                                                       */
/* ------------------------------------------------------------------ */

describe('sql injection resistance', () => {
  it('treats a classic injection string as literal input', () => {
    const attack = "'; DROP TABLE personal_games; --";

    const matches = mod.library.listGames({ search: attack });
    assert.deepEqual(matches, []);

    // Table must still exist and be intact.
    assert.ok(mod.library.countGames() > 0);
  });

  it('stores injection text as plain data', () => {
    const attack = "Robert'); DROP TABLE personal_games;--";
    const game = mod.library.createManualGame({ title: attack, platform: 'PC' });

    assert.equal(game.title, attack);
    assert.ok(mod.library.countGames() > 0);
  });

  it('rejects unknown columns on update', () => {
    const game = mod.library.listGames({ order: 'title' })[0];

    assert.throws(
      () => mod.library.updateGame(game.id, { "status = 'Cleared', title": 'x' }),
      /tidak dapat diubah/,
    );
  });
});
