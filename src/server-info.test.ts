/**
 * 応答の最後の項目に、答えたサーバーの名前と版、読み込んだ core の版（_server）が付くことを確かめる（hub の DECISIONS の D-38）。
 * テストの間だけ、引数を取らない仮のツールを登録し、成功・想定内の失敗・想定外の失敗の 3 通りを作る。
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { CORE_INFO } from '@shuji-bonji/s1000d-core';
import { DraftInputError } from '@shuji-bonji/s1000d-core';
import { SERVER_INFO } from './config.js';
import { buildServer } from './server.js';
import { tools } from './tools/definitions.js';
import { toolHandlers } from './tools/handlers.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  name: string;
  version: string;
};
// core の package.json は exports に無いので、node_modules のファイルを直接読む
const installedCore = JSON.parse(
  readFileSync(
    new URL('../node_modules/@shuji-bonji/s1000d-core/package.json', import.meta.url),
    'utf8',
  ),
) as { version: string };

const FAKE = {
  object: '__test_server_info_object',
  array: '__test_server_info_array',
  expected: '__test_server_info_expected',
  unexpected: '__test_server_info_unexpected',
};
const handlers = toolHandlers as Record<
  string,
  (args: Record<string, unknown>) => Promise<unknown>
>;
let client: Client;

beforeAll(async () => {
  for (const name of Object.values(FAKE)) {
    tools.push({
      name,
      description: 'test only',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    } as (typeof tools)[number]);
  }
  handlers[FAKE.object] = async () => ({ value: 1, _notes: ['note'] });
  handlers[FAKE.array] = async () => [1, 2];
  handlers[FAKE.expected] = async () => {
    throw new DraftInputError('/draft', 'bad input');
  };
  handlers[FAKE.unexpected] = async () => {
    throw new Error('boom');
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await buildServer().connect(serverTransport);
  client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
  for (const name of Object.values(FAKE)) {
    tools.splice(
      tools.findIndex((t) => t.name === name),
      1,
    );
    delete handlers[name];
  }
});

async function call(name: string) {
  const res = await client.callTool({ name, arguments: {} });
  const text = (res.content as { type: string; text: string }[])[0]!.text;
  return { isError: res.isError === true, data: JSON.parse(text) as Record<string, unknown> };
}

describe('_server（D-38）', () => {
  it('SERVER_INFO は package.json の名前と版、読み込んだ core の版', () => {
    expect(SERVER_INFO).toEqual({ name: pkg.name, version: pkg.version, core: CORE_INFO.version });
    expect(SERVER_INFO.core).toBe(installedCore.version);
  });

  it('成功の応答は、元の項目を保ち、最後に _server を足す', async () => {
    const r = await call(FAKE.object);
    expect(r.isError).toBe(false);
    expect(Object.keys(r.data)).toEqual(['value', '_notes', '_server']);
    expect(r.data._server).toEqual(SERVER_INFO);
  });

  it('オブジェクトでない結果は result に入れて _server を足す', async () => {
    const r = await call(FAKE.array);
    expect(r.data).toEqual({ result: [1, 2], _server: SERVER_INFO });
  });

  it('想定内の失敗にも _server を最後に足す（isError にしない）', async () => {
    const r = await call(FAKE.expected);
    expect(r.isError).toBe(false);
    expect(r.data.error).toBeTruthy();
    expect(Object.keys(r.data).at(-1)).toBe('_server');
    expect(r.data._server).toEqual(SERVER_INFO);
  });

  it('想定外の失敗にも _server を足し、isError は付けたまま', async () => {
    const r = await call(FAKE.unexpected);
    expect(r.isError).toBe(true);
    expect(r.data).toEqual({ error: 'boom', _server: SERVER_INFO });
  });
});
