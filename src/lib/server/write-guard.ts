/**
 * Write-path protection for the personal library.
 *
 * Threat model: this is a single-user local journal, but it will eventually sit
 * behind a reverse proxy or be port-forwarded by accident. Writes must therefore
 * fail closed unless one of these is true:
 *
 *   1. `JOURNAL_ALLOW_WRITES=true` is set explicitly (opt-in, for a trusted
 *      private deployment) — still requires a same-origin request and a CSRF
 *      token, but drops the localhost-only restriction.
 *   2. The request is a genuine same-origin request AND the server is bound to
 *      localhost (dev server `astro dev`, or a local `node dist/server/entry.mjs`).
 *
 * `JOURNAL_REQUIRE_REMOTE_AUTH=true` (default when NODE_ENV=production) makes
 * the check stricter: writes are refused outright, because no authentication
 * layer exists yet. That is deliberate — an unauthenticated public write endpoint
 * would let anyone edit or delete the journal.
 *
 * Note: Origin/Referer checks and CSRF tokens defend against *cross-site* request
 * forgery. They are NOT authentication. They do not stop a same-origin attacker
 * who already controls the browser.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

export const CSRF_COOKIE = 'journal_csrf';
export const CSRF_HEADER = 'x-journal-csrf';

export type WriteDecision =
  | { allowed: true }
  | { allowed: false; status: number; error: string };

/**
 * Hosts considered local. `.localhost` covers the browser's IPv6 loopback
 * resolution quirks without opening anything routable.
 */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return LOCAL_HOSTNAMES.has(host) || host.endsWith('.localhost');
}

function hostnameOfOrigin(origin: string): string | null {
  try {
    return new URL(origin).hostname;
  } catch {
    return null;
  }
}

/**
 * Decide whether a mutation may proceed.
 *
 * `request` is the incoming Request; `originHeader` is read from it so callers
 * cannot forget to pass it.
 */
export function evaluateWriteAccess(request: Request): WriteDecision {
  const explicitOptIn = process.env.JOURNAL_ALLOW_WRITES === 'true';
  const requireAuth = process.env.JOURNAL_REQUIRE_REMOTE_AUTH === 'true';
  const isProduction = process.env.NODE_ENV === 'production';

  const requestUrl = new URL(request.url);
  const origin = request.headers.get('origin');
  const referer = request.headers.get('referer');
  const site = request.headers.get('sec-fetch-site');

  // --- 1. Same-origin enforcement -----------------------------------------
  // A browser always sends Origin on cross-origin POST/PATCH/DELETE. If it is
  // present and disagrees, this is a cross-site attempt.
  if (origin) {
    if (hostnameOfOrigin(origin) === null) {
      return { allowed: false, status: 403, error: 'Origin tidak valid.' };
    }
    if (!sameOrigin(origin, requestUrl)) {
      return { allowed: false, status: 403, error: 'Origin tidak diizinkan.' };
    }
  } else if (referer) {
    const refererHost = hostnameOfOrigin(referer);
    if (!refererHost || !isSameHost(refererHost, requestUrl.hostname)) {
      return { allowed: false, status: 403, error: 'Referer tidak diizinkan.' };
    }
  }

  // `sec-fetch-site` is browser-supplied and unspoofable from a page context.
  if (site && !['same-origin', 'none'].includes(site)) {
    return { allowed: false, status: 403, error: 'Permintaan lintas situs ditolak.' };
  }

  // --- 2. CSRF token ------------------------------------------------------
  // Double-submit: the page receives the cookie, the script echoes it back in a
  // header. A cross-site attacker can neither read the cookie nor set the header.
  if (!hasValidCsrfToken(request)) {
    return { allowed: false, status: 403, error: 'Token CSRF tidak valid atau tidak ada.' };
  }

  // --- 3. Environment gate ------------------------------------------------
  if (isProduction && requireAuth && !explicitOptIn) {
    return {
      allowed: false,
      status: 403,
      error:
        'Penulisan data dinonaktifkan pada deployment publik tanpa autentikasi. ' +
        'Set JOURNAL_ALLOW_WRITES=true hanya jika akses sudah dibatasi.',
    };
  }

  if (isProduction && !explicitOptIn) {
    // Production without any auth story: fail closed.
    return {
      allowed: false,
      status: 403,
      error:
        'Penulisan data dinonaktifkan pada mode produksi tanpa autentikasi. ' +
        'Jalankan secara lokal, atau set JOURNAL_ALLOW_WRITES=true di balik akses privat.',
    };
  }

  if (!explicitOptIn) {
    // Development: only accept writes whose Host is a loopback name.
    if (!isLocalHostname(requestUrl.hostname)) {
      return {
        allowed: false,
        status: 403,
        error: `Penulisan data hanya diizinkan dari localhost (Host: ${requestUrl.hostname}).`,
      };
    }
  }

  return { allowed: true };
}

function isSameHost(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function sameOrigin(origin: string, requestUrl: URL): boolean {
  try {
    const parsed = new URL(origin);
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    const requestPort = requestUrl.port || (requestUrl.protocol === 'https:' ? '443' : '80');

    return isSameHost(parsed.hostname, requestUrl.hostname) && port === requestPort;
  } catch {
    return false;
  }
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;

  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index === -1) continue;

    if (pair.slice(0, index).trim() === name) {
      return decodeURIComponent(pair.slice(index + 1).trim());
    }
  }

  return null;
}

export function hasValidCsrfToken(request: Request): boolean {
  const cookieToken = readCookie(request, CSRF_COOKIE);
  const headerToken = request.headers.get(CSRF_HEADER);

  if (!cookieToken || !headerToken) return false;
  if (cookieToken.length !== headerToken.length) return false;

  // Constant-time compare to avoid leaking the token via timing.
  try {
    return timingSafeEqual(Buffer.from(cookieToken), Buffer.from(headerToken));
  } catch {
    return false;
  }
}

export function newCsrfToken(): string {
  return randomBytes(32).toString('hex');
}

/** Serialised Set-Cookie value for the double-submit token. */
export function csrfCookie(token: string, secure: boolean): string {
  const parts = [
    `${CSRF_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'SameSite=Strict',
    'HttpOnly=false', // must be readable by the page script for the double-submit
    secure ? 'Secure' : '',
    'Max-Age=86400',
  ].filter(Boolean);

  return parts.join('; ');
}
