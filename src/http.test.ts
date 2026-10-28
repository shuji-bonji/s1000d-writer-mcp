/**
 * Streamable HTTP での起動を確かめる。空いているポートに束縛し、SDK の StreamableHTTPClientTransport で叩く。
 */
import { request as httpRequest } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { buildServer } from './server.js';
import { parseHttpArgs, serveHttp, type HttpServerHandle } from './http.js';
import { disposeValidator } from './services/context.js';
import { tools } from './tools/definitions.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures');

let handle: HttpServerHandle;

/** fetch は Host ヘッダーを書き換えられないので、node:http で送る */
function rawRequest(
  port: number,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: init.method ?? 'GET', headers: init.headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end(init.body);
  });
}

beforeAll(async () => {
  handle = await serveHttp(() => buildServer(), { port: 0 });
});
afterAll(async () => {
  await handle.close();
  disposeValidator();
});

async function connect(): Promise<Client> {
  const client = new Client({ name: 'http-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(handle.url)));
  return client;
}

describe('parseHttpArgs', () => {
  it('--http が無ければ undefined（stdio）', () => {
    expect(parseHttpArgs([])).toBeUndefined();
    expect(parseHttpArgs(['--port', '3001'])).toBeUndefined();
  });
  it('--host / --port / --path / --allowed-host を読む（= 形式と分割形式）', () => {
    expect(parseHttpArgs(['--http'])).toEqual({
      host: undefined,
      port: undefined,
      path: undefined,
      allowedHosts: undefined,
      allowedOrigins: undefined,
    });
    expect(
      parseHttpArgs([
        '--http',
        '--host=0.0.0.0',
        '--port',
        '8080',
        '--path',
        '/s1000d',
        '--allowed-host',
        'a.example,b.example',
        '--allowed-host=c.example',
      ]),
    ).toEqual({
      host: '0.0.0.0',
      port: 8080,
      path: '/s1000d',
      allowedHosts: ['a.example', 'b.example', 'c.example'],
      allowedOrigins: undefined,
    });
    expect(() => parseHttpArgs(['--http', '--port', 'abc'])).toThrow(/--port/);
  });
});

describe('serveHttp', () => {
  it('空いているポートに束縛し、/healthz が名前と版を返す', async () => {
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.url).toBe(`http://127.0.0.1:${handle.port}/mcp`);
    const res = await fetch(`http://127.0.0.1:${handle.port}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.name).toBe('@shuji-bonji/s1000d-writer-mcp');
    expect(body.mcp).toBe('/mcp');
  });
  it('エンドポイント以外のパスは 404', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/other`, { method: 'POST' });
    expect(res.status).toBe(404);
  });
  it('MCP クライアントから tools/list と tools/call ができる', async () => {
    const client = await connect();
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name).sort()).toEqual(tools.map((t) => t.name).sort());
      const res = await client.callTool({
        name: 'extract_segments',
        arguments: {
          path: join(fixtures, 'csdb', 'DMC-KENBAIKI-A-10-20-00-00A-040A-D_002-01_JA-JP.XML'),
        },
      });
      const text = (res.content as { type: string; text: string }[])[0]!.text;
      const data = JSON.parse(text) as { dmCode?: string; segments?: unknown[] };
      expect(res.isError).not.toBe(true);
      expect(data.dmCode).toBe('KENBAIKI-A-10-20-00-00A-040A-D');
      expect(data.segments?.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });
  it('loopback に束縛したときは Host ヘッダーを localhost 系に限る（DNS rebinding 対策）', async () => {
    const res = await rawRequest(handle.port, '/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        host: 'evil.example',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    // 正しい Host なら通る（ping は initialize 無しでも答える）
    const ok = await rawRequest(handle.port, '/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        host: `127.0.0.1:${handle.port}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(ok.status).toBe(200);
  });
  it('allowedHosts を空にすると Host を検査しない', async () => {
    const open = await serveHttp(() => buildServer(), {
      port: 0,
      allowedHosts: [],
      allowedOrigins: [],
    });
    try {
      const res = await rawRequest(open.port, '/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          host: 'evil.example',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });
      expect(res.status).toBe(200);
    } finally {
      await open.close();
    }
  });
});
