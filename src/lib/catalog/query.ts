/**
 * Pure query engine for the local Steam catalog.
 *
 * Kept free of Astro imports so it can be exercised directly from a script
 * (see scripts/catalog/verify.mjs) as well as from API routes.
 */

import {
  DEFAULT_PAGE_SIZE,
  DEFAULT_SORT,
  MAX_PAGE_SIZE,
  isSortKey,
  steamStoreUrl,
  type CatalogGameSummary,
  type SortKey,
} from '../../data/catalog/types';
import type { CatalogDataset } from './store';

export interface CatalogQuery {
  search: string;
  genre: string;
  /** Optional community tag, e.g. "Horror". Combined with `genre` (AND). */
  tag: string;
  /** Single year; the catalog UI only offers one at a time. */
  year: number | null;
  sort: SortKey;
  page: number;
  pageSize: number;
}

export interface CatalogQueryResult {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  results: CatalogGameSummary[];
}

export interface QueryIssue {
  parameter: string;
  message: string;
}

const MAX_LENGTH = {
  search: 120,
  genre: 60,
  tag: 40,
};

function firstValue(value: string | null): string {
  if (!value) return '';
  return value.trim();
}

/** Alphabetical key that ignores leading quotes, punctuation and whitespace. */
function displaySortKey(name: string): string {
  return name.replace(/^[^0-9a-z]+/i, '').toLowerCase() || name.toLowerCase();
}

/**
 * Parse + validate raw search params. Never throws: unparseable values fall
 * back to defaults, and hard violations are reported in `issues`.
 */
export function parseCatalogQuery(params: URLSearchParams): {
  query: CatalogQuery;
  issues: QueryIssue[];
} {
  const issues: QueryIssue[] = [];

  let search = firstValue(params.get('search'));

  if (search.length > MAX_LENGTH.search) {
    search = search.slice(0, MAX_LENGTH.search);
    issues.push({
      parameter: 'search',
      message: `Truncated to ${MAX_LENGTH.search} characters.`,
    });
  }

  let genre = firstValue(params.get('genre'));

  if (genre.length > MAX_LENGTH.genre) {
    genre = genre.slice(0, MAX_LENGTH.genre);
    issues.push({
      parameter: 'genre',
      message: `Truncated to ${MAX_LENGTH.genre} characters.`,
    });
  }

  let tag = firstValue(params.get('tag'));

  if (tag.length > MAX_LENGTH.tag) {
    tag = tag.slice(0, MAX_LENGTH.tag);
    issues.push({
      parameter: 'tag',
      message: `Truncated to ${MAX_LENGTH.tag} characters.`,
    });
  }

  const rawYear = firstValue(params.get('year'));
  let year: number | null = null;

  if (rawYear && rawYear.toLowerCase() !== 'all') {
    const parsed = Number(rawYear);

    if (!Number.isInteger(parsed) || parsed < 1970 || parsed > 2100) {
      issues.push({ parameter: 'year', message: 'Expected an integer year between 1970 and 2100.' });
    } else {
      year = parsed;
    }
  }

  const rawSort = firstValue(params.get('sort'));
  let sort: SortKey = DEFAULT_SORT;

  if (rawSort) {
    if (isSortKey(rawSort)) {
      sort = rawSort;
    } else {
      issues.push({
        parameter: 'sort',
        message: 'Unsupported sort key. Using the default sort.',
      });
    }
  }

  const rawPage = firstValue(params.get('page'));
  let page = 1;

  if (rawPage) {
    const parsed = Number(rawPage);

    if (!Number.isInteger(parsed) || parsed < 1) {
      issues.push({ parameter: 'page', message: 'Expected a positive integer. Using page 1.' });
    } else {
      page = parsed;
    }
  }

  const rawPageSize = firstValue(params.get('page_size'));
  let pageSize = DEFAULT_PAGE_SIZE;

  if (rawPageSize) {
    const parsed = Number(rawPageSize);

    if (!Number.isInteger(parsed) || parsed < 1) {
      issues.push({ parameter: 'page_size', message: 'Expected a positive integer. Using the default.' });
    } else if (parsed > MAX_PAGE_SIZE) {
      pageSize = MAX_PAGE_SIZE;
      issues.push({
        parameter: 'page_size',
        message: `Capped at ${MAX_PAGE_SIZE}.`,
      });
    } else {
      pageSize = parsed;
    }
  }

  return {
    query: { search, genre, tag, year, sort, page, pageSize },
    issues,
  };
}

function toSummary(
  entry: CatalogDataset['index'][number],
  summaryCache?: Map<number, CatalogGameSummary>,
): CatalogGameSummary {
  if (summaryCache) {
    const cached = summaryCache.get(entry.appId);
    if (cached) return cached;
  }

  const summary: CatalogGameSummary = {
    appId: entry.appId,
    name: entry.name,
    releaseDate: entry.releaseDate,
    releaseYear: entry.year,
    headerImage: entry.image,
    genres: entry.genres,
    tags: entry.tags ?? [],
    metacriticScore: entry.metacritic,
    positiveReviews: entry.positive,
    negativeReviews: entry.negative,
    steamUrl: steamStoreUrl(entry.appId),
  };

  summaryCache?.set(entry.appId, summary);
  return summary;
}

const summaryCache = new WeakMap<CatalogDataset, Map<number, CatalogGameSummary>>();

function cacheFor(catalog: CatalogDataset) {
  let cache = summaryCache.get(catalog);

  if (!cache) {
    cache = new Map();
    summaryCache.set(catalog, cache);
  }

  return cache;
}

/** Every token in the query must appear somewhere in the title. */
function matchesSearch(searchKey: string, tokens: string[]): boolean {
  for (const token of tokens) {
    if (!searchKey.includes(token)) return false;
  }

  return true;
}

function compare(a: CatalogGameSummary, b: CatalogGameSummary, sort: SortKey): number {
  switch (sort) {
    case 'name_desc':
      return displaySortKey(b.name).localeCompare(displaySortKey(a.name), 'en');
    case 'release_desc':
    case 'release_asc': {
      // Records without a date always sort last, regardless of direction.
      if (!a.releaseDate && !b.releaseDate) return displaySortKey(a.name).localeCompare(displaySortKey(b.name), 'en');
      if (!a.releaseDate) return 1;
      if (!b.releaseDate) return -1;

      const delta = a.releaseDate.localeCompare(b.releaseDate);
      return sort === 'release_desc' ? -delta : delta;
    }
    case 'metacritic_desc': {
      // Only the dataset's real Metacritic values participate; unscored last.
      if (a.metacriticScore === null && b.metacriticScore === null)
        return displaySortKey(a.name).localeCompare(displaySortKey(b.name), 'en');
      if (a.metacriticScore === null) return 1;
      if (b.metacriticScore === null) return -1;

      return (
        b.metacriticScore - a.metacriticScore ||
        displaySortKey(a.name).localeCompare(displaySortKey(b.name), 'en')
      );
    }
    case 'reviews_desc': {
      const votesA = (a.positiveReviews ?? 0) + (a.negativeReviews ?? 0);
      const votesB = (b.positiveReviews ?? 0) + (b.negativeReviews ?? 0);
      return votesB - votesA || displaySortKey(a.name).localeCompare(displaySortKey(b.name), 'en');
    }
    case 'name_asc':
    default:
      return displaySortKey(a.name).localeCompare(displaySortKey(b.name), 'en');
  }
}

export function queryCatalog(catalog: CatalogDataset, query: CatalogQuery): CatalogQueryResult {
  const tokens = query.search
    .split(/\s+/)
    .map((token) => token.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase())
    .map((token) => token.replace(/[^a-z0-9]+/g, ' ').trim())
    .filter(Boolean);

  const genreKey = query.genre.toLowerCase();
  const tagKey = query.tag.toLowerCase();
  const cache = cacheFor(catalog);

  const matched: CatalogGameSummary[] = [];

  for (let i = 0; i < catalog.index.length; i += 1) {
    const entry = catalog.index[i];

    if (query.year !== null && entry.year !== query.year) continue;

    if (genreKey && !entry.genres.some((genre) => genre.toLowerCase() === genreKey)) continue;

    if (tagKey && !(entry.tags ?? []).some((tag) => tag.toLowerCase() === tagKey)) continue;

    if (tokens.length > 0 && !matchesSearch(catalog.searchKeys[i], tokens)) continue;

    matched.push(toSummary(entry, cache));
  }

  // The generated index is already name-sorted, so name_asc costs nothing.
  if (query.sort !== 'name_asc') {
    matched.sort((a, b) => compare(a, b, query.sort));
  }

  const total = matched.length;
  const pageSize = query.pageSize;
  const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);

  // Clamp instead of returning an empty page past the end.
  const page = totalPages === 0 ? 1 : Math.min(query.page, totalPages);
  const start = (page - 1) * pageSize;

  return {
    total,
    page,
    pageSize,
    totalPages,
    results: matched.slice(start, start + pageSize),
  };
}
