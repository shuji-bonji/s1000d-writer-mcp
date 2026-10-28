/**
 * 利用者が入手した S1000D の配布物に対するテスト（`S1000D_SPEC_TESTS=1` のときだけ）。
 * 配布物は再配布できない（DECISIONS D-03）。場所は `S1000D_SPEC_DIR`（既定: ../../specs/s1000d/issue-7）。
 * 段階 3 の完了条件: 体験型マニュアルの例（kenbaiki）を変換し、全 DM と PM が本物の XSD・既定 BREX に通り、参照が解決すること。
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { findDefaultBrex } from '@shuji-bonji/s1000d-core';
import { buildServer } from './server.js';
import { clearCaches, disposeValidator } from './services/context.js';

const enabled = process.env.S1000D_SPEC_TESTS === '1';
const specDir = resolve(process.env.S1000D_SPEC_DIR ?? '../../specs/s1000d/issue-7');
const manualPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'tests',
  'fixtures',
  'kenbaiki.manual.json',
);

function findBikeDir(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (/bike/i.test(e.name) && readdirSync(p).some((n) => /^DMC-.*\.XML$/i.test(n))) return p;
      const inner = findBikeDir(p);
      if (inner) return inner;
    }
  }
  return undefined;
}

let client: Client;
const bikeDir = findBikeDir(specDir);
const tmpDirs: string[] = [];

async function call(name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const text =
    (res.content as { type: string; text: string }[]).find((c) => c.type === 'text')?.text ?? '{}';
  return { isError: res.isError === true, data: JSON.parse(text) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

describe.skipIf(!enabled || !existsSync(specDir))('S1000D 配布物（利用者が入手したもの）', () => {
  beforeAll(async () => {
    process.env.S1000D_SPEC_DIR = specDir;
    delete process.env.S1000D_CSDB_DIR;
    process.env.S1000D_CONFIG = join(tmpdir(), 's1000d-no-such-config.json');
    clearCaches();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await buildServer().connect(serverTransport);
    client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);
  });
  afterAll(async () => {
    await client.close();
    disposeValidator();
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });

  it('kenbaiki: 変換した全 DM と PM が XSD で valid・既定 BREX の違反 0 件・参照が解決する（段階 3 の完了条件）', async () => {
    const found = findDefaultBrex([specDir]);
    expect(found).toBeDefined();
    const manual = JSON.parse(readFileSync(manualPath, 'utf8')) as {
      assets: { source: { path: string } }[];
    };
    // 素材の原本の代わりの小さなファイル
    const assets = mkdtempSync(join(tmpdir(), 's1000d-writer-assets-'));
    const out = mkdtempSync(join(tmpdir(), 's1000d-writer-csdb-'));
    tmpDirs.push(assets, out);
    for (const a of manual.assets) {
      const p = join(assets, a.source.path);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, 'dummy');
    }
    const r = await call('convert_manual', {
      manualPath,
      allocation: {
        modelIdentCode: 'KENBAIKI',
        systemDiffCode: 'A',
        rules: {
          sns: { systemCode: '10', subSystemCode: '2', subSubSystemCode: '0', assyCode: '00' },
          infoCodeByKind: {
            descript: { infoCode: '040', infoCodeVariant: 'A' },
            proced: { infoCode: '520', infoCodeVariant: 'A' },
            process: { infoCode: '130', infoCodeVariant: 'A' },
            fault: { infoCode: '411', infoCodeVariant: 'A' },
          },
          itemLocationCode: 'D',
        },
        icn: { cageCode: 'K0001', next: 1 },
        brexDmRef: found!.brex.dmCode,
      },
      securityClassification: '01',
      responsiblePartnerCompany: 'K0001',
      assetBaseDir: assets,
      // 書き込み先 → 既定 BREX のあるフォルダー（brexDmRef の解決用）
      csdbDirs: [out, dirname(found!.path)],
      write: true,
    });
    expect(r.isError).toBe(false);
    expect(r.data.error).toBeUndefined();
    type Row = {
      fileName: string;
      fixes: unknown;
      verification: Record<string, { state: string }>;
    };
    const s = r.data.summary;
    const problems = [...r.data.dataModules, r.data.publicationModule].flatMap((d: Row) => [
      ...(d.verification.schema.state === 'valid'
        ? []
        : [`${d.fileName}: schema ${d.verification.schema.state}`]),
      ...(d.verification.brex.state === 'passed'
        ? []
        : [
            `${d.fileName}: brex ${JSON.stringify(d.verification.brex)} ${JSON.stringify(d.fixes)}`,
          ]),
      ...(d.verification.references.state === 'resolved'
        ? []
        : [`${d.fileName}: references ${JSON.stringify(d.verification.references)}`]),
    ]);
    expect(problems).toEqual([]);
    expect(s).toMatchObject({
      failedToBuild: 0,
      brexViolationCount: 0,
      unresolvedReferenceCount: 0,
    });
    expect(s.schema.valid).toBe(s.dataModules + s.publicationModules);
    expect(s.written).toBe(s.dataModules + s.publicationModules);
    // 結果を CSDB の外から検証し直す（書いたものを読み戻しても同じ）
    const files = readdirSync(out);
    expect(files.filter((f) => /^DMC-/.test(f))).toHaveLength(s.dataModules);
    expect(files.filter((f) => /^PMC-/.test(f))).toHaveLength(1);
    process.stdout.write(
      `kenbaiki: DM ${s.dataModules} / PM ${s.publicationModules} / valid ${s.schema.valid} / BREX 違反 ${s.brexViolationCount} / 未解決参照 ${s.unresolvedReferenceCount} / 自動修正 ${s.appliedFixes} / 表せなかった ${r.data.notRepresented.length} 種\n`,
    );
  });

  it.skipIf(!bikeDir)(
    'Bike Samples: extract_segments → apply_segments の結果が XSD で valid',
    async () => {
      const dm =
        readdirSync(bikeDir!).find((n) => /^DMC-.*-040A-.*\.XML$/i.test(n)) ??
        readdirSync(bikeDir!).find((n) => /^DMC-.*\.XML$/i.test(n));
      expect(dm).toBeDefined();
      const path = join(bikeDir!, dm!);
      const ex = await call('extract_segments', { path });
      expect(ex.isError).toBe(false);
      expect(ex.data.segments.length).toBeGreaterThan(0);
      const segments = ex.data.segments.map((x: { id: string; text: string }) => ({
        id: x.id,
        text: x.text,
      }));
      const ap = await call('apply_segments', {
        path,
        skeletonHash: ex.data.skeletonHash,
        segments,
        language: { languageIsoCode: 'ja', countryIsoCode: 'JP' },
        csdbDirs: [bikeDir!],
      });
      expect(ap.isError).toBe(false);
      expect(ap.data.error).toBeUndefined();
      expect(ap.data.unapplied).toEqual([]);
      expect(ap.data.verification.schema).toMatchObject({ state: 'valid', issue: '7' });
    },
  );
});
