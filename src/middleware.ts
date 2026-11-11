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

  // Issue a CSRF token when the browser does not have one yet. A page that only
  // reads never needs it, but issuing it here keeps forms working on first visit
  // without an extra round-trip.
  //
  // Skipped on prerendered pages: there is no live request there, and touching
  // `Astro.request.headers` during prerendering only produces a build warning.
  const isPrerendered = context.isPrerendered;

  if (!isPrerendered) {
    const hasToken = context.cookies.get(CSRF_COOKIE)?.value;

    if (!hasToken && context.request.method === 'GET') {
      // Appended manually rather than via `cookies.set()`: that helper defaults
      // to HttpOnly, which would make the double-submit token unreadable by the
      // page script and break every mutation. One header, HttpOnly=false.
      response.headers.append(
        'Set-Cookie',
        csrfCookie(newCsrfToken(), context.url.protocol === 'https:'),
      );
    }
  }

  return response;
});
