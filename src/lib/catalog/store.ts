/**
 * Server-only access to the generated Steam catalog snapshot.
 *
 * The import script writes three files under `.data/catalog/`:
 *   catalog.index.json    compact record per PC game (browse + search)
 *   catalog.details.json  per-AppID detail payload (long-ish text, companies)
 *   catalog.meta.json     import statistics + provenance
 *
 * They are loaded once per server process and cached in module scope, so a
 * catalog request never touches the raw 77 MB dataset and never hits the
 * network. Re-run `npm run catalog:import` to refresh; restart the server to
 * pick up new files.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  CatalogDetailEntry,
  CatalogIndexEntry,
  CatalogMeta,
  SteamCatalogGame,
} from '../../data/catalog/types';
import { steamStoreUrl } from '../../data/catalog/types';

export type CatalogStatus = 'ready' | 'missing';

export interface CatalogDataset {
  status: CatalogStatus;
  index: CatalogIndexEntry[];
  details: Record<string, CatalogDetailEntry>;
  meta: CatalogMeta | null;
  /** Lowercased, accent-stripped name per entry, aligned with `index`. */
  searchKeys: string[];
  /** AppID -> entry, so detail lookups stay O(1). */
  byAppId: Map<number, CatalogIndexEntry>;
  genres: Array<{ name: string; count: number }>;
  tags: Array<{ name: string; count: number }>;
  years: number[];
  /** Present only when status is 'missing'. */
  error?: string;
}

const EMPTY: CatalogDataset = {
  status: 'missing',
  index: [],
  details: {},
  meta: null,
  searchKeys: [],
  byAppId: new Map(),
  genres: [],
  tags: [],
  years: [],
};

function dataDirectory(): string {
  if (process.env.CATALOG_DATA_DIR) {
    return path.resolve(process.env.CATALOG_DATA_DIR);
  }

  // dist/server -> project root is two levels up when deployed from the repo.
  return path.join(process.cwd(), '.data', 'catalog');
}

export function normalizeSearchText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Precomputed lowercase index used by the query engine. */
function buildSearchKeys(index: CatalogIndexEntry[]): string[] {
  return index.map((game) => normalizeSearchText(game.name));
}

function buildFacets(index: CatalogIndexEntry[], meta: CatalogMeta | null) {
  const counts = new Map<string, number>();
  const tagCounts = new Map<string, number>();

  for (const game of index) {
    for (const genre of game.genres) {
      counts.set(genre, (counts.get(genre) ?? 0) + 1);
    }

    for (const tag of game.tags ?? []) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }

  const fromMeta = new Map((meta?.genres ?? []).map((genre) => [genre.name, genre.count]));
  const tagMeta = new Map((meta?.tags ?? []).map((tag) => [tag.name, tag.count]));

  const genres = [...counts.entries()]
    .map(([name, count]) => ({ name, count: fromMeta.get(name) ?? count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'en'));

  const tags = [...tagCounts.entries()]
    .map(([name, count]) => ({ name, count: tagMeta.get(name) ?? count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'en'));

  const years = [...new Set(index.map((game) => game.year).filter((year): year is number => year !== null))].sort(
    (a, b) => b - a,
  );

  return { genres, tags, years };
}

let cache: Promise<CatalogDataset> | null = null;

async function load(): Promise<CatalogDataset> {
  const dir = dataDirectory();

  try {
    const [indexRaw, detailsRaw, metaRaw] = await Promise.all([
      readFile(path.join(dir, 'catalog.index.json'), 'utf8'),
      readFile(path.join(dir, 'catalog.details.json'), 'utf8'),
      readFile(path.join(dir, 'catalog.meta.json'), 'utf8'),
    ]);

    const index = JSON.parse(indexRaw) as CatalogIndexEntry[];
    const details = JSON.parse(detailsRaw) as Record<string, CatalogDetailEntry>;
    const meta = JSON.parse(metaRaw) as CatalogMeta;

    if (!Array.isArray(index)) {
      throw new Error('catalog.index.json did not contain an array');
    }

    const { genres, tags, years } = buildFacets(index, meta);

    return {
      status: 'ready',
      index,
      details,
      meta,
      searchKeys: buildSearchKeys(index),
      byAppId: new Map(index.map((game) => [game.appId, game])),
      genres,
      tags,
      years,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    console.warn(
      `[catalog] local dataset not loaded from ${dir} (${reason}). ` +
        `Run "npm run catalog:import" to build it.`,
    );

    return {
      ...EMPTY,
      error: `Local catalog data is unavailable (${reason}). Run "npm run catalog:import".`,
    };
  }
}

export function getCatalog(): Promise<CatalogDataset> {
  cache ??= load();
  return cache;
}

/** Test hook: drop the in-memory snapshot so a rebuilt dataset is re-read. */
export function resetCatalogCache() {
  cache = null;
}

export async function getGame(appId: number): Promise<SteamCatalogGame | null> {
  const catalog = await getCatalog();
  const entry = catalog.byAppId.get(appId);

  if (!entry) return null;

  const detail = catalog.details[String(appId)];

  return {
    appId: entry.appId,
    name: entry.name,
    releaseDate: entry.releaseDate,
    releaseYear: entry.year,
    headerImage: entry.image,
    genres: entry.genres,
    developers: detail?.developers ?? [],
    publishers: detail?.publishers ?? [],
    shortDescription: detail?.description ?? '',
    price: detail?.price ?? null,
    metacriticScore: entry.metacritic,
    positiveReviews: entry.positive,
    negativeReviews: entry.negative,
    platforms: detail?.platforms ?? { windows: true, mac: false, linux: false },
    steamUrl: steamStoreUrl(entry.appId),
    tags: detail?.tags ?? [],
  };
}
