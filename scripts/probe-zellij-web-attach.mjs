#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import tls from 'node:tls';

const sessionName = process.argv[2];
const configFile = path.resolve(process.argv[3] ?? 'config.json');

if (!sessionName || !/^[A-Za-z0-9_-]{1,64}$/u.test(sessionName)) {
  throw new Error('usage: node scripts/probe-zellij-web-attach.mjs <session-name> [config-file]');
}

function request(baseUrl, pathname, body, cookie) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const outgoing = https.request(new URL(pathname, `${baseUrl}/`), {
      method: 'POST',
      rejectUnauthorized: false,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        ...(cookie ? { cookie } : {}),
      },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    outgoing.once('error', reject);
    outgoing.end(payload);
  });
}

function firstWebSocketFrame(baseUrl, pathname, cookie) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl);
    const socket = tls.connect({
      host: url.hostname,
      port: Number(url.port || 443),
      rejectUnauthorized: false,
    });
    const timer = setTimeout(() => socket.destroy(new Error('WebSocket attach timed out')), 5_000);
    let response = Buffer.alloc(0);
    let headersRead = false;
    let frameBuffer = Buffer.alloc(0);

    const finish = result => {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    socket.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once('secureConnect', () => {
      const key = randomBytes(16).toString('base64');
      socket.write([
        `GET ${pathname} HTTP/1.1`,
        `Host: ${url.host}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        `Sec-WebSocket-Key: ${key}`,
        `Cookie: ${cookie}`,
        '',
        '',
      ].join('\r\n'));
    });
    socket.on('data', chunk => {
      if (!headersRead) {
        response = Buffer.concat([response, chunk]);
        const separator = response.indexOf('\r\n\r\n');
        if (separator === -1) return;
        const statusLine = response.subarray(0, separator).toString('utf8').split('\r\n')[0];
        if (!statusLine?.includes(' 101 ')) {
          socket.destroy(new Error(`WebSocket upgrade failed: ${statusLine ?? 'unknown status'}`));
          return;
        }
        headersRead = true;
        frameBuffer = response.subarray(separator + 4);
      } else {
        frameBuffer = Buffer.concat([frameBuffer, chunk]);
      }

      while (frameBuffer.length >= 2) {
        const opcode = frameBuffer[0] & 0x0f;
        let payloadLength = frameBuffer[1] & 0x7f;
        let headerLength = 2;
        if (payloadLength === 126) {
          if (frameBuffer.length < 4) return;
          payloadLength = frameBuffer.readUInt16BE(2);
          headerLength = 4;
        } else if (payloadLength === 127) {
          if (frameBuffer.length < 10) return;
          const length = frameBuffer.readBigUInt64BE(2);
          if (length > BigInt(Number.MAX_SAFE_INTEGER)) {
            socket.destroy(new Error('WebSocket frame is too large'));
            return;
          }
          payloadLength = Number(length);
          headerLength = 10;
        }
        if (frameBuffer.length < headerLength + payloadLength) return;
        const payload = frameBuffer.subarray(headerLength, headerLength + payloadLength);
        frameBuffer = frameBuffer.subarray(headerLength + payloadLength);
        if (opcode === 0x8) {
          const closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
          finish({ attached: false, closeCode });
          return;
        }
        if ((opcode === 0x1 || opcode === 0x2) && payload.length > 0) {
          finish({ attached: true, payloadBytes: payload.length });
          return;
        }
      }
    });
  });
}

const config = JSON.parse(await readFile(configFile, 'utf8'));
const token = config.zellij?.webToken?.value;
const baseUrl = new URL('/zellij/', config.publicBaseUrl).toString().replace(/\/$/u, '');
if (typeof token !== 'string' || typeof baseUrl !== 'string') throw new Error('Zellij Web configuration is incomplete');

const login = await request(baseUrl, '/command/login', { auth_token: token, remember_me: false });
if (login.statusCode !== 200) throw new Error(`Zellij Web login failed with HTTP ${login.statusCode}`);
const cookie = (login.headers['set-cookie'] ?? []).map(value => value.split(';', 1)[0]).join('; ');
if (!cookie) throw new Error('Zellij Web login did not return a cookie');

const client = await request(baseUrl, '/session', {}, cookie);
if (client.statusCode !== 200) throw new Error(`Zellij Web client creation failed with HTTP ${client.statusCode}`);
const webClientId = JSON.parse(client.body.toString('utf8')).web_client_id;
if (typeof webClientId !== 'string') throw new Error('Zellij Web did not return a client ID');

const frame = await firstWebSocketFrame(
  baseUrl,
  `/ws/terminal/${encodeURIComponent(sessionName)}?web_client_id=${encodeURIComponent(webClientId)}`,
  cookie,
);
if (!frame.attached) throw new Error(`Zellij Web rejected the Session with close code ${frame.closeCode}`);
process.stdout.write(`PASS: Zellij Web attached to ${sessionName} and received ${frame.payloadBytes} bytes\n`);
