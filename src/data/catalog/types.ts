/**
 * Types for the local Steam catalog.
 *
 * These are generated from the upstream Steam Games Dataset snapshot by
 * `scripts/catalog/import.mjs`. Nothing here calls an external API.
 */

/** Full record, returned by GET /api/games/[appId]. */
export interface SteamCatalogGame {
  /** Steam AppID — the unique identifier for every catalog record. */
  appId: number;
  name: string;
  /** ISO `YYYY-MM-DD`, or null when the dataset had no usable date. */
  releaseDate: string | null;
  releaseYear: number | null;
  /** Steam CDN header image, or null when the dataset had none. */
  headerImage: string | null;
  genres: string[];
  developers: string[];
  publishers: string[];
  shortDescription: string;
  /** Store price in USD as recorded in the snapshot. Null when unavailable. */
  price: number | null;
  /** Only ever set when the dataset's `metacritic_score` field is > 0. */
  metacriticScore: number | null;
  positiveReviews: number | null;
  negativeReviews: number | null;
  platforms: {
    windows: boolean;
    mac: boolean;
    linux: boolean;
  };
  steamUrl: string;
  /** Highest-voted community tags from the snapshot, when present. */
  tags: string[];
}

/**
 * Compact record used for list endpoints and catalog cards.
 * Deliberately excludes long text so 11k records stay cheap to index and ship.
 */
export interface CatalogGameSummary {
  appId: number;
  name: string;
  releaseDate: string | null;
  releaseYear: number | null;
  headerImage: string | null;
  genres: string[];
  /** Top community tags from the snapshot (display only). */
  tags: string[];
  metacriticScore: number | null;
  positiveReviews: number | null;
  negativeReviews: number | null;
  steamUrl: string;
}

/** Generated browse index — one entry per imported PC game. */
export interface CatalogIndexEntry {
  appId: number;
  name: string;
  releaseDate: string | null;
  year: number | null;
  image: string | null;
  genres: string[];
  /** Highest-voted community tags; the browsable second dimension. */
  tags: string[];
  metacritic: number | null;
  positive: number | null;
  negative: number | null;
}

/** Generated detail payload, keyed by AppID in `catalog.details.json`. */
export interface CatalogDetailEntry {
  description: string;
  developers: string[];
  publishers: string[];
  price: number | null;
  platforms: { windows: boolean; mac: boolean; linux: boolean };
  tags: string[];
}

export interface CatalogMeta {
  dataset: string;
  sourceUrl: string;
  sourceRepository: string;
  sourceBytes: number;
  sourceSha256: string;
  generatedAt: string;
  generator: string;
  licensing: string;
  counts: {
    sourceRecords: number;
    imported: number;
    invalid: number;
    excludedNonWindows: number;
    missingReleaseDate: number;
    missingImage: number;
  };
  genres: Array<{ name: string; count: number }>;
  /** Tags broad enough to act as a filter dimension. */
  tags: Array<{ name: string; count: number }>;
  releaseYearRange: { min: number | null; max: number | null };
}

export const SORT_OPTIONS = [
  { value: 'name_asc', label: 'Name A → Z' },
  { value: 'name_desc', label: 'Name Z → A' },
  { value: 'release_desc', label: 'Release — Newest' },
  { value: 'release_asc', label: 'Release — Oldest' },
  { value: 'metacritic_desc', label: 'Metacritic — Highest' },
  { value: 'reviews_desc', label: 'Most Reviewed' },
] as const;

export type SortKey = (typeof SORT_OPTIONS)[number]['value'];

export const DEFAULT_SORT: SortKey = 'name_asc';
export const DEFAULT_PAGE_SIZE = 24;
export const MAX_PAGE_SIZE = 60;

export function isSortKey(value: string | null): value is SortKey {
  return !!value && SORT_OPTIONS.some((option) => option.value === value);
}

export function steamStoreUrl(appId: number): string {
  return `https://store.steampowered.com/app/${appId}/`;
}
