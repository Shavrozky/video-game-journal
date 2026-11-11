/**
 * Browser-side helper for library mutations.
 *
 * Centralises:
 * - the CSRF double-submit header (read from the cookie the middleware issues),
 * - JSON encoding,
 * - turning non-2xx responses into thrown errors carrying `status` + `body`,
 * - a `library:changed` event so independent widgets (catalog buttons, stats)
 *   can react without knowing about each other.
 *
 * Imported by page <script> blocks; Astro bundles it as a shared chunk.
 */

export interface ApiError extends Error {
  status: number;
  body: Record<string, unknown>;
}

export function readCookie(name: string): string | null {
  const prefix = `${name}=`;
  for (const part of document.cookie.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) return decodeURIComponent(trimmed.slice(prefix.length));
  }
  return null;
}

export function csrfHeaders(): Record<string, string> {
  const token = readCookie('journal_csrf');
  return token ? { 'x-journal-csrf': token } : {};
}

export function notifyLibraryChanged(detail: Record<string, unknown> = {}): void {
  window.dispatchEvent(new CustomEvent('library:changed', { detail }));
}

async function parseJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
  body?: unknown;
  signal?: AbortSignal;
}

export async function apiRequest<T = Record<string, unknown>>(
  url: string,
  options: RequestOptions = {},
): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };

  if (method !== 'GET') {
    headers['content-type'] = 'application/json';
    Object.assign(headers, csrfHeaders());
  }

  const response = await fetch(url, {
    method,
    headers,
    signal: options.signal,
    credentials: 'same-origin',
    cache: 'no-store',
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const payload = await parseJson(response);

  if (!response.ok) {
    const error = new Error(
      typeof payload.error === 'string' ? payload.error : `Permintaan gagal (HTTP ${response.status}).`,
    ) as ApiError;
    error.status = response.status;
    error.body = payload;
    throw error;
  }

  return payload as T;
}
