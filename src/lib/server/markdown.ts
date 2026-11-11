/**
 * Safe Markdown rendering.
 *
 * Journal content is authored by the app's own user, but it is still rendered
 * into HTML, so it is sanitised with an allow-list. Raw HTML in the source is
 * escaped by `marked` (we do not enable its `html` option), and the result is
 * additionally run through `sanitize-html` to strip any `javascript:` URLs,
 * `<script>`, inline event handlers, etc.
 */

import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

marked.setOptions({
  gfm: true,
  breaks: true,
});

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'br', 'hr',
    'strong', 'em', 'del', 's', 'code', 'pre', 'blockquote',
    'ul', 'ol', 'li',
    'a', 'img',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
  ],
  allowedAttributes: {
    a: ['href', 'title', 'rel', 'target'],
    img: ['src', 'alt', 'title', 'loading'],
    code: ['class'],
    th: ['align'],
    td: ['align'],
  },
  // Reject javascript:, data:, vbscript: etc.
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['http', 'https'] },
  allowProtocolRelative: false,
  // Drop the contents of these entirely.
  nonTextTags: ['style', 'script', 'textarea', 'option', 'noscript'],
  transformTags: {
    a: (tagName, attribs) => {
      const href = attribs.href ?? '';

      // External links open safely; internal ones keep SPA navigation.
      const isExternal = /^https?:\/\//i.test(href);

      return {
        tagName,
        attribs: {
          ...attribs,
          ...(isExternal ? { target: '_blank', rel: 'noopener noreferrer' } : {}),
        },
      };
    },
  },
};

export function renderMarkdown(source: string): string {
  if (!source || !source.trim()) return '';

  const raw = marked.parse(source, { async: false }) as string;
  return sanitizeHtml(raw, SANITIZE_OPTIONS);
}

/** Plain-text excerpt for cards and previews. */
export function markdownExcerpt(source: string, max = 200): string {
  const text = source
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Rough word/char counts shown in the editor footer. */
export function markdownStats(source: string): { words: number; characters: number } {
  const trimmed = source.trim();
  return {
    words: trimmed ? trimmed.split(/\s+/).length : 0,
    characters: source.length,
  };
}
