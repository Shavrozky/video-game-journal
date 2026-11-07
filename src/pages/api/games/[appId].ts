/**
 * GET /api/games/[appId]
 *
 * Returns one normalized catalog record.
 *
 * Response 200  SteamCatalogGame
 * Response 400  { error }   appId is not a positive integer
 * Response 404  { error }   AppID not present in the local dataset
 * Response 503  { error }   local dataset has not been imported yet
 */

import type { APIRoute } from 'astro';

import { getCatalog, getGame } from '../../../lib/catalog/store';

export const prerender = false;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=300',
    },
  });

export const GET: APIRoute = async ({ params }) => {
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

  const raw = params.appId ?? '';
  const appId = Number(raw);

  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(appId) || appId <= 0) {
    return json(
      {
        error: 'Invalid AppID',
        detail: `"${raw}" is not a positive integer Steam AppID.`,
      },
      400,
    );
  }

  const game = await getGame(appId);

  if (!game) {
    return json(
      {
        error: 'Game not found',
        detail: `AppID ${appId} is not present in the local catalog dataset.`,
        appId,
      },
      404,
    );
  }

  return json(game);
};
