# Video Game Field Journal

A personal, notebook-styled game journal built with Astro. Two archives live
side by side and are intentionally **not** the same thing:

| Route | What it is | Data source |
| --- | --- | --- |
| `/` | Field Logs — personal play-session notes | `src/content/journal/*.md` |
| `/backlog` | Backlog Shelf — personal registry | `src/data/backlog.ts` |
| `/games/[id]` | Personal game profile (per backlog entry) | `src/data/backlog.ts` |
| `/journal/[slug]` | A single Field Log / curated note | `src/content/journal/*.md` |
| `/catalog` | **PC Game Database** — global reference catalog | local Steam dataset snapshot |
| `/catalog/[appId]` | One catalog record | local Steam dataset snapshot |
| `/api/games` | Catalog search/filter API (JSON) | local Steam dataset snapshot |
| `/api/games/[appId]` | Single catalog record (JSON) | local Steam dataset snapshot |

The global catalog never marks a game as played, never writes to the backlog,
and never replaces journal content.

---

## Getting started

```sh
npm install
npm run catalog:import    # build the local catalog snapshot (once)
npm run dev               # http://localhost:4321/catalog
```

Useful checks:

```sh
npx astro check                                  # types
npm run build                                    # production build
npm run catalog:verify                           # offline data checks
npm run catalog:verify -- --base http://localhost:4321   # + live API/route checks
```

---

## The catalog

### Data source and licensing

Records come from a local snapshot of
**[torpadeka/steam-games-dataset](https://github.com/torpadeka/steam-games-dataset)**
(`games_sample10.json`, a random 10% sample of a December 2025 Steam scrape,
11,130 records).

> **Licensing caveat.** The upstream *scraper code* is MIT licensed. The game
> metadata itself belongs to the respective publishers and Valve, and the
> upstream README states the dataset is intended **for research purposes
> only**. This project does not describe the dataset as unrestricted
> MIT-licensed content, and the catalog is presented as a reference archive.

### Architecture

```
Steam Games Dataset (GitHub, ~77 MB)
        │
        ▼
scripts/catalog/import.mjs          ETL: validate → normalize → compact files
        │
        ▼
.data/catalog/catalog.index.json    compact browse/search index
.data/catalog/catalog.details.json  per-AppID detail payload
.data/catalog/catalog.meta.json     counts, facets, provenance, checksum
        │
        ├──▶ src/lib/catalog/store.ts    loads once per server process
        ├──▶ src/lib/catalog/query.ts    search / filter / sort / paginate
        │
        ├──▶ /api/games                  JSON API
        └──▶ /catalog, /catalog/[appId]  SSR pages
```

Nothing in the raw 77 MB file is ever sent to the browser. The generated files
are plain JSON loaded once into module scope by the server, which is more than
fast enough for ~11k records — no database, cache server, or extra backend.

The raw download and all generated files live under `.data/` and are
**git-ignored**, so generated output never mixes with handwritten project data.

### Import

```sh
npm run catalog:import                        # download if needed, then import
npm run catalog:import -- --source <file>     # use an already downloaded copy
npm run catalog:import -- --refresh           # re-download and re-import
npm run catalog:import -- --out <dir>         # alternate output directory
```

Environment overrides: `CATALOG_SOURCE`, `CATALOG_DATA_DIR`.

The importer:

- validates the file is real JSON — it rejects HTML error pages, Git LFS
  pointers, truncated files and invalid JSON with an actionable message;
- parses the AppID-keyed object and normalizes every record;
- keeps only Windows-compatible records (the catalog is a PC catalog);
- drops invalid records (missing/zero AppID, missing name);
- truncates long descriptions, strips HTML/movies/screenshots/packages, and
  keeps only the top 6 community tags per record;
- writes atomically (`*.tmp` + rename) and is **idempotent** — re-running
  produces byte-identical output, with no duplicates;
- reports imported, excluded and invalid counts.

If the download fails it keeps a valid cached copy when present; otherwise it
exits with instructions for importing a manually downloaded file.

### Normalized schema

`src/data/catalog/types.ts` — `SteamCatalogGame` is the detail shape returned by
`/api/games/[appId]`; `CatalogGameSummary` is the list shape.

Missing data is represented as `null` (never invented). `metacriticScore` is
only ever populated from the dataset's `metacritic_score` field, and only when
it is greater than 0 — the dataset uses `0` to mean "no score".

### Genres vs tags

Steam's own `genres` array is coarse — only 20 values, and it has **no Horror
genre**. Because tags like `Horror` (544 records) and `Psychological Horror`
(281) are what actually describe this library, the importer also keeps the
highest-voted community tags and exposes tags matching ≥40 records as a second
filter dimension. `genre` and `tag` can be combined (AND).

---

## Local API

No authentication, no external requests, no API keys. Read-only.

### `GET /api/games`

| Param | Type | Notes |
| --- | --- | --- |
| `search` | string | title search; case- and accent-insensitive, multi-token AND |
| `page` | integer | 1-based; clamped to the last page |
| `page_size` | integer | default 24, max 60 |
| `genre` | string | exact genre, case-insensitive |
| `tag` | string | exact community tag, case-insensitive |
| `year` | integer | release year |
| `sort` | string | `name_asc` (default), `name_desc`, `release_desc`, `release_asc`, `metacritic_desc`, `reviews_desc` |

```sh
curl "http://localhost:4321/api/games?search=resident%20evil&page=1&page_size=20"
```

```json
{
  "total": 3,
  "page": 1,
  "pageSize": 20,
  "totalPages": 1,
  "results": [
    {
      "appId": 304240,
      "name": "Resident Evil",
      "releaseDate": "2015-01-19",
      "releaseYear": 2015,
      "headerImage": "https://shared.akamai.steamstatic.com/.../header.jpg",
      "genres": ["Action", "Adventure"],
      "tags": ["Survival Horror", "Zombies", "Horror", "Classic", "Remake", "Atmospheric"],
      "metacriticScore": 82,
      "positiveReviews": 25013,
      "negativeReviews": 1754,
      "steamUrl": "https://store.steampowered.com/app/304240/"
    }
  ],
  "appliedFilters": { "search": "resident evil", "genre": null, "tag": null, "year": null, "sort": "name_asc" },
  "availableGenres": [{ "name": "Indie", "count": 8018 }],
  "availableTags": [{ "name": "Horror", "count": 544 }],
  "availableYears": [2025, 2024],
  "dataset": { "records": 11129, "generatedAt": "...", "source": "https://github.com/torpadeka/steam-games-dataset" }
}
```

Status codes: `200` ok · `400` invalid parameter (bad `year`, unknown `genre`
or `tag`) · `503` dataset not imported yet.

### `GET /api/games/[appId]`

```sh
curl "http://localhost:4321/api/games/304240"
```

Returns a `SteamCatalogGame`. `400` for a non-numeric AppID, `404` for an AppID
that is not in the local dataset (including the records excluded for not
supporting Windows), `503` when the dataset has not been imported.

---

## Notes on the UI

- `/catalog` is server-rendered on demand by the Node adapter, so the first
  page works without JavaScript and the page is not pre-built per query.
- Cards are server-rendered for the first page and rebuilt client-side from the
  same JSON shape afterwards; both use the `.catalog-card*` classes in
  `src/styles/global.css` so they stay identical.
- Search is debounced (250 ms); a request token discards stale responses so a
  slow earlier query can never overwrite a newer one.
- Listeners are attached to the freshly rendered root and guarded with a
  `data-wired` flag, so ClientRouter navigations cannot stack duplicates.
- Missing artwork falls back to a typeset placeholder, both when the dataset has
  no `header_image` and when the CDN image fails at runtime.
- `/catalog/[appId]` is a different route from the personal `/games/[id]`;
  the personal profile pages are untouched.

### Future: Add to Backlog

The catalog and the backlog are deliberately separate. Catalog records already
carry the Steam `appId` needed to link a backlog entry later, but there is no
"Add to Backlog" button — a non-functional control would be misleading. When
that feature is built, the link should be stored on the backlog entry (e.g. an
optional `steamAppId` field in `src/data/backlog.ts`) rather than importing
catalog rows into the personal registry.

---

## License

Project code: see the repository. Steam metadata: see the licensing caveat
above — publishers and Valve, research use only.
