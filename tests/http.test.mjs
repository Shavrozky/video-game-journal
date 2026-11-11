/**
 * HTTP integration tests.
 *
 * These require a running server (dev or preview). They are skipped when none
 * is reachable, so `npm test` stays useful offline; when a server is present
 * they exercise real endpoints, CSRF enforcement and status codes end to end.
 *
 * Provide the target with JOURNAL_TEST_BASE (default http://localhost:4321).
 */

import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';

const BASE = process.env.JOURNAL_TEST_BASE ?? 'http://localhost:4321';

let reachable = false;
let csrfToken = null;
let cookieJar = '';

async function fetchWithJar(url, options = {}) {
  const headers = { ...(options.headers ?? {}) };

  if (cookieJar) headers.cookie = cookieJar;

  const response = await fetch(url, { ...options, headers, redirect: 'manual' });

  const setCookie = response.headers.getSetCookie?.() ?? [];
  for (const entry of setCookie) {
    const pair = entry.split(';')[0];
    if (pair.startsWith('journal_csrf=')) {
      cookieJar = pair;
      csrfToken = decodeURIComponent(pair.slice('journal_csrf='.length));
    }
  }

  return response;
}

async function mutate(path, { method = 'POST', body, withCsrf = true } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (withCsrf && csrfToken) headers['x-journal-csrf'] = csrfToken;

  return fetchWithJar(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

before(async () => {
  try {
    const response = await fetch(`${BASE}/api/games?page_size=1`, {
      signal: AbortSignal.timeout(4000),
    });
    reachable = response.ok;

    if (reachable) {
      // Prime the CSRF cookie via a normal page load.
      await fetchWithJar(`${BASE}/backlog`);
    }
  } catch {
    reachable = false;
  }

  if (!reachable) {
    console.log(`[http tests] no server at ${BASE} — integration tests skipped`);
  }
});

describe('catalog endpoints (regression)', () => {
  it('GET /api/games still returns the Steam dataset', async (t) => {
    if (!reachable) return t.skip('server not running');

    const response = await fetchWithJar(`${BASE}/api/games?page_size=2`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.ok(body.total > 11000, `expected >11000 catalog records, got ${body.total}`);
    assert.equal(body.results.length, 2);
  });

  it('GET /api/games/[appId] still resolves a catalog game', async (t) => {
    if (!reachable) return t.skip('server not running');

    const response = await fetchWithJar(`${BASE}/api/games/304240`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.appId, 304240);
    assert.equal(body.name, 'Resident Evil');
  });

  it('unknown AppID is a 404', async (t) => {
    if (!reachable) return t.skip('server not running');

    const response = await fetchWithJar(`${BASE}/api/games/999999999`);
    assert.equal(response.status, 404);
  });
});

describe('library reads', () => {
  it('GET /api/library/games returns the seeded backlog', async (t) => {
    if (!reachable) return t.skip('server not running');

    const response = await fetchWithJar(`${BASE}/api/library/games`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.ok(Array.isArray(body.results));
    assert.ok(body.total >= 16, `expected >=16 seeded games, got ${body.total}`);
  });

  it('exposes the CSRF cookie to the page', async (t) => {
    if (!reachable) return t.skip('server not running');

    assert.ok(csrfToken, 'middleware should have issued a CSRF cookie');
  });
});

describe('library writes require a CSRF token', () => {
  it('rejects a write with no token', async (t) => {
    if (!reachable) return t.skip('server not running');

    const response = await mutate('/api/library/games', {
      body: { steamAppId: 304240 },
      withCsrf: false,
    });

    assert.equal(response.status, 403);
  });

  it('rejects a cross-site Origin even with a token', async (t) => {
    if (!reachable) return t.skip('server not running');

    const response = await fetchWithJar(`${BASE}/api/library/games`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://evil.example',
        'x-journal-csrf': csrfToken ?? '',
      },
      body: JSON.stringify({ steamAppId: 304240 }),
    });

    assert.equal(response.status, 403);
  });
});

describe('library lifecycle', () => {
  let createdId = null;
  const uniqueAppId = Number(process.env.JOURNAL_TEST_APPID ?? 304240);

  it('adds a Steam game', async (t) => {
    if (!reachable) return t.skip('server not running');

    const response = await mutate('/api/library/games', { body: { steamAppId: uniqueAppId } });
    const body = await response.json();

    // 201 on first run; 409 if a previous run already saved it.
    assert.ok([201, 409].includes(response.status), `unexpected status ${response.status}`);

    createdId = body.game?.id ?? null;
    if (response.status === 201) {
      assert.equal(body.game.steamAppId, uniqueAppId);
      assert.equal(body.game.status, 'Queued');
    }
  });

  it('rejects a duplicate Steam AppID with 409', async (t) => {
    if (!reachable) return t.skip('server not running');

    const response = await mutate('/api/library/games', { body: { steamAppId: uniqueAppId } });
    assert.equal(response.status, 409);
  });

  it('rejects an unknown Steam AppID with 404', async (t) => {
    if (!reachable) return t.skip('server not running');

    const response = await mutate('/api/library/games', { body: { steamAppId: 999999999 } });
    assert.equal(response.status, 404);
  });

  it('rejects a manual game without a title with 400', async (t) => {
    if (!reachable) return t.skip('server not running');

    const response = await mutate('/api/library/games', { body: { platform: 'PC' } });
    assert.equal(response.status, 400);
  });

  it('creates a manual game with a null Steam AppID', async (t) => {
    if (!reachable) return t.skip('server not running');

    const title = `HTTP Test Game ${Date.now()}`;
    const response = await mutate('/api/library/games', {
      body: { title, platform: 'PC', status: 'Queued' },
    });
    const body = await response.json();

    assert.equal(response.status, 201);
    assert.equal(body.game.steamAppId, null);
    assert.equal(body.game.source, 'manual');
    assert.equal(body.game.title, title);
  });

  it('updates status, progress and playtime', async (t) => {
    if (!reachable || !createdId) return t.skip('no record created');

    const response = await mutate(`/api/library/games/${createdId}`, {
      method: 'PATCH',
      body: { status: 'Playing', progressPercent: 55, hoursPlayed: 3.5 },
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.game.status, 'Playing');
    assert.equal(body.game.progressPercent, 55);
    assert.equal(body.game.hoursPlayed, 3.5);
  });

  it('rejects an out-of-range progress value with 400', async (t) => {
    if (!reachable || !createdId) return t.skip('no record created');

    const response = await mutate(`/api/library/games/${createdId}`, {
      method: 'PATCH',
      body: { progressPercent: 250 },
    });

    assert.equal(response.status, 400);
  });

  it('creates, saves and publishes a Field Log', async (t) => {
    if (!reachable || !createdId) return t.skip('no record created');

    const created = await mutate(`/api/library/games/${createdId}/logs`, {
      body: { title: 'HTTP session', contentMarkdown: '# Draft\n\nBody.' },
    });
    const createdBody = await created.json();

    assert.equal(created.status, 201);
    assert.equal(createdBody.log.publicationStatus, 'draft');

    const logId = createdBody.log.id;

    const updated = await mutate(`/api/library/logs/${logId}`, {
      method: 'PATCH',
      body: { contentMarkdown: '# Revised\n\nSaved body.', publicationStatus: 'published' },
    });
    const updatedBody = await updated.json();

    assert.equal(updated.status, 200);
    assert.equal(updatedBody.log.publicationStatus, 'published');
    assert.ok(updatedBody.log.publishedAt);
    assert.match(updatedBody.log.contentMarkdown, /Revised/);

    // Readable without a rebuild.
    const read = await fetchWithJar(`${BASE}/library/logs/${logId}`);
    assert.equal(read.status, 200);

    // The published page contains the rendered markdown.
    const html = await read.text();
    assert.match(html, /Revised/);
  });

  it('sanitises script tags in a rendered log', async (t) => {
    if (!reachable || !createdId) return t.skip('no record created');

    const created = await mutate(`/api/library/games/${createdId}/logs`, {
      body: {
        title: 'XSS probe',
        contentMarkdown: 'Safe text <script>window.__pwned=true</script>',
        publicationStatus: 'published',
      },
    });
    const body = await created.json();

    const page = await fetchWithJar(`${BASE}/library/logs/${body.log.id}`);
    const html = await page.text();

    assert.ok(!/<script>window\.__pwned/.test(html), 'script tag reached the page');
  });

  it('blocks deleting a game that still has logs', async (t) => {
    if (!reachable || !createdId) return t.skip('no record created');

    const response = await mutate(`/api/library/games/${createdId}`, { method: 'DELETE' });
    assert.equal(response.status, 409);
  });

  it('deletes the game when logging deletes are explicit', async (t) => {
    if (!reachable || !createdId) return t.skip('no record created');

    const response = await mutate(`/api/library/games/${createdId}?deleteLogs=true`, {
      method: 'DELETE',
    });

    assert.equal(response.status, 200);

    const check = await fetchWithJar(`${BASE}/api/library/games/${createdId}`);
    assert.equal(check.status, 404);
  });

  it('remains gone after a re-read (persistence)', async (t) => {
    if (!reachable || !createdId) return t.skip('no record created');

    const response = await fetchWithJar(`${BASE}/api/library/games/${createdId}`);
    assert.equal(response.status, 404);
  });
});

describe('legacy routes still work', () => {
  const pages = ['/', '/backlog', '/catalog', '/catalog/304240', '/games/signalis', '/journal/mothered-log-01'];

  for (const page of pages) {
    it(`GET ${page} responds 200`, async (t) => {
      if (!reachable) return t.skip('server not running');

      const response = await fetchWithJar(`${BASE}${page}`);
      assert.equal(response.status, 200, `${page} returned ${response.status}`);
    });
  }
});
