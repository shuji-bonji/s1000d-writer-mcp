/**
 * Streamable HTTP での起動（段階 2.5 の作業 4、D-19）。
 *
 * MCP SDK v2 の `createMcpHandler`（web 標準の `fetch` 形）を `node:http` に載せる。`@modelcontextprotocol/node` は
 * 使わず、`IncomingMessage` → `Request`、`Response` → `ServerResponse` の変換をここで行う（依存を増やさないため）。
 *
 * 持たないもの: 認証・権限・マルチテナント（製品側の責務）。既定では 127.0.0.1 に束縛し、Host と Origin を
 * localhost 系に限る（DNS rebinding 対策）。他のホストに束縛したときは Host を検査しないので、製品側の
 * リバースプロキシや認証の後ろに置く。
 */
import {
  createServer,
  type IncomingMessage,
  type Server as NodeHttpServer,
  type ServerResponse,
} from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse,
  type McpServerFactory,
} from '@modelcontextprotocol/server';
import { PACKAGE_INFO } from './config.js';

export interface HttpOptions {
  /** 束縛するアドレス。既定 127.0.0.1 */
  host?: string;
  /** ポート。0 なら空いているポート（テスト用）。既定 3000 */
  port?: number;
  /** MCP のエンドポイントのパス。既定 /mcp */
  path?: string;
  /**
   * Host ヘッダーに許すホスト名。省略時は、host が loopback（127.0.0.1 / ::1 / localhost）なら localhost 系だけ、
   * それ以外は検査しない。空の配列も「検査しない」
   */
  allowedHosts?: string[];
  /** Origin ヘッダーに許すホスト名。省略時は allowedHosts と同じ規則 */
  allowedOrigins?: string[];
  onerror?: (error: Error) => void;
}

export interface HttpServerHandle {
  /** MCP のエンドポイント（例: http://127.0.0.1:3000/mcp） */
  url: string;
  host: string;
  port: number;
  close(): Promise<void>;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '0:0:0:0:0:0:0:1']);

const isLoopback = (host: string) => LOOPBACK.has(host.replace(/^\[|\]$/g, '').toLowerCase());

/** コマンドライン引数から HTTP の設定を読む。`--http` が無ければ undefined（stdio で起動する） */
export function parseHttpArgs(argv: string[]): HttpOptions | undefined {
  if (!argv.includes('--http')) return undefined;
  const value = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
    const eq = argv.find((a) => a.startsWith(`${name}=`));
    return eq ? eq.slice(name.length + 1) : undefined;
  };
  const list = (name: string): string[] | undefined => {
    const out = argv
      .map((a, i) =>
        a === name ? argv[i + 1] : a.startsWith(`${name}=`) ? a.slice(name.length + 1) : undefined,
      )
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
      .flatMap((v) =>
        v
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
      );
    return out.length > 0 ? out : undefined;
  };
  const port = value('--port');
  const portNumber = port === undefined ? undefined : Number(port);
  if (
    portNumber !== undefined &&
    (!Number.isInteger(portNumber) || portNumber < 0 || portNumber > 65535)
  )
    throw new Error(`--port must be an integer between 0 and 65535 (got "${port}")`);
  return {
    host: value('--host'),
    port: portNumber,
    path: value('--path'),
    allowedHosts: list('--allowed-host'),
    allowedOrigins: list('--allowed-origin'),
  };
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req)
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

/** `node:http` の要求を web 標準の `Request` にする */
async function toWebRequest(
  req: IncomingMessage,
  fallbackHost: string,
  signal: AbortSignal,
): Promise<Request> {
  const headers = new Headers();
  for (const [name, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const x of v) headers.append(name, x);
    else headers.set(name, v);
  }
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? fallbackHost}`);
  const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req);
  return new Request(url, { method, headers, body, signal });
}

/** web 標準の `Response` を `node:http` の応答に書く。SSE は本文をそのまま流す */
async function writeWebResponse(res: ServerResponse, out: Response): Promise<void> {
  res.statusCode = out.status;
  out.headers.forEach((v, k) => res.setHeader(k, v));
  if (!out.body) {
    res.end();
    return;
  }
  await pipeline(Readable.fromWeb(out.body as WebReadableStream), res);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

/**
 * Streamable HTTP で起動する。`factory` は `serveStdio` に渡すものと同じ（要求ごとにサーバーを 1 つ作る）。
 * `/healthz`（GET）は名前と版を返す。それ以外のパスは 404
 */
export async function serveHttp(
  factory: McpServerFactory,
  options: HttpOptions = {},
): Promise<HttpServerHandle> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 3000;
  const path = options.path ?? '/mcp';
  const loopback = isLoopback(host);
  const allowedHosts =
    options.allowedHosts !== undefined
      ? options.allowedHosts
      : loopback
        ? localhostAllowedHostnames()
        : [];
  const allowedOrigins =
    options.allowedOrigins !== undefined
      ? options.allowedOrigins
      : loopback
        ? localhostAllowedOrigins()
        : [];
  const onerror = options.onerror ?? (() => {});
  const handler = createMcpHandler(factory, { onerror });

  const server: NodeHttpServer = createServer((req, res) => {
    const abort = new AbortController();
    req.once('close', () => abort.abort());
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', `http://${host}`);
        if (url.pathname === '/healthz' && req.method === 'GET') {
          json(res, 200, {
            ok: true,
            name: PACKAGE_INFO.name,
            version: PACKAGE_INFO.version,
            transport: 'http',
            mcp: path,
          });
          return;
        }
        if (url.pathname !== path) {
          json(res, 404, { error: `Not found. The MCP endpoint is ${path}` });
          return;
        }
        const request = await toWebRequest(req, `${host}:${port}`, abort.signal);
        const rejected =
          (allowedHosts.length > 0
            ? hostHeaderValidationResponse(request, allowedHosts)
            : undefined) ??
          (allowedOrigins.length > 0
            ? originValidationResponse(request, allowedOrigins)
            : undefined);
        await writeWebResponse(res, rejected ?? (await handler.fetch(request)));
      } catch (error) {
        onerror(error instanceof Error ? error : new Error(String(error)));
        if (!res.headersSent) json(res, 500, { error: 'Internal error' });
        else res.end();
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const displayHost = host.includes(':') ? `[${host}]` : host;
  return {
    url: `http://${displayHost}:${actualPort}${path}`,
    host,
    port: actualPort,
    close: async () => {
      await handler.close();
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    },
  };
}
