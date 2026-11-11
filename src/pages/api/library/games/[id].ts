/**
 * GET    /api/library/games/[id]  — single personal game
 * PATCH  /api/library/games/[id]  — update personal fields
 * DELETE /api/library/games/[id]  — remove (refuses when Field Logs exist)
 *
 * DELETE accepts `?deleteLogs=true` to explicitly cascade. Without it, a game
 * that still has logs returns 409 listing them, so journal content is never
 * lost by accident.
 */

import type { APIRoute } from 'astro';

import {
  ConflictError,
  NotFoundError,
  getGameById,
  removeGame,
  updateGame,
} from '../../../../lib/server/library-repository';
import { deleteLogsForGame, listLogsForGame } from '../../../../lib/server/field-log-repository';
import { errorResponse, ensureDatabase, guardWrite, json, readId, readJsonBody } from '../../../../lib/server/http';
import { transaction } from '../../../../lib/server/db';

export const prerender = false;

export const GET: APIRoute = async ({ params }) => {
  ensureDatabase();

  const id = readId(params.id);
  if (!id) return json({ error: 'ID tidak valid.' }, 400);

  const game = getGameById(id);
  if (!game) return json({ error: 'Game tidak ditemukan.' }, 404);

  return json({ game, logs: listLogsForGame(id) });
};

export const PATCH: APIRoute = async ({ params, request }) => {
  ensureDatabase();

  const id = readId(params.id);
  if (!id) return json({ error: 'ID tidak valid.' }, 400);

  const guard = guardWrite(request);
  if (!guard.ok) return guard.response;

  try {
    const body = await readJsonBody(request);
    const game = updateGame(id, body);

    return json({ message: 'Perubahan disimpan.', game }, 200, guard.headers);
  } catch (error) {
    return errorResponse(error, 'PATCH /api/library/games/[id]');
  }
};

export const DELETE: APIRoute = async ({ params, request, url }) => {
  ensureDatabase();

  const id = readId(params.id);
  if (!id) return json({ error: 'ID tidak valid.' }, 400);

  const guard = guardWrite(request);
  if (!guard.ok) return guard.response;

  const deleteLogs = url.searchParams.get('deleteLogs') === 'true';

  try {
    const game = getGameById(id);
    if (!game) throw new NotFoundError('Game tidak ditemukan.');

    if (deleteLogs) {
      const removed = transaction((db) => {
        const count = deleteLogsForGame(id, db);
        const result = removeGame(id);
        return { logs: count, ...result };
      });

      return json(
        { message: `Game dan ${removed.logs} Field Log dihapus.`, removed: removed.removed, logsDeleted: removed.logs },
        200,
        guard.headers,
      );
    }

    const { removed } = removeGame(id);
    return json({ message: 'Game dihapus dari Personal Library.', removed }, 200, guard.headers);
  } catch (error) {
    if (error instanceof ConflictError) {
      return json({ error: error.message, ...error.details }, 409, guard.headers);
    }
    return errorResponse(error, 'DELETE /api/library/games/[id]');
  }
};


