/**
 * Shared API helpers: JSON responses, body parsing, and a single place that
 * turns repository errors into HTTP status codes.
 *
 * Raw SQL errors never reach the client; unexpected failures are logged
 * server-side and returned as a generic 500.
 */

import { migrate } from './migrations';
import { seedLegacyBacklog } from './legacy-seed';
import { ConflictError, DuplicateError, NotFoundError, ValidationError } from './library-repository';
import { evaluateWriteAccess, newCsrfToken, csrfCookie, CSRF_COOKIE } from './write-guard';

/** Response header used only to bootstrap the token for non-JS clients. */
export const CSRF_HEADER_REFLECT = 'x-journal-csrf-issued';

let bootstrapped = false;

/**
 * Ensure the schema exists and the legacy backlog is seeded.
 *
 * Safe to call on every request: migrations are versioned and the seed is keyed
 * on `legacy_game_id`, so this is a no-op after the first run.
 */
export function ensureDatabase(): { seeded: boolean } {
  if (bootstrapped) return { seeded: false };

  migrate();
  const result = seedLegacyBacklog();
  bootstrapped = true;

  if (result.inserted > 0) {
    console.log(`[library] seeded ${result.inserted} legacy backlog record(s)`);
  }

  return { seeded: result.inserted > 0 };
}

export const NO_STORE = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
} as const;

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...NO_STORE, ...headers },
  });
}

export function jsonError(status: number, error: string, extra: Record<string, unknown> = {}): Response {
  return json({ error, ...extra }, status);
}

/** Parse a JSON body, rejecting non-objects and oversized payloads. */
export async function readJsonBody(
  request: Request,
  maxBytes = 512 * 1024,
): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type')?.toLowerCase() ?? '';

  if (!contentType.startsWith('application/json')) {
    throw new ValidationError('content-type', 'Content-Type harus application/json.');
  }

  const text = await request.text();

  if (text.length > maxBytes) {
    throw new ValidationError('body', 'Payload terlalu besar.');
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ValidationError('body', 'JSON tidak valid.');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ValidationError('body', 'Payload harus berupa objek JSON.');
  }

  return parsed as Record<string, unknown>;
}

export interface GuardResult {
  ok: true;
  headers: Record<string, string>;
}

/**
 * Apply write protection. Returns either an error Response or the headers to
 * merge into the success response (issuing a CSRF cookie when the client has
 * none yet, so a first-run form works without a separate bootstrap call).
 */
export function guardWrite(request: Request): GuardResult | { ok: false; response: Response } {
  const decision = evaluateWriteAccess(request);

  if (!decision.allowed) {
    return { ok: false, response: jsonError(decision.status, decision.error) };
  }

  const headers: Record<string, string> = {};

  // If the browser had no token yet (e.g. a server-rendered form POST before the
  // client script ran), issue one so the *next* request can succeed.
  if (!request.headers.get('cookie')?.includes(CSRF_COOKIE)) {
    const token = newCsrfToken();
    headers['Set-Cookie'] = csrfCookie(token, new URL(request.url).protocol === 'https:');
    headers[CSRF_HEADER_REFLECT] = token;
  }

  return { ok: true, headers };
}

/**
 * Convert a thrown repository error into a Response. Unknown errors are logged
 * and reported generically.
 */
export function errorResponse(error: unknown, context: string): Response {
  if (error instanceof ValidationError) {
    return jsonError(400, error.message, { field: error.field });
  }

  if (error instanceof NotFoundError) {
    return jsonError(404, error.message);
  }

  if (error instanceof DuplicateError) {
    return jsonError(409, error.message, { game: error.existing });
  }

  if (error instanceof ConflictError) {
    return jsonError(409, error.message, error.details);
  }

  // Never leak SQL text or stack traces to the client.
  console.error(`[library:${context}]`, error);

  return jsonError(500, 'Terjadi kesalahan pada server.');
}

/** Narrow an unknown route param to a plausible record id. */
export function readId(value: string | undefined): string | null {
  if (!value) return null;
  const id = value.trim();
  if (!id || id.length > 100) return null;
  return id;
}
