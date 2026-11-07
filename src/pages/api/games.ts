/**
 * GET /api/games
 *
 * Local, read-only catalog search. Backed entirely by the generated snapshot in
 * `.data/catalog/` — no RAWG / IGDB / SteamSpy / CheapShark / Steam API calls.
 *
 * Query parameters
 *   search      string   title search (case- and accent-insensitive, multi-token AND)
 *   page        integer  1-based page number (clamped to the last page)
 *   page_size   integer  results per page, default 24, max 60
 *   genre       string   exact genre name, case-insensitive
 *   tag         string   exact community tag, case-insensitive (e.g. Horror)
 *   year        integer  release year
 *   sort        string   name_asc | name_desc | release_desc | release_asc
 *                        | metacritic_desc | reviews_desc
 *
 * Response 200
 *   { total, page, pageSize, totalPages, results: CatalogGameSummary[],
 *     appliedFilters, availableGenres, availableTags, availableYears, dataset }
 *
 * Response 400  { error, issues }
 * Response 503  { error }   local dataset has not been imported yet
 */

import type { APIRoute } from 'astro';

import { getCatalog } from '../../lib/catalog/store';
import { parseCatalogQuery, queryCatalog } from '../../lib/catalog/query';

export const prerender = false;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=60',
    },
  });

export const GET: APIRoute = async ({ url }) => {
  const catalog = await getCatalog();

  if (catalog.status !== 'ready') {
    return json(
      {
        error: 'Catalog dataset unavailable',
        detail: catalog.error ?? 'Run "npm run catalog:import" to generate it.',
      },
      503,
    );
  }

  const { query, issues } = parseCatalogQuery(url.searchParams);

  // Only genuinely unusable values are rejected; unknown sort keys fall back.
  const fatal = issues.filter((issue) => issue.parameter === 'year');

  if (fatal.length > 0) {
    return json(
      {
        error: 'Invalid query parameter',
        issues,
      },
      400,
    );
  }

  if (query.genre) {
    const knownGenre = catalog.genres.some(
      (genre) => genre.name.toLowerCase() === query.genre.toLowerCase(),
    );

    if (!knownGenre) {
      return json(
        {
          error: 'Unknown genre',
          issues: [{ parameter: 'genre', message: `"${query.genre}" is not in this dataset.` }],
          availableGenres: catalog.genres.map((genre) => genre.name),
        },
        400,
      );
    }
  }

  if (query.tag) {
    const knownTag = catalog.tags.some((tag) => tag.name.toLowerCase() === query.tag.toLowerCase());

    if (!knownTag) {
      return json(
        {
          error: 'Unknown tag',
          issues: [{ parameter: 'tag', message: `"${query.tag}" is not a filterable tag in this dataset.` }],
          availableTags: catalog.tags.map((tag) => tag.name),
        },
        400,
      );
    }
  }

  const result = queryCatalog(catalog, query);

  return json({
    ...result,
    appliedFilters: {
      search: query.search || null,
      genre: query.genre || null,
      tag: query.tag || null,
      year: query.year,
      sort: query.sort,
    },
    ...(issues.length > 0 ? { issues } : {}),
    availableGenres: catalog.genres,
    availableTags: catalog.tags,
    availableYears: catalog.years,
    dataset: {
      records: catalog.meta?.counts.imported ?? catalog.index.length,
      generatedAt: catalog.meta?.generatedAt ?? null,
      source: catalog.meta?.sourceRepository ?? null,
    },
  });
};
