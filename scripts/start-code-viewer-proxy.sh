#!/usr/bin/env bash
set -euo pipefail

repo="${1:-$PWD}"
proxy_port="${CODE_VIEWER_PROXY_PORT:-8023}"
proxy_hostname="${CODE_VIEWER_PROXY_HOSTNAME:-0.0.0.0}"

if [[ ! -d "$repo" ]]; then
    echo "Repository directory does not exist: $repo" >&2
    exit 1
fi

if ! command -v code-viewer >/dev/null 2>&1; then
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    if [[ -s "$NVM_DIR/nvm.sh" ]]; then
        # shellcheck disable=SC1090
        source "$NVM_DIR/nvm.sh"
    fi
fi

if ! command -v code-viewer >/dev/null 2>&1; then
    echo "code-viewer was not found in PATH." >&2
    exit 1
fi

if ss -ltn "( sport = :$proxy_port )" 2>/dev/null | grep -q LISTEN; then
    echo "Proxy port is already in use: $proxy_port" >&2
    exit 1
fi

log_file="$(mktemp -t code-viewer.XXXXXX.log)"
viewer_pid=''
tail_pid=''

cleanup() {
    [[ -n "$tail_pid" ]] && kill "$tail_pid" 2>/dev/null || true
    [[ -n "$viewer_pid" ]] && kill "$viewer_pid" 2>/dev/null || true
    rm -f "$log_file"
}
trap cleanup EXIT INT TERM

code-viewer --cwd "$repo" >"$log_file" 2>&1 &
viewer_pid=$!
tail -n +1 -F "$log_file" &
tail_pid=$!

listen_url=''
for _ in {1..100}; do
    if ! kill -0 "$viewer_pid" 2>/dev/null; then
        wait "$viewer_pid"
        exit $?
    fi
    listen_url="$(grep -m1 '^GDP_LISTEN_URL=' "$log_file" | cut -d= -f2- || true)"
    [[ -n "$listen_url" ]] && break
    sleep 0.1
done

if [[ -z "$listen_url" ]]; then
    echo "Timed out waiting for code-viewer to report its listening port." >&2
    exit 1
fi

upstream_port="${listen_url#http://127.0.0.1:}"
upstream_port="${upstream_port%/}"

echo "Proxy URL: http://$proxy_hostname:$proxy_port"
echo "Upstream:  $listen_url"

node - "$upstream_port" "$proxy_port" "$proxy_hostname" <<'NODE'
const http = require('node:http');
const net = require('node:net');

const upstreamPort = Number(process.argv[2]);
const proxyPort = Number(process.argv[3]);
const proxyHostname = process.argv[4];
const upstreamHost = '127.0.0.1';
const upstreamAuthority = `${upstreamHost}:${upstreamPort}`;

const rewriteHeaders = headers => {
    const rewritten = { ...headers, host: upstreamAuthority };
    if (rewritten.origin) {
        rewritten.origin = `http://${upstreamAuthority}`;
    }
    return rewritten;
};

const proxy = http.createServer((request, response) => {
    const upstream = http.request({
        hostname: upstreamHost,
        port: upstreamPort,
        path: request.url,
        method: request.method,
        headers: rewriteHeaders(request.headers),
    }, upstreamResponse => {
        response.writeHead(
            upstreamResponse.statusCode,
            upstreamResponse.statusMessage,
            upstreamResponse.headers
        );
        upstreamResponse.pipe(response);
    });

    upstream.on('error', error => {
        console.error(`Proxy request failed: ${error.message}`);
        if (!response.headersSent) {
            response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        }
        response.end('Bad gateway');
    });
    request.pipe(upstream);
});

proxy.on('upgrade', (request, socket, head) => {
    const upstream = net.connect(upstreamPort, upstreamHost, () => {
        const headers = rewriteHeaders(request.headers);
        const headerLines = Object.entries(headers).flatMap(([name, value]) => {
            const values = Array.isArray(value) ? value : [value];
            return values.filter(item => item !== undefined).map(item => `${name}: ${item}`);
        });
        upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${headerLines.join('\r\n')}\r\n\r\n`);
        if (head.length) {
            upstream.write(head);
        }
        socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
});

proxy.listen(proxyPort, proxyHostname, () => {
    console.log(`Proxy listening on http://${proxyHostname}:${proxyPort}`);
});
NODE
