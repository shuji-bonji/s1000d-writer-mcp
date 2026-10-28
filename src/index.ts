#!/usr/bin/env node
/**
 * s1000d-writer-mcp — エントリポイント。
 * 既定は stdio。`--http` を付けると Streamable HTTP（`--host` / `--port` / `--path`、http.ts）で起動する。
 * MCP SDK v2 はどちらの transport でも、接続（または要求）ごとに factory からサーバを 1 つ作る。組み立ては server.ts。
 */
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { buildServer } from './server.js';
import { PACKAGE_INFO } from './config.js';
import { parseHttpArgs, serveHttp } from './http.js';
import { logger } from './utils/logger.js';

const onerror = (error: Error) => {
  logger.error('Server', error.message, error);
};

const http = parseHttpArgs(process.argv.slice(2));
if (http) {
  const handle = await serveHttp(() => buildServer(), { ...http, onerror });
  logger.info(
    'Server',
    `${PACKAGE_INFO.name} ${PACKAGE_INFO.version} listening on ${handle.url} (Streamable HTTP)`,
  );
  const shutdown = () => {
    void handle.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} else {
  serveStdio(() => buildServer(), { onerror });
  logger.info('Server', `${PACKAGE_INFO.name} ${PACKAGE_INFO.version} started (stdio)`);
}
