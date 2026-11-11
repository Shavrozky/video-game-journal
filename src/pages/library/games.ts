import type { APIRoute } from "astro";
import { randomUUID } from "node:crypto";

import {
  db,
  findSteamGame,
  getPersonalGames,
} from "../../lib/server/personal-db";

export const prerender = false;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function isLocalDevelopment(request: Request): boolean {
  const hostname = new URL(request.url).hostname;

  return (
    import.meta.env.DEV && ["localhost", "127.0.0.1", "::1"].includes(hostname)
  );
}

export const GET: APIRoute = async ({ request }) => {
  if (!isLocalDevelopment(request)) {
    return json(
      { error: "Personal Library hanya tersedia di localhost." },
      403,
    );
  }

  return json({
    results: getPersonalGames(),
  });
};

export const POST: APIRoute = async ({ request }) => {
  if (!isLocalDevelopment(request)) {
    return json({ error: "Penulisan Library dinonaktifkan." }, 403);
  }

  const origin = request.headers.get("origin");

  if (origin) {
    try {
      if (new URL(origin).origin !== new URL(request.url).origin) {
        return json({ error: "Origin tidak diizinkan." }, 403);
      }
    } catch {
      return json({ error: "Origin tidak valid." }, 403);
    }
  }

  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  ) {
    return json({ error: "Content-Type harus application/json." }, 415);
  }

  let body: Record<string, unknown>;

  try {
    const parsed: unknown = await request.json();

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return json({ error: "Payload tidak valid." }, 400);
    }

    body = parsed as Record<string, unknown>;
  } catch {
    return json({ error: "JSON tidak valid." }, 400);
  }

  const steamAppId = body.steamAppId;

  const title = typeof body.title === "string" ? body.title.trim() : "";

  if (
    typeof steamAppId !== "number" ||
    !Number.isSafeInteger(steamAppId) ||
    steamAppId <= 0
  ) {
    return json({ error: "Steam AppID tidak valid." }, 400);
  }

  if (!title || title.length > 200) {
    return json({ error: "Judul game tidak valid." }, 400);
  }

  const existing = findSteamGame(steamAppId);

  if (existing) {
    return json(
      {
        error: "Game sudah berada di Backlog.",
        game: existing,
      },
      409,
    );
  }

  let coverUrl: string | null = null;

  if (typeof body.coverUrl === "string" && body.coverUrl.length <= 2000) {
    try {
      const parsed = new URL(body.coverUrl);

      if (parsed.protocol === "https:") {
        coverUrl = parsed.href;
      }
    } catch {
      // Abaikan URL cover tidak valid.
    }
  }

  const id = randomUUID();
  const now = new Date().toISOString();

  try {
    db.prepare(
      `
      INSERT INTO personal_games (
        id,
        source,
        steam_app_id,
        title,
        platform,
        cover_url,
        status,
        created_at,
        updated_at
      )
      VALUES (?, 'steam', ?, ?, 'PC', ?, 'Queued', ?, ?)
    `,
    ).run(id, steamAppId, title, coverUrl, now, now);

    return json(
      {
        message: "Game berhasil ditambahkan.",
        game: findSteamGame(steamAppId),
      },
      201,
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE constraint")) {
      return json({ error: "Game sudah berada di Backlog." }, 409);
    }

    console.error("[Personal Library]", error);

    return json({ error: "Gagal menyimpan game." }, 500);
  }
};
