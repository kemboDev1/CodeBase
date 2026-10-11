import { oneLine, truncate } from '../../lib/text.js';

const def = (name, title, description, defaultPolicy, parameters, run, extra = {}) => ({
  name, title, description, category: 'web', defaultPolicy, parameters, run, source: 'core', ...extra
});

const PRIVATE_HOST = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?|.*\.local$|.*\.internal$)/i;

/** Strip scripts/styles/tags and collapse whitespace into readable text. */
function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const webFetch = def(
  'web.fetch',
  'Fetch web page',
  'Download a public http(s) URL and return its text content (HTML is converted to plain text). Private and loopback hosts are blocked.',
  'ask',
  {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Public http(s) URL.' },
      maxBytes: { type: 'integer', description: 'Maximum bytes to read (default 200000). Optional.' }
    },
    required: ['url']
  },
  async (args, ctx) => {
    let parsed;
    try {
      parsed = new URL(String(args.url));
    } catch {
      return { ok: false, error: 'URL noto‘g‘ri.' };
    }
    if (!/^https?:$/.test(parsed.protocol)) return { ok: false, error: 'Faqat http/https ruxsat etilgan.' };
    if (PRIVATE_HOST.test(parsed.hostname)) {
      return { ok: false, error: `Ichki tarmoq manzillari bloklangan: ${parsed.hostname}` };
    }
    const maxBytes = Math.min(1_000_000, Math.max(2_000, Number(args.maxBytes) || 200_000));
    try {
      const response = await fetch(parsed.href, {
        redirect: 'follow',
        headers: { 'User-Agent': 'CodeBase-Agent/1.0 (+local)', Accept: 'text/html,application/json,text/plain,*/*' },
        signal: ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000)
      });
      const contentType = response.headers.get('content-type') || '';
      const raw = (await response.text()).slice(0, maxBytes);
      const text = /json|text\/plain|xml/i.test(contentType) && !/<html/i.test(raw) ? raw.trim() : htmlToText(raw);
      return {
        ok: response.ok,
        summary: `${response.status} ${parsed.hostname} (${text.length} belgi)`,
        content: [`URL: ${parsed.href}`, `status: ${response.status} ${contentType}`, '', truncate(text, 15_000)].join('\n'),
        data: { status: response.status, bytes: raw.length },
        error: response.ok ? undefined : `HTTP ${response.status}`
      };
    } catch (error) {
      return { ok: false, error: `Sahifani olib bo‘lmadi: ${oneLine(error.message, 200)}` };
    }
  },
  { timeoutMs: 45_000 }
);

export const webTools = [webFetch];
export default webTools;
