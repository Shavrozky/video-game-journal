/**
 * Global middleware.
 *
 * Responsibilities:
 * - Ensure the SQLite schema exists and the legacy backlog is seeded (idempotent).
 * - Issue the double-submit CSRF cookie on page loads so client scripts can echo
 *   it back on mutations.
 * - Keep personal data off the wire: `Cache-Control: no-store` on private routes.
 */

import { defineMiddleware } from 'astro:middleware';

import { ensureDatabase } from './lib/server/http';
import { CSRF_COOKIE, csrfCookie, newCsrfToken } from './lib/server/write-guard';

/** Routes whose HTML must never be cached by a proxy. */
function isPrivateRoute(pathname: string): boolean {
  return (
    pathname === '/backlog' ||
    pathname.startsWith('/library') ||
    pathname.startsWith('/api/library')
  );
}

export const onRequest = defineMiddleware(async (context, next) => {
  // Runs once per process; no-op afterwards.
  ensureDatabase();

  const response = await next();

  if (isPrivateRoute(context.url.pathname)) {
    response.headers.set('Cache-Control', 'no-store, must-revalidate');
    // The personal library must not be indexed or embedded by other origins.
    response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  }

  // Issue or refresh the CSRF token on GET requests so client scripts can echo
  // it back on mutations. Re-issuing on GET ensures existing sessions with the
  // previous stale HttpOnly cookie get overwritten with a script-readable cookie.
  //
  // Skipped on prerendered pages: there is no live request there, and touching
  // `Astro.request.headers` during prerendering only produces a build warning.
  const isPrerendered = context.isPrerendered;

  if (!isPrerendered && context.request.method === 'GET') {
    const existingToken = context.cookies.get(CSRF_COOKIE)?.value;
    const token = existingToken || newCsrfToken();

    response.headers.append(
      'Set-Cookie',
      csrfCookie(token, context.url.protocol === 'https:'),
    );
  }

  return response;
});
