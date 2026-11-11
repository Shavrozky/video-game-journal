/**
 * POST /api/library/preview — render Markdown to sanitised HTML.
 *
 * Used by the Field Log editor so the live preview uses exactly the same
 * pipeline as the published page (marked + sanitize-html). Read-only: no
 * database writes, but it is still POST-only so it cannot be triggered by a
 * plain link.
 */

import type { APIRoute } from 'astro';

import { renderMarkdown } from '../../../lib/server/markdown';
import { json, readJsonBody } from '../../../lib/server/http';

export const prerender = false;

const MAX_PREVIEW = 200_000;

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await readJsonBody(request, MAX_PREVIEW + 1024);
    const markdown = typeof body.markdown === 'string' ? body.markdown : '';

    if (markdown.length > MAX_PREVIEW) {
      return json({ error: 'Konten terlalu panjang untuk pratinjau.' }, 413);
    }

    return json({ html: renderMarkdown(markdown) });
  } catch {
    return json({ error: 'Payload tidak valid.' }, 400);
  }
};
