/**
 * Personal Library API Client
 *
 * Handles:
 * - CSRF double-submit cookie/header
 * - JSON requests and responses
 * - Structured API errors
 * - Library change notifications
 */

export interface ApiError extends Error {
  status: number;
  body: Record<string, unknown>;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
  body?: unknown;
  signal?: AbortSignal;
}

const CSRF_COOKIE = "journal_csrf";
const CSRF_HEADER = "x-journal-csrf";

function readCookie(name: string): string | null {
  if (typeof document === "undefined") {
    return null;
  }

  const prefix = `${encodeURIComponent(name)}=`;

  const cookie = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));

  if (!cookie) return null;

  try {
    return decodeURIComponent(cookie.slice(prefix.length));
  } catch {
    return null;
  }
}

function createApiError(
  message: string,
  status: number,
  body: Record<string, unknown> = {},
): ApiError {
  const error = new Error(message) as ApiError;

  error.name = "ApiError";
  error.status = status;
  error.body = body;

  return error;
}

/**
 * Returns the CSRF header required by the server.
 *
 * The middleware must issue the journal_csrf cookie
 * before any mutation request.
 */
export function csrfHeaders(): Record<string, string> {
  const token = readCookie(CSRF_COOKIE);

  if (!token) {
    return {};
  }

  return {
    [CSRF_HEADER]: token,
  };
}

export function notifyLibraryChanged(
  detail: Record<string, unknown> = {},
): void {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(new CustomEvent("library:changed", { detail }));
}

async function parseJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const data: unknown = await response.json();

    if (data !== null && typeof data === "object" && !Array.isArray(data)) {
      return data as Record<string, unknown>;
    }

    return {};
  } catch {
    return {};
  }
}

export async function apiRequest<T = Record<string, unknown>>(
  url: string,
  options: RequestOptions = {},
): Promise<T> {
  const method = (options.method ?? "GET").toUpperCase();

  const isMutation = method !== "GET";

  const headers: Record<string, string> = {
    accept: "application/json",
  };

  if (isMutation) {
    headers["content-type"] = "application/json";

    let csrfToken = readCookie(CSRF_COOKIE);

    if (!csrfToken) {
      try {
        await fetch("/api/library/games", {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
        });
        csrfToken = readCookie(CSRF_COOKIE);
      } catch {
        // Fall through to error check below
      }
    }

    if (!csrfToken) {
      throw createApiError(
        "Token keamanan CSRF belum tersedia. " +
          "Muat ulang halaman lalu coba kembali.",
        403,
        {
          error: "CSRF_COOKIE_MISSING",
        },
      );
    }

    headers[CSRF_HEADER] = csrfToken;
  }

  let response: Response;

  try {
    response = await fetch(url, {
      method,
      headers,
      credentials: "same-origin",
      cache: "no-store",
      signal: options.signal,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }

    throw createApiError(
      "Tidak dapat menghubungi server. " + "Pastikan Astro masih berjalan.",
      0,
      {
        error: "NETWORK_ERROR",
      },
    );
  }

  const payload = await parseJson(response);

  if (!response.ok) {
    const message =
      typeof payload.error === "string"
        ? payload.error
        : `Permintaan gagal (HTTP ${response.status}).`;

    throw createApiError(message, response.status, payload);
  }

  return payload as T;
}
