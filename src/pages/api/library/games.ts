/**
 * GET  /api/library/games   — list personal games (filters + sort)
 * POST /api/library/games   — add a game (Steam AppID or manual entry)
 *
 * POST resolves Steam metadata server-side from the local catalog: the client
 * only ever sends the AppID. A client-supplied title is used only for manual
 * entries, which by definition have no catalog record.
 */

import type { APIRoute } from 'astro';

import {
  addSteamGame,
  createManualGame,
  findSimilarGames,
  listGames,
  ValidationError,
} from '../../../lib/server/library-repository';
import { errorResponse, ensureDatabase, guardWrite, json, readJsonBody } from '../../../lib/server/http';
import { isLibraryOrder, type LibraryOrder } from '../../../data/library/types';
import { getGame as getCatalogGame } from '../../../lib/catalog/store';

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
  ensureDatabase();

  const params = url.searchParams;

  const orderParam = params.get('order');
  const order: LibraryOrder = isLibraryOrder(orderParam) ? orderParam : 'recent';

  const games = listGames({
    search: params.get('search')?.trim() || undefined,
    platform: params.get('platform')?.trim() || null,
    status: params.get('status')?.trim() || null,
    priority: params.get('priority')?.trim() || null,
    order,
  });

  return json({ total: games.length, results: games });
};

export const POST: APIRoute = async ({ request }) => {
  ensureDatabase();

  const guard = guardWrite(request);
  if (!guard.ok) return guard.response;

  try {
    const body = await readJsonBody(request);

    // ---- Steam-sourced ------------------------------------------------
    if (body.steamAppId !== undefined) {
      const appId = typeof body.steamAppId === 'number' ? body.steamAppId : Number(body.steamAppId);

      if (!Number.isSafeInteger(appId) || appId <= 0) {
        throw new ValidationError('steamAppId', 'Steam AppID tidak valid.');
      }

      // Authoritative metadata comes from the local catalog, not the client.
      const catalogGame = await getCatalogGame(appId);

      if (!catalogGame) {
        return json(
          { error: 'Game tidak ditemukan pada katalog Steam lokal.' },
          404,
        );
      }

      const game = addSteamGame({
        steamAppId: appId,
        title: catalogGame.name,
        platform: 'PC',
        genre: catalogGame.genres[0] ?? null,
        coverUrl: catalogGame.headerImage,
        releaseYear: catalogGame.releaseYear,
      });

      return json({ message: 'Game ditambahkan ke Personal Library.', game }, 201, guard.headers);
    }

    // ---- Manual -------------------------------------------------------
    const game = createManualGame({
      title: body.title,
      platform: body.platform,
      franchise: body.franchise,
      releaseYear: body.releaseYear,
      genre: body.genre,
      coverUrl: body.coverUrl,
      status: body.status,
      priority: body.priority,
      notes: body.notes,
    });

    return json({ message: 'Catatan game manual dibuat.', game }, 201, guard.headers);
  } catch (error) {
    return errorResponse(error, 'POST /api/library/games');
  }
};

/** Duplicate-title probe used by the manual-entry form before saving. */
export const PUT: APIRoute = async ({ request }) => {
  ensureDatabase();

  try {
    const body = await readJsonBody(request);
    const title = typeof body.title === 'string' ? body.title : '';
    const similar = findSimilarGames(title);

    return json({
      title,
      matches: similar.map((game) => ({
        id: game.id,
        title: game.title,
        platform: game.platform,
        source: game.source,
        steamAppId: game.steamAppId,
      })),
    });
  } catch (error) {
    return errorResponse(error, 'PUT /api/library/games');
  }
};
