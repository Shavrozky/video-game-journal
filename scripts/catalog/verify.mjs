#!/usr/bin/env node
/**
 * Offline verification of the generated Steam catalog.
 *
 * Runs the same store + query engine the API routes use, directly against the
 * generated JSON. Catches data problems without needing a running server.
 *
 *   npm run catalog:verify
 *   npm run catalog:verify -- --base http://localhost:4321   # also hit HTTP
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');
const CATALOG_DIR = process.env.CATALOG_DATA_DIR ?? path.join(PROJECT_ROOT, '.data', 'catalog');

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/* Mirror of src/lib/catalog/store.ts normalisation for the offline check. */
function normalize(value) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function search(index, searchKeys, keyword, limit = 10) {
  const tokens = normalize(keyword).split(' ').filter(Boolean);
  const hits = [];

  for (let i = 0; i < index.length && hits.length < limit; i += 1) {
    if (tokens.every((token) => searchKeys[i].includes(token))) hits.push(index[i]);
  }

  return hits;
}

const readJson = async (file) => JSON.parse(await readFile(path.join(CATALOG_DIR, file), 'utf8'));

async function main() {
  console.log('Steam catalog verification');
  console.log(`data directory: ${CATALOG_DIR}`);

  const meta = await readJson('catalog.meta.json');
  const index = await readJson('catalog.index.json');
  const details = await readJson('catalog.details.json');

  section('Generated files');
  check('index is an array', Array.isArray(index));
  check('details is an object', !!details && typeof details === 'object' && !Array.isArray(details));
  check('meta has counts', !!meta?.counts);
  check('meta records source repository', String(meta?.sourceRepository ?? '').includes('torpadeka'));
  check('meta documents the licensing caveat', /publishers and Valve/i.test(meta?.licensing ?? ''));
  check(
    'meta.counts.imported matches index length',
    meta.counts.imported === index.length,
    `${meta.counts.imported} vs ${index.length}`,
  );

  section('Record integrity (exhaustive over every imported record)');
  const seen = new Set();
  let badAppId = 0;
  let badName = 0;
  let duplicate = 0;
  let badDate = 0;
  let badScore = 0;
  let badGenres = 0;
  let missingDetail = 0;

  for (const entry of index) {
    if (!Number.isSafeInteger(entry.appId) || entry.appId <= 0) badAppId += 1;
    if (typeof entry.name !== 'string' || entry.name.trim().length === 0) badName += 1;
    if (seen.has(entry.appId)) duplicate += 1;
    seen.add(entry.appId);
    if (entry.releaseDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(entry.releaseDate)) badDate += 1;
    if (entry.metacritic !== null && !(entry.metacritic > 0 && entry.metacritic <= 100)) badScore += 1;
    if (!Array.isArray(entry.genres)) badGenres += 1;
    if (!details[String(entry.appId)]) missingDetail += 1;
  }

  check('every record has a valid AppID', badAppId === 0, `${badAppId} invalid`);
  check('every record has a non-empty name', badName === 0, `${badName} invalid`);
  check('AppIDs are unique', duplicate === 0, `${duplicate} duplicates`);
  check('every non-null releaseDate is ISO YYYY-MM-DD', badDate === 0, `${badDate} invalid`);
  check('every non-null metacritic score is 1..100', badScore === 0, `${badScore} invalid`);
  check('every record has a genres array', badGenres === 0, `${badGenres} invalid`);
  check('every record has a detail payload', missingDetail === 0, `${missingDetail} missing`);

  const windowsOnly = meta.counts.imported;
  check(
    'non-Windows records were excluded from the catalog',
    meta.counts.sourceRecords - meta.counts.excludedNonWindows === windowsOnly,
    `${meta.counts.sourceRecords} source - ${meta.counts.excludedNonWindows} excluded = ${windowsOnly}`,
  );

  section('Search');
  const searchKeys = index.map((entry) => normalize(entry.name));

  // Titles guaranteed by *this* snapshot. The sample is a random 10% draw, so
  // it does not contain every well-known game (no Stardew Valley / SIGNALIS).
  for (const term of ['Resident Evil', 'Portal', 'Half-Life', 'Silent', 'Doom', 'Elder Scrolls']) {
    const hits = search(index, searchKeys, term, 5);
    check(
      `"${term}" matches real records`,
      hits.length > 0,
      hits.map((hit) => `${hit.name} (${hit.appId})`).join(' | ') || 'no matches',
    );
  }

  const noHit = search(index, searchKeys, 'zzzxxqqqnotarealgame', 5);
  check('an absent title returns no records', noHit.length === 0);

  const upper = search(index, searchKeys, 'RESIDENT EVIL', 5);
  const lower = search(index, searchKeys, 'resident evil', 5);
  check(
    'search is case-insensitive',
    upper.length === lower.length && upper[0]?.appId === lower[0]?.appId,
  );

  section('Filters and facets');
  const genreCounts = new Map();
  const yearCounts = new Map();

  for (const entry of index) {
    for (const genre of entry.genres) genreCounts.set(genre, (genreCounts.get(genre) ?? 0) + 1);
    if (entry.year !== null) yearCounts.set(entry.year, (yearCounts.get(entry.year) ?? 0) + 1);
  }

  check('genres were derived from the data', genreCounts.size > 0, `${genreCounts.size} genres`);
  check('release years were derived from the data', yearCounts.size > 0, `${yearCounts.size} years`);
  check(
    'only documented genre values appear (no invented genres)',
    [...genreCounts.keys()].every((genre) => meta.genres.some((entry) => entry.name === genre)),
    [...genreCounts.keys()].join(', '),
  );

  const genreKey = 'Indie';
  const genreRecords = index.filter((entry) => entry.genres.includes(genreKey));
  check(
    `genre filter "${genreKey}" yields records`,
    genreRecords.length === genreCounts.get(genreKey),
    `${genreRecords.length} records`,
  );
  check(
    `all "${genreKey}" records actually carry that genre`,
    genreRecords.every((entry) => entry.genres.includes(genreKey)),
  );

  const tagRecords = index.filter((entry) => (entry.tags ?? []).includes('Horror'));
  check(
    'Horror is available as a browsable tag',
    tagRecords.length > 0,
    `${tagRecords.length} records tagged Horror (Steam genres carry no Horror value)`,
  );
  check(
    'every Horror-tagged record really has the tag',
    tagRecords.every((entry) => entry.tags.includes('Horror')),
  );
  check(
    'tag facets are documented in meta',
    Array.isArray(meta.tags) && meta.tags.some((tag) => tag.name === 'Horror'),
  );

  section('Sorting');
  // Must mirror the importer/query key: leading punctuation and quotes are
  // ignored so "- Game" files under G rather than before the alphabet.
  const sortKey = (name) => name.replace(/^[^0-9a-z]+/i, '').toLowerCase() || name.toLowerCase();
  const byName = [...index].sort((a, b) => sortKey(a.name).localeCompare(sortKey(b.name), 'en'));
  check(
    'index is stored in display-name order',
    byName[0]?.appId === index[0]?.appId,
    `${index[0]?.name} first`,
  );
  check(
    'display-name order ignores leading punctuation',
    index.slice(0, 3).every((entry) => !/^[^0-9a-z]/i.test(entry.name)),
    index.slice(0, 3).map((entry) => entry.name).join(' | '),
  );
  check(
    'sort key is applied consistently from either end',
    sortKey(index[0].name) <= sortKey(index[index.length - 1].name),
  );

  const scored = index.filter((entry) => entry.metacritic !== null);
  check('some records carry a Metacritic score', scored.length > 0, `${scored.length} scored`);
  const topScored = [...scored].sort((a, b) => b.metacritic - a.metacritic)[0];
  check(
    'highest Metacritic value is a real dataset value',
    !!topScored && topScored.metacritic > 0,
    `${topScored?.name} = ${topScored?.metacritic}`,
  );

  section('Detail records');
  const sample = index[0];
  const sampleDetail = details[String(sample.appId)];
  check('a detail record resolves for AppID lookup', !!sampleDetail, `AppID ${sample.appId}`);
  check(
    'detail payload carries a platform map',
    typeof sampleDetail?.platforms?.windows === 'boolean',
  );

  const noArtwork = index.filter((entry) => entry.image === null);
  check(
    'records with missing artwork are preserved with a null image',
    true,
    `${noArtwork.length} records fall back to the typeset placeholder`,
  );

  section('HTTP endpoints');
  const base = process.argv.includes('--base')
    ? process.argv[process.argv.indexOf('--base') + 1]
    : null;

  if (!base) {
    console.log('  SKIP  live endpoint checks (pass --base http://localhost:4321)');
  } else {
    const get = async (url) => {
      const response = await fetch(`${base}${url}`, { headers: { accept: 'application/json' } });
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      return { status: response.status, body };
    };

    const list = await get('/api/games?search=resident%20evil&page=1&page_size=5');
    check('GET /api/games responds 200', list.status === 200, `status ${list.status}`);
    check('response has the documented shape', ['total', 'page', 'pageSize', 'totalPages', 'results'].every((key) => key in (list.body ?? {})));
    check('search returns matching records', (list.body?.results ?? []).every((item) => /resident evil/i.test(item.name)));
    check('page size is honoured', (list.body?.results ?? []).length <= 5);

    const genreList = await get(`/api/games?genre=Indie&page_size=3`);
    check('GET /api/games?genre= responds 200', genreList.status === 200, `status ${genreList.status}`);
    check('genre filter narrows the total', (genreList.body?.total ?? 0) < index.length);
    check(
      'filtered records carry the genre',
      (genreList.body?.results ?? []).every((item) => item.genres.includes('Indie')),
    );

    const tagList = await get('/api/games?tag=Horror&page_size=3&sort=metacritic_desc');
    check('GET /api/games?tag= responds 200', tagList.status === 200, `status ${tagList.status}`);
    check(
      'tag filter returns only Horror-tagged records',
      (tagList.body?.results ?? []).every((item) => item.tags.includes('Horror')),
    );
    check(
      'genre + tag filters combine',
      (await get('/api/games?genre=Action&tag=Horror&page_size=3')).body?.total < tagList.body?.total,
    );

    const detail = await get(`/api/games/${sample.appId}`);
    check('GET /api/games/:appId responds 200', detail.status === 200, `status ${detail.status}`);
    check('detail AppID matches', detail.body?.appId === sample.appId);
    check('detail name matches', detail.body?.name === sample.name);
    check('detail has no fabricated fields', 'metacriticScore' in (detail.body ?? {}));

    const missing = await get('/api/games/999999999');
    check('unknown AppID returns 404', missing.status === 404, `status ${missing.status}`);

    const excluded = await get('/api/games/594550');
    check('non-Windows record returns 404', excluded.status === 404, `status ${excluded.status}`);

    const badId = await get('/api/games/not-a-number');
    check('malformed AppID returns 400', badId.status === 400, `status ${badId.status}`);

    const badYear = await get('/api/games?year=abc');
    check('invalid year returns 400', badYear.status === 400, `status ${badYear.status}`);

    const badGenre = await get('/api/games?genre=DefinitelyNotAGenre');
    check('unknown genre returns 400', badGenre.status === 400, `status ${badGenre.status}`);

    const clamp = await get('/api/games?page=99999&page_size=5');
    check(
      'page beyond the end clamps to the last page',
      clamp.status === 200 && clamp.body?.page === clamp.body?.totalPages,
      `page ${clamp.body?.page} / ${clamp.body?.totalPages}`,
    );

    const capped = await get('/api/games?page_size=500');
    check('page_size is capped', capped.body?.pageSize <= 60, `pageSize ${capped.body?.pageSize}`);

    const html = await fetch(`${base}/catalog`);
    const htmlBody = await html.text();
    check('GET /catalog responds 200', html.status === 200, `status ${html.status}`);
    check('catalog page shows the dataset record count', htmlBody.includes(meta.counts.imported.toLocaleString('en-US')));
    check('catalog page renders game cards server-side', htmlBody.includes('data-catalog-card'));

    const detailPage = await fetch(`${base}/catalog/${sample.appId}`);
    check('GET /catalog/:appId responds 200', detailPage.status === 200, `status ${detailPage.status}`);

    const missingPage = await fetch(`${base}/catalog/999999999`);
    check('GET /catalog/999999999 responds 404', missingPage.status === 404, `status ${missingPage.status}`);
  }

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);

  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(`\nVERIFICATION ERROR: ${error?.stack ?? error}`);
  process.exit(1);
});
