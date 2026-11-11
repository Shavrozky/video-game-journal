/**
 * GET    /api/library/logs/[id]  — read one log
 * PATCH  /api/library/logs/[id]  — update (save draft / publish)
 * DELETE /api/library/logs/[id]  — delete after explicit confirmation
 */

import type { APIRoute } from 'astro';

import { deleteLog, getLogWithGame, updateLog } from '../../../../lib/server/field-log-repository';
import { errorResponse, ensureDatabase, guardWrite, json, readId, readJsonBody } from '../../../../lib/server/http';

export const prerender = false;

export const GET: APIRoute = async ({ params }) => {
  ensureDatabase();

  const id = readId(params.id);
  if (!id) return json({ error: 'ID tidak valid.' }, 400);

  const log = getLogWithGame(id);
  if (!log) return json({ error: 'Field Log tidak ditemukan.' }, 404);

  // Drafts are private to the owner; this route is localhost-gated by middleware.
  return json({ log });
};

export const PATCH: APIRoute = async ({ params, request }) => {
  ensureDatabase();

  const id = readId(params.id);
  if (!id) return json({ error: 'ID tidak valid.' }, 400);

  const guard = guardWrite(request);
  if (!guard.ok) return guard.response;

  try {
    const body = await readJsonBody(request);

    const log = updateLog(id, {
      title: body.title,
      sessionDate: body.sessionDate,
      durationMinutes: body.durationMinutes,
      playerCondition: body.playerCondition,
      mood: body.mood,
      contentMarkdown: body.contentMarkdown,
      publicationStatus: body.publicationStatus,
    });

    return json({ message: 'Field Log diperbarui.', log }, 200, guard.headers);
  } catch (error) {
    return errorResponse(error, 'PATCH /api/library/logs/[id]');
  }
};

export const DELETE: APIRoute = async ({ params, request }) => {
  ensureDatabase();

  const id = readId(params.id);
  if (!id) return json({ error: 'ID tidak valid.' }, 400);

  const guard = guardWrite(request);
  if (!guard.ok) return guard.response;

  try {
    const { removed } = deleteLog(id);
    return json({ message: 'Field Log dihapus.', removed }, 200, guard.headers);
  } catch (error) {
    return errorResponse(error, 'DELETE /api/library/logs/[id]');
  }
};
