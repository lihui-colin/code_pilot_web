import type { IncomingHttpHeaders } from 'node:http';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { lockHtmlTitle, readHtmlResponse } from './html-title.js';
import type { ViewerManager } from './viewer-manager.js';

export const VIEWER_COOKIE_NAME = 'codepilot_web_viewer';

export function viewerIdFromCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === VIEWER_COOKIE_NAME) return value.join('=') || null;
  }
  return null;
}

export function proxyViewerRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  manager: ViewerManager,
  viewerId: string,
  upstreamPath: string,
  pageTitle?: string,
): FastifyReply {
  const upstreamBaseUrl = manager.upstreamFor(viewerId);
  if (!upstreamBaseUrl) {
    return reply.code(503).send({
      error: { code: 'VIEWER_NOT_READY', message: 'code-viewer is not ready', requestId: request.id },
    });
  }
  const upstream = new URL(upstreamBaseUrl);
  return reply.from(upstreamPath, {
    rewriteRequestHeaders: (_incomingRequest, headers) => {
      const rewritten = { ...headers, host: upstream.host };
      if (pageTitle) rewritten['accept-encoding'] = 'identity';
      delete rewritten.cookie;
      if (rewritten.origin) rewritten.origin = upstream.origin;
      if (rewritten.referer) rewritten.referer = `${upstream.origin}/`;
      return rewritten;
    },
    rewriteHeaders: headers => ({
      ...headers,
      'set-cookie': [`${VIEWER_COOKIE_NAME}=${viewerId}; Path=/; HttpOnly; SameSite=Strict`],
    }),
    onResponse: (_incomingRequest, responseReply, response) => {
      const responseHeaders = (response as unknown as { headers: IncomingHttpHeaders }).headers;
      const contentType = responseHeaders['content-type'];
      if (!pageTitle || typeof contentType !== 'string' || !contentType.includes('text/html')) {
        responseReply.send(response.stream);
        return;
      }
      void readHtmlResponse(response.stream, 'CodeReviewer').then(html => {
        responseReply.removeHeader('content-length');
        responseReply.send(lockHtmlTitle(html, pageTitle));
      }).catch(error => responseReply.send(error));
    },
  });
}
