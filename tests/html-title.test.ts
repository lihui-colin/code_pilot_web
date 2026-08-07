import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { HTML_TITLE_SCRIPT, HTML_TITLE_SCRIPT_PATH, lockHtmlTitle } from '../src/services/html-title.js';

describe('HTML title locking', () => {
  it('escapes repository names without embedding them in executable script', () => {
    const html = lockHtmlTitle(
      '<html><head><title>Original</title></head><body></body></html>',
      'repo</script><script>alert(1)</script> - CodeReviewer',
    );

    expect(html).toContain('<title>repo&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt; - CodeReviewer</title>');
    expect(html).toContain('content="repo&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt; - CodeReviewer"');
    expect(html).toContain(`<script src="${HTML_TITLE_SCRIPT_PATH}"></script>`);
    expect(html).not.toContain('<script>(()=>');
  });

  it('restores the locked title when the upstream app replaces the head element', async () => {
    const html = lockHtmlTitle(
      '<html><head><title>Original</title></head><body></body></html>',
      'repository - Zellij',
    );
    const dom = new JSDOM(html, { runScripts: 'outside-only' });
    dom.window.eval(HTML_TITLE_SCRIPT);

    const replacementHead = dom.window.document.createElement('head');
    replacementHead.innerHTML = '<title>repository</title>';
    dom.window.document.documentElement.replaceChild(replacementHead, dom.window.document.head);
    await new Promise(resolve => dom.window.setTimeout(resolve, 0));

    expect(dom.window.document.title).toBe('repository - Zellij');
    dom.window.close();
  });
});
