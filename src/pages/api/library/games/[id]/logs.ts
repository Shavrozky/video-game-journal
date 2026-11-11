/**
 * GET  /api/library/games/[id]/logs  — list logs for one game
 * POST /api/library/games/[id]/logs  — create a log (draft by default)
 */

import type { APIRoute } from 'astro';

import { getGameById } from '../../../../../lib/server/library-repository';
import { createLog, listLogsForGame } from '../../../../../lib/server/field-log-repository';
import { errorResponse, ensureDatabase, guardWrite, json, readId, readJsonBody } from '../../../../../lib/server/http';

export const prerender = false;

export const GET: APIRoute = async ({ params }) => {
  ensureDatabase();

  const id = readId(params.id);
  if (!id) return json({ error: 'ID tidak valid.' }, 400);

  const game = getGameById(id);
  if (!game) return json({ error: 'Game tidak ditemukan.' }, 404);

  return json({ gameId: id, results: listLogsForGame(id) });
};

export const POST: APIRoute = async ({ params, request }) => {
  ensureDatabase();

  const id = readId(params.id);
  if (!id) return json({ error: 'ID tidak valid.' }, 400);

  const guard = guardWrite(request);
  if (!guard.ok) return guard.response;

  try {
    const body = await readJsonBody(request);

    const log = createLog({
      personalGameId: id,
      title: body.title,
      sessionDate: body.sessionDate,
      durationMinutes: body.durationMinutes,
      playerCondition: body.playerCondition,
      mood: body.mood,
      contentMarkdown: body.contentMarkdown,
      publicationStatus: body.publicationStatus,
    });

    return json({ message: 'Field Log dibuat.', log }, 201, guard.headers);
  } catch (error) {
    return errorResponse(error, 'POST /api/library/games/[id]/logs');
  }
};
