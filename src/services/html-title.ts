const MAX_HTML_BYTES = 1024 * 1024;
export const HTML_TITLE_SCRIPT_PATH = '/codepilot-html-title.js';
export const HTML_TITLE_SCRIPT = `(() => {
  const meta = document.querySelector('meta[name="codepilot-page-title"]');
  const title = meta?.getAttribute('content');
  if (!title) return;
  const apply = () => {
    if (document.title !== title) document.title = title;
  };
  apply();
  new MutationObserver(apply).observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
})();`;

export async function readHtmlResponse(stream: AsyncIterable<Buffer | Uint8Array | string>, label: string): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_HTML_BYTES) throw new Error(`${label} HTML response is too large`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function lockHtmlTitle(html: string, title: string): string {
  const lockMarkup = `<meta name="codepilot-page-title" content="${escapeHtml(title)}"><script src="${HTML_TITLE_SCRIPT_PATH}"></script>`;
  const withTitle = /<title(?:\s[^>]*)?>[\s\S]*?<\/title>/iu.test(html)
    ? html.replace(/<title(?:\s[^>]*)?>[\s\S]*?<\/title>/iu, `<title>${escapeHtml(title)}</title>`)
    : html.replace(/<head(?:\s[^>]*)?>/iu, match => `${match}<title>${escapeHtml(title)}</title>`);
  return withTitle.replace(/<\/head>/iu, `${lockMarkup}</head>`);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
