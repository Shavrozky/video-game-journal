#!/usr/bin/env node
/**
 * Steam Games Dataset -> local catalog ETL.
 *
 * Source: https://github.com/torpadeka/steam-games-dataset (games_sample10.json)
 *
 * Output (generated, never hand edited):
 *   .data/catalog/catalog.index.json    compact browse/search index
 *   .data/catalog/catalog.details.json  per-AppID detail payload
 *   .data/catalog/catalog.meta.json     import statistics + provenance
 *
 * Usage:
 *   npm run catalog:import
 *   npm run catalog:import -- --source ./games_sample10.json
 *   npm run catalog:import -- --force-download
 *   npm run catalog:import -- --refresh   # keep local raw copy if present
 *
 * No third-party dependencies. Node >= 22.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const SOURCE_URL =
  'https://raw.githubusercontent.com/torpadeka/steam-games-dataset/main/games_sample10.json';
const SOURCE_REPO = 'https://github.com/torpadeka/steam-games-dataset';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');
const RAW_DIR = path.join(PROJECT_ROOT, '.data', 'raw');
const RAW_FILE = path.join(RAW_DIR, 'games_sample10.json');
const OUT_DIR = path.join(PROJECT_ROOT, '.data', 'catalog');

const MIN_VALID_DATASET_BYTES = 1_000_000; // a real snapshot is ~77 MB
const MAX_NAME = 200;
const MAX_DESCRIPTION = 420;
/** A tag becomes a browsable facet only when this many records carry it. */
const MIN_TAG_FACET_COUNT = 40;

/* ------------------------------------------------------------------ */
/* CLI                                                                */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const options = {
    source: null,
    forceDownload: false,
    refresh: false,
    outDir: OUT_DIR,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--source') {
      options.source = argv[i + 1] ? path.resolve(argv[i + 1]) : null;
      i += 1;
    } else if (arg.startsWith('--source=')) {
      options.source = path.resolve(arg.slice('--source='.length));
    } else if (arg === '--force-download') {
      options.forceDownload = true;
    } else if (arg === '--refresh') {
      options.refresh = true;
    } else if (arg === '--out') {
      options.outDir = path.resolve(argv[i + 1] ?? OUT_DIR);
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      fail(`Unknown argument: ${arg}\nRun with --help for usage.`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`
Steam catalog import

  npm run catalog:import                     download (if needed) + import
  npm run catalog:import -- --source <file>  import an already downloaded JSON
  npm run catalog:import -- --refresh        re-download and re-import
  npm run catalog:import -- --out <dir>      override generated data directory

Environment:
  CATALOG_SOURCE       same as --source
  CATALOG_DATA_DIR     override generated data directory
`);
}

function fail(message) {
  console.error(`\n[catalog:import] ERROR\n${message}\n`);
  process.exit(1);
}

const log = (message) => console.log(`[catalog:import] ${message}`);

/* ------------------------------------------------------------------ */
/* Download                                                           */
/* ------------------------------------------------------------------ */

async function fileSize(file) {
  try {
    const info = await stat(file);
    return info.size;
  } catch {
    return 0;
  }
}

async function download(url, destination) {
  log(`downloading ${url}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'game-journal-catalog-import/1.0' },
      redirect: 'follow',
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(destination, buffer);
    log(`downloaded ${(buffer.length / 1_048_576).toFixed(1)} MB`);
    return buffer.length;
  } finally {
    clearTimeout(timeout);
  }
}

/* ------------------------------------------------------------------ */
/* Raw validation                                                     */
/* ------------------------------------------------------------------ */

async function readRawDataset(file) {
  const size = await fileSize(file);

  if (!size) {
    fail(
      `Dataset not found at ${file}\n` +
        `Download it manually from:\n  ${SOURCE_URL}\n` +
        `then run: npm run catalog:import -- --source "${file}"`,
    );
  }

  const buffer = await readFile(file);
  const head = buffer.subarray(0, 512).toString('utf8').trimStart();

  if (head.startsWith('<')) {
    fail(
      `The downloaded file is HTML, not JSON (likely a login page or an error page).\n` +
        `Delete ${file} and download the dataset manually from:\n  ${SOURCE_URL}`,
    );
  }

  if (head.startsWith('version https://git-lfs')) {
    fail(
      `The downloaded file is a Git LFS pointer, not the dataset itself.\n` +
        `Download the real JSON from:\n  ${SOURCE_URL}`,
    );
  }

  if (size < MIN_VALID_DATASET_BYTES) {
    fail(
      `The dataset is unexpectedly small (${size} bytes).\n` +
        `Expected roughly 77 MB. Download it manually from:\n  ${SOURCE_URL}`,
    );
  }

  let parsed;

  try {
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    fail(
      `The dataset is not valid JSON: ${error.message}\n` +
        `Delete ${file} and re-download from:\n  ${SOURCE_URL}`,
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('The dataset root is not an AppID-keyed object.');
  }

  return { parsed, size, buffer };
}

/* ------------------------------------------------------------------ */
/* Normalization                                                      */
/* ------------------------------------------------------------------ */

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  const text = value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text;
}

function cleanList(value, maxItems, maxLength = 80) {
  if (!Array.isArray(value)) return [];

  const seen = new Set();
  const result = [];

  for (const item of value) {
    const text = cleanText(item, maxLength);
    if (!text) continue;

    const key = text.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    result.push(text);

    if (result.length >= maxItems) break;
  }

  return result;
}

/** "Feb 26, 2016" -> { iso: "2016-02-26", year: 2016 } */
function parseReleaseDate(value) {
  if (typeof value !== 'string') return { iso: null, year: null };

  const match = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})$/.exec(value.trim());
  if (!match) return { iso: null, year: null };

  const month = MONTHS[match[1].toLowerCase()];
  const day = Number(match[2]);
  const year = Number(match[3]);

  if (!month || !Number.isInteger(day) || day < 1 || day > 31) return { iso: null, year: null };
  if (!Number.isInteger(year) || year < 1970 || year > 2100) return { iso: null, year: null };

  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { iso, year };
}

function toHttpUrl(value) {
  if (typeof value !== 'string') return null;
  const url = value.trim();
  if (!/^https?:\/\/[^\s]+$/i.test(url)) return null;
  return url.replace(/^http:\/\//i, 'https://');
}

function toScore(value) {
  const score = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(score)) return null;
  const rounded = Math.round(score);
  if (rounded <= 0 || rounded > 100) return null; // dataset uses 0 for "no score"
  return rounded;
}

function toCount(value) {
  const count = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(count) || count < 0) return null;
  return Math.round(count);
}

function toPrice(value) {
  const price = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(price) || price < 0 || price > 10_000) return null;
  return Math.round(price * 100) / 100;
}

function topTags(tags, max) {
  if (!tags || typeof tags !== 'object' || Array.isArray(tags)) return [];

  return Object.entries(tags)
    .filter(([name, votes]) => cleanText(name, 40) && Number.isFinite(Number(votes)))
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, max)
    .map(([name]) => cleanText(name, 40));
}

/** Alphabetical key that ignores leading quotes, punctuation and whitespace. */
function displaySortKey(name) {
  return name.replace(/^[^0-9a-z]+/i, '').toLowerCase() || name.toLowerCase();
}

/* ------------------------------------------------------------------ */
/* Transform                                                          */
/* ------------------------------------------------------------------ */

function buildCatalog(dataset) {
  const index = [];
  const details = {};
  const genreCounts = new Map();
  const tagCounts = new Map();

  let invalid = 0;
  let excluded = 0;
  let missingReleaseDate = 0;
  let missingImage = 0;

  for (const [rawKey, record] of Object.entries(dataset)) {
    const appId = Number(rawKey);

    if (!Number.isInteger(appId) || appId <= 0) {
      invalid += 1;
      continue;
    }

    if (!record || typeof record !== 'object') {
      invalid += 1;
      continue;
    }

    const name = cleanText(record.name, MAX_NAME);

    if (!name) {
      invalid += 1;
      continue;
    }

    // Platform filter: catalog is a PC game catalog.
    if (record.windows !== true) {
      excluded += 1;
      continue;
    }

    const { iso, year } = parseReleaseDate(record.release_date);
    if (!iso) missingReleaseDate += 1;

    const image = toHttpUrl(record.header_image);
    if (!image) missingImage += 1;

    const genres = cleanList(record.genres, 8, 40);
    for (const genre of genres) genreCounts.set(genre, (genreCounts.get(genre) ?? 0) + 1);

    // Steam's `genres` array is very coarse (20 values, no "Horror"), so the
    // highest-voted community tags are kept as a second browsable dimension.
    const tags = topTags(record.tags, 6);
    for (const tag of tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);

    const positive = toCount(record.positive);
    const negative = toCount(record.negative);

    index.push({
      appId,
      name,
      releaseDate: iso,
      year,
      image,
      genres,
      tags,
      metacritic: toScore(record.metacritic_score),
      positive,
      negative,
    });

    details[appId] = {
      description: cleanText(record.short_description, MAX_DESCRIPTION),
      developers: cleanList(record.developers, 5, 80),
      publishers: cleanList(record.publishers, 5, 80),
      price: toPrice(record.price),
      platforms: {
        windows: record.windows === true,
        mac: record.mac === true,
        linux: record.linux === true,
      },
      tags: topTags(record.tags, 8),
    };
  }

  // Sort on a display key that ignores leading punctuation/quotes, so
  // "- Mischief Dungeon" files under M instead of ahead of the alphabet.
  // The key is deliberately NOT persisted: `query.ts` recomputes it.
  index.sort((a, b) => displaySortKey(a.name).localeCompare(displaySortKey(b.name), 'en'));

  return {
    index,
    details,
    stats: {
      invalid,
      excluded,
      missingReleaseDate,
      missingImage,
      genreCounts: [...genreCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => ({ name, count })),
      // Only tags broad enough to be useful as a filter are exposed.
      tagCounts: [...tagCounts.entries()]
        .filter(([, count]) => count >= MIN_TAG_FACET_COUNT)
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => ({ name, count })),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Write                                                              */
/* ------------------------------------------------------------------ */

async function writeAtomic(file, contents) {
  const temporary = `${file}.tmp`;
  await writeFile(temporary, contents);
  await rename(temporary, file);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const explicitSource = options.source ?? process.env.CATALOG_SOURCE ?? null;
  const outDir = options.outDir ?? process.env.CATALOG_DATA_DIR ?? OUT_DIR;

  await mkdir(RAW_DIR, { recursive: true });
  await mkdir(outDir, { recursive: true });

  let rawFile;
  let downloadedBytes = null;

  if (explicitSource) {
    rawFile = path.resolve(explicitSource);
    log(`using dataset from --source ${rawFile}`);
  } else {
    rawFile = RAW_FILE;
    const existing = await fileSize(rawFile);

    if (options.refresh || options.forceDownload || existing < MIN_VALID_DATASET_BYTES) {
      try {
        downloadedBytes = await download(SOURCE_URL, rawFile);
      } catch (error) {
        const hint =
          `\nDownload the dataset manually from:\n  ${SOURCE_URL}\n` +
          `Save it as:\n  ${RAW_FILE}\n` +
          `or run: npm run catalog:import -- --source <path-to-games_sample10.json>`;

        if (existing >= MIN_VALID_DATASET_BYTES) {
          console.warn(
            `[catalog:import] download failed (${error.message}); keeping cached copy at ${rawFile}`,
          );
        } else {
          fail(`Download failed: ${error.message}${hint}`);
        }
      }
    } else {
      log(`using cached dataset ${rawFile} (${(existing / 1_048_576).toFixed(1)} MB)`);
    }
  }

  const { parsed, size, buffer } = await readRawDataset(rawFile);
  const checksum = createHash('sha256').update(buffer).digest('hex');

  log(`source records: ${Object.keys(parsed).length}`);

  const started = Date.now();
  const { index, details, stats } = buildCatalog(parsed);
  const elapsed = Date.now() - started;

  const generatedAt = new Date().toISOString();

  const meta = {
    dataset: 'steam-games-dataset/games_sample10.json',
    sourceUrl: SOURCE_URL,
    sourceRepository: SOURCE_REPO,
    sourceBytes: downloadedBytes ?? size,
    sourceSha256: checksum,
    generatedAt,
    generator: 'scripts/catalog/import.mjs',
    licensing:
      'Repository scraper code is MIT licensed. Game metadata belongs to the respective publishers and Valve, and the upstream README states it is intended for research purposes only.',
    counts: {
      sourceRecords: Object.keys(parsed).length,
      imported: index.length,
      invalid: stats.invalid,
      excludedNonWindows: stats.excluded,
      missingReleaseDate: stats.missingReleaseDate,
      missingImage: stats.missingImage,
    },
    genres: stats.genreCounts,
    tags: stats.tagCounts,
    releaseYearRange:
      index.length > 0
        ? {
            min: Math.min(...index.map((game) => game.year).filter((year) => year !== null)),
            max: Math.max(...index.map((game) => game.year).filter((year) => year !== null)),
          }
        : { min: null, max: null },
  };

  const indexPath = path.join(outDir, 'catalog.index.json');
  const detailsPath = path.join(outDir, 'catalog.details.json');
  const metaPath = path.join(outDir, 'catalog.meta.json');

  await writeAtomic(indexPath, JSON.stringify(index));
  await writeAtomic(detailsPath, JSON.stringify(details));
  await writeAtomic(metaPath, `${JSON.stringify(meta, null, 2)}\n`);

  const [indexSize, detailsSize] = await Promise.all([fileSize(indexPath), fileSize(detailsPath)]);

  log('');
  log('IMPORT COMPLETE');
  log(`  source records     : ${meta.counts.sourceRecords}`);
  log(`  imported (PC)      : ${meta.counts.imported}`);
  log(`  excluded (non-PC)  : ${meta.counts.excludedNonWindows}`);
  log(`  invalid records    : ${meta.counts.invalid}`);
  log(`  missing release    : ${meta.counts.missingReleaseDate}`);
  log(`  missing artwork    : ${meta.counts.missingImage}`);
  log(`  genres             : ${meta.genres.length}`);
  log(`  years              : ${meta.releaseYearRange.min} - ${meta.releaseYearRange.max}`);
  log(`  index              : ${(indexSize / 1_048_576).toFixed(2)} MB -> ${indexPath}`);
  log(`  details            : ${(detailsSize / 1_048_576).toFixed(2)} MB -> ${detailsPath}`);
  log(`  transform time     : ${elapsed} ms`);
  log('');
  log(`Run "npm run dev" and open http://localhost:4321/catalog`);
}

main().catch((error) => fail(error?.stack ?? String(error)));
