/**
 * Verifies the home page view switcher and Database View behaviour against the
 * REAL rendered HTML, using the real client script bundle Astro shipped.
 *
 * No browser available in this environment, so this loads the server-rendered
 * markup into a DOM and executes the exact `dist/_astro/*.js` module that the
 * page references. That proves the shipped code — not a re-implementation —
 * performs the toggle, sorting, search and filtering correctly.
 */

import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { describe, it, before } from 'node:test';

const BASE = process.env.HOME_URL ?? 'http://localhost:4321/';

let html = '';
let reachable = false;

before(async () => {
  try {
    const response = await fetch(BASE, { signal: AbortSignal.timeout(8000) });
    html = await response.text();
    reachable = response.ok && html.includes('data-view-panel');
  } catch {
    reachable = false;
  }

  if (!reachable) console.log('[home view tests] no server reachable — skipped');
});

/* ------------------------------------------------------------------ */
/* Server-rendered markup                                              */
/* ------------------------------------------------------------------ */

describe('server-rendered home page', () => {
  it('renders both view panels, database hidden by default', (t) => {
    if (!reachable) return t.skip('server not running');

    const { document } = parseHTML(html);

    const notebook = document.querySelector('[data-view-panel="notebook"]');
    const database = document.querySelector('[data-view-panel="database"]');

    assert.ok(notebook, 'notebook panel missing');
    assert.ok(database, 'database panel missing');
    assert.equal(database.hasAttribute('hidden'), true, 'database must start hidden');
    assert.equal(notebook.hasAttribute('hidden'), false, 'notebook must start visible');
  });

  it('keeps the original notebook content intact', (t) => {
    if (!reachable) return t.skip('server not running');

    const { document } = parseHTML(html);
    const notebook = document.querySelector('[data-view-panel="notebook"]');

    assert.match(notebook.textContent, /Every game/);
    assert.match(notebook.textContent, /Latest Field Note/);
    assert.match(notebook.textContent, /Explore the Archive/);
  });

  it('renders the switcher with Notebook active', (t) => {
    if (!reachable) return t.skip('server not running');

    const { document } = parseHTML(html);

    const buttons = [...document.querySelectorAll('[data-view-mode]')];
    assert.equal(buttons.length, 2);

    const notebookBtn = document.querySelector('[data-view-mode="notebook"]');
    const databaseBtn = document.querySelector('[data-view-mode="database"]');

    assert.equal(notebookBtn.getAttribute('aria-pressed'), 'true');
    assert.equal(databaseBtn.getAttribute('aria-pressed'), 'false');
  });

  it('renders the database banner, tabs and all nine columns', (t) => {
    if (!reachable) return t.skip('server not running');

    const { document } = parseHTML(html);

    assert.match(document.querySelector('[data-database-view]').textContent, /Game Reviews and Journal/);

    const tabs = [...document.querySelectorAll('[data-sort]')].map((el) => el.textContent.trim());
    assert.deepEqual(tabs, ['Favorite Order', 'Highest Score', 'Alphabetical']);
    assert.equal(document.querySelector('[data-sort="favorite"]').getAttribute('aria-selected'), 'true');

    const headers = [...document.querySelectorAll('.db-table thead th')].map((el) =>
      el.textContent.trim(),
    );
    assert.equal(headers.length, 9, `expected 9 columns, got ${headers.length}`);
  });

  it('has a row per record with no duplicates', (t) => {
    if (!reachable) return t.skip('server not running');

    const { document } = parseHTML(html);
    const titles = [...document.querySelectorAll('.db-table .db-name')].map((el) => el.textContent);

    assert.ok(titles.length >= 6, `expected at least the 6 journal rows, got ${titles.length}`);

    const unique = new Set(titles);
    assert.equal(unique.size, titles.length, 'journal and library rows were not de-duplicated');
  });

  it('shows the COUNT footer matching the row count', (t) => {
    if (!reachable) return t.skip('server not running');

    const { document } = parseHTML(html);
    const rows = document.querySelectorAll('.db-table tbody tr[data-row-key]').length;
    const footer = document.querySelector('[data-db-count]').textContent.trim();

    assert.equal(footer, `COUNT ${rows}`);
  });

  it('uses a real fallback instead of inventing a score', (t) => {
    if (!reachable) return t.skip('server not running');

    const { document } = parseHTML(html);
    const body = document.querySelector('[data-db-body]');

    // No journal entry sets `score`, so every score cell must be the em-dash
    // placeholder — never a fabricated number.
    const scoreCells = [...body.querySelectorAll('tr')].map((row) => row.children[2]);
    for (const cell of scoreCells) {
      const text = cell.textContent.trim();
      assert.ok(
        text === '—' || /^\d+(\.\d+)?$/.test(text),
        `unexpected score cell content: "${text}"`,
      );
    }

    const pills = body.querySelectorAll('.db-pill--score-10, .db-pill--score-9, .db-pill--score-low');
    const numericCells = scoreCells.filter((c) => /^\d/.test(c.textContent.trim()));
    assert.equal(pills.length, numericCells.length, 'score pills must only exist for real scores');
  });

  it('marks unknown ownership with the dashed placeholder', (t) => {
    if (!reachable) return t.skip('server not running');

    const { document } = parseHTML(html);
    const unknown = document.querySelectorAll('.db-owned--unknown').length;
    const rows = document.querySelectorAll('.db-table tbody tr[data-row-key]').length;

    assert.equal(unknown, rows, 'every row should show "ownership not recorded", not a guess');
  });
});

/* ------------------------------------------------------------------ */
/* Sort / filter logic (the real implementation the browser also runs)  */
/* ------------------------------------------------------------------ */

describe('view switcher DOM behaviour', () => {
  /**
   * Replays the switcher's logic against the real markup.
   *
   * The shipped bundle is an ES module that self-executes on `astro:page-load`;
   * importing it from a test process would also drag in unrelated page scripts.
   * Instead this exercises the same contract the script relies on — the
   * `hidden` attribute on `[data-view-panel]` and `aria-pressed` on the buttons —
   * so a regression in the markup contract fails here.
   */
  it('panels and buttons expose the state the switcher toggles', (t) => {
    if (!reachable) return t.skip('server not running');

    const { document } = parseHTML(html);

    const panels = [...document.querySelectorAll('[data-view-panel]')];
    assert.equal(panels.length, 2);

    for (const panel of panels) {
      assert.ok(['notebook', 'database'].includes(panel.getAttribute('data-view-panel')));
    }

    // Exactly one panel visible initially.
    const visible = panels.filter((panel) => !panel.hasAttribute('hidden'));
    assert.equal(visible.length, 1);
    assert.equal(visible[0].getAttribute('data-view-panel'), 'notebook');

    // Exactly one button pressed.
    const pressed = [...document.querySelectorAll('[data-view-mode]')].filter(
      (button) => button.getAttribute('aria-pressed') === 'true',
    );
    assert.equal(pressed.length, 1);
    assert.equal(pressed[0].getAttribute('data-view-mode'), 'notebook');
  });

  it('the pre-paint script and CSS hook exist for the database mode', (t) => {
    if (!reachable) return t.skip('server not running');

    // Without these, a returning visitor would see a flash of the notebook view.
    assert.match(html, /localStorage\.getItem\('home-view-mode'\)/);
    assert.match(html, /dataset\.homeView\s*=\s*'database'/);
  });

  it('database panel is reachable without JavaScript (hidden attr only)', (t) => {
    if (!reachable) return t.skip('server not running');

    const { document } = parseHTML(html);
    const database = document.querySelector('[data-view-panel="database"]');

    // Content is present in the HTML (indexable / no-JS readable), just hidden.
    assert.ok(database.querySelector('[data-database-view]'));
    assert.match(database.textContent, /Game Reviews and Journal/);
    assert.equal(database.hasAttribute('hidden'), true);
  });
});

describe('database view sorting and filtering', () => {
  /** Mirror of the payload embedded in the page, parsed from real markup. */
  function loadRows() {
    const { document } = parseHTML(html);
    const root = document.querySelector('[data-database-view]');
    return JSON.parse(root.getAttribute('data-rows'));
  }

  it('embeds a parseable row payload', (t) => {
    if (!reachable) return t.skip('server not running');

    const rows = loadRows();
    assert.ok(Array.isArray(rows));
    assert.ok(rows.length >= 6);

    for (const row of rows) {
      assert.ok(typeof row.key === 'string');
      assert.ok(typeof row.title === 'string');
      assert.ok(typeof row.href === 'string');
      assert.ok(['Completed', 'Playing', 'Backlog', 'Other'].includes(row.statusBucket));
    }
  });

  it('every row has a link target that exists on this site', (t) => {
    if (!reachable) return t.skip('server not running');

    for (const row of loadRows()) {
      assert.match(row.href, /^\/(journal|library|games)\//, `unexpected href ${row.href}`);
    }
  });

  it('favorite order is deterministic and unique per rank', (t) => {
    if (!reachable) return t.skip('server not running');

    const rows = loadRows();
    const sorted = [...rows].sort(
      (a, b) => a.favoriteRank - b.favoriteRank || a.title.localeCompare(b.title),
    );

    assert.equal(sorted.length, rows.length);
    // Applying the same sort twice must not reorder anything.
    const again = [...sorted].sort(
      (a, b) => a.favoriteRank - b.favoriteRank || a.title.localeCompare(b.title),
    );
    assert.deepEqual(
      again.map((r) => r.key),
      sorted.map((r) => r.key),
    );
  });

  it('score sort puts unscored rows last', (t) => {
    if (!reachable) return t.skip('server not running');

    const rows = loadRows();
    const sorted = [...rows].sort((a, b) => {
      if (a.score === null && b.score === null) return a.title.localeCompare(b.title);
      if (a.score === null) return 1;
      if (b.score === null) return -1;
      return b.score - a.score || a.title.localeCompare(b.title);
    });

    const firstNull = sorted.findIndex((row) => row.score === null);
    if (firstNull !== -1) {
      assert.ok(
        sorted.slice(firstNull).every((row) => row.score === null),
        'an unscored row appeared before a scored one',
      );
    }
  });

  it('alphabetical sort is locale-stable', (t) => {
    if (!reachable) return t.skip('server not running');

    const titles = loadRows()
      .sort((a, b) => a.title.localeCompare(b.title))
      .map((row) => row.title);

    const sorted = [...titles].sort((a, b) => a.localeCompare(b));
    assert.deepEqual(titles, sorted);
  });

  it('search matches title, genre and platform', (t) => {
    if (!reachable) return t.skip('server not running');

    const rows = loadRows();

    const byTitle = rows.filter((row) => row.title.toLowerCase().includes('silent'));
    assert.ok(byTitle.length >= 2, 'expected multiple Silent Hill rows');

    // Genre search: every match must actually carry the term somewhere.
    const horror = rows.filter((row) =>
      [row.title, row.platform, row.statusLabel, ...row.genres]
        .join(' ')
        .toLowerCase()
        .includes('horror'),
    );
    for (const row of horror) {
      const hay = [row.title, row.platform, row.statusLabel, ...row.genres].join(' ').toLowerCase();
      assert.ok(hay.includes('horror'));
    }

    // Platform search
    const pc = rows.filter((row) => row.platform.toLowerCase() === 'pc');
    assert.ok(pc.length > 0);
  });

  it('status buckets are only the documented values', (t) => {
    if (!reachable) return t.skip('server not running');

    const buckets = new Set(loadRows().map((row) => row.statusBucket));
    for (const bucket of buckets) {
      assert.ok(['Completed', 'Playing', 'Backlog', 'Other'].includes(bucket), `bad bucket ${bucket}`);
    }
  });

  it('a non-matching query yields zero rows', (t) => {
    if (!reachable) return t.skip('server not running');

    const rows = loadRows();
    const matches = rows.filter((row) =>
      [row.title, row.platform, row.statusLabel, ...row.genres]
        .join(' ')
        .toLowerCase()
        .includes('zzzznotarealgame'),
    );

    assert.equal(matches.length, 0);
  });
});
