/**
 * サーバを InMemoryTransport で叩き、ツール定義とハンドラの対応、各ツールの応答の形、書き込みの規則を確かめる。
 * テストデータは自作（券売機: 説明 DM・手順 DM、BREX 2 層、体験型マニュアル）と自作の XSD。配布物は使わない。
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { buildServer } from './server.js';
import { clearCaches, disposeValidator } from './services/context.js';
import { tools } from './tools/definitions.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures');
const STRICT = join(fixtures, 'csdb'); // 厳しい BREX（責任企業・情報コード・段落の題名）と見本の DM
const LAX = join(fixtures, 'csdb-lax'); // ほぼ何も決めない BREX
const SPEC = join(fixtures, 'spec'); // 自作の XSD（識別・状態部と内容部があることだけ）
const SPEC_STRICT = join(fixtures, 'spec-strict'); // descript の本文に段落しか置けない自作の XSD
const DESCRIPT_DM = join(STRICT, 'DMC-KENBAIKI-A-10-20-00-00A-040A-D_002-01_JA-JP.XML');
const MANUAL = join(fixtures, 'kenbaiki.manual.json');

const BREX_CODE = {
  modelIdentCode: 'KENBAIKI',
  systemDiffCode: 'A',
  systemCode: '00',
  subSystemCode: '0',
  subSubSystemCode: '0',
  assyCode: '00',
  disassyCode: '00',
  disassyCodeVariant: 'A',
  infoCode: '022',
  infoCodeVariant: 'A',
  itemLocationCode: 'D',
};

/** 採番の規則。情報コードの値はこのプロジェクトの試作用で、意味を持たせていない */
const allocation = (over: Record<string, unknown> = {}) => ({
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
  brexDmRef: BREX_CODE,
  ...over,
});

const draft = (over: Record<string, unknown> = {}) => ({
  sourceId: 'topic-overview',
  kind: 'descript',
  language: { languageIsoCode: 'ja', countryIsoCode: 'JP' },
  title: { techName: '指定席券売機', infoName: '説明' },
  securityClassification: '01',
  responsiblePartnerCompany: 'K0002',
  originator: 'K0002',
  applic: { displayText: 'すべて' },
  issueDate: '2026-10-28',
  body: [
    { kind: 'para', text: '指定席券売機は、きっぷの購入と予約の受け取りができる機械である。' },
    {
      kind: 'section',
      children: [{ kind: 'para', text: '初期画面には 2 つのボタンがある。' }],
    },
  ],
  ...over,
});

let client: Client;
const tmpDirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 's1000d-writer-mcp-'));
  tmpDirs.push(d);
  return d;
};

async function call(name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const text =
    (res.content as { type: string; text: string }[]).find((c) => c.type === 'text')?.text ?? '{}';
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: text };
  }
  return { isError: res.isError === true, data: data as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

function useSpec(dir: string | undefined) {
  if (dir) process.env.S1000D_SPEC_DIR = dir;
  else delete process.env.S1000D_SPEC_DIR;
  clearCaches();
}

beforeAll(async () => {
  delete process.env.S1000D_SPEC_DIR;
  delete process.env.S1000D_CSDB_DIR;
  // 開発機の ~/.config/s1000d-stack/config.json を読まないよう、存在しない場所に向ける
  process.env.S1000D_CONFIG = join(tmpdir(), 's1000d-no-such-config.json');
  clearCaches();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await buildServer().connect(serverTransport);
  client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
});

afterEach(() => useSpec(undefined));

afterAll(async () => {
  await client.close();
  disposeValidator();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe('server', () => {
  it('instructions で「しないこと」を宣言している', () => {
    const text = client.getInstructions() ?? '';
    expect(text).toContain('does NOT');
    expect(text).toContain('XML that you wrote');
    expect(text).toContain('candidate');
    expect(text).toContain('write is true');
    expect(text).toContain('S1000D_SPEC_DIR');
    expect(text).toContain('input-error');
  });
  it('6 ツールがすべて登録されている', async () => {
    const listed = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(listed).toEqual(
      [
        'apply_fixes',
        'apply_segments',
        'build_data_module',
        'convert_manual',
        'create_comment',
        'extract_segments',
      ].sort(),
    );
    expect(listed).toEqual(tools.map((t) => t.name).sort());
  });
  it('入力スキーマに core の draft.schema.json の $defs が入っている', async () => {
    const t = (await client.listTools()).tools.find((x) => x.name === 'build_data_module')!;
    const schema = t.inputSchema as { $defs?: Record<string, unknown>; required?: string[] };
    expect(Object.keys(schema.$defs ?? {})).toEqual(
      expect.arrayContaining(['DraftDataModule', 'DraftNode', 'DraftRef', 'Allocation']),
    );
    expect(schema.required).toEqual(['draft', 'allocation']);
  });
  it('オブジェクトの引数は、$ref だけでなく type: "object" をその場に持つ（$ref を解決しないクライアント向け）', async () => {
    const offenders: string[] = [];
    for (const t of (await client.listTools()).tools) {
      const props =
        (t.inputSchema as { properties?: Record<string, Record<string, unknown>> }).properties ??
        {};
      for (const [name, p] of Object.entries(props)) {
        if ('$ref' in p && !('type' in p)) offenders.push(`${t.name}.${name}`);
      }
    }
    expect(offenders).toEqual([]);
    const t = (await client.listTools()).tools.find((x) => x.name === 'build_data_module')!;
    const props = (t.inputSchema as { properties: Record<string, { type?: string }> }).properties;
    expect(props.draft.type).toBe('object');
    expect(props.allocation.type).toBe('object');
  });
  it('未知の引数は拒否される', async () => {
    const r = await call('extract_segments', { path: DESCRIPT_DM, bogus: 1 });
    expect(r.isError).toBe(true);
  });
});

describe('build_data_module', () => {
  it('XSD も CSDB も無いときは、XML と採番だけを返し、何も書かない。schema-not-found を「適合」と言わない', async () => {
    const r = await call('build_data_module', { draft: draft(), allocation: allocation() });
    expect(r.isError).toBe(false);
    expect(r.data.dmCode).toBe('KENBAIKI-A-10-20-00-00A-040A-D');
    expect(r.data.fileName).toBe('DMC-KENBAIKI-A-10-20-00-00A-040A-D_001-00_JA-JP.XML');
    expect(r.data.xml).toContain('<dmodule');
    expect(r.data.xml).toContain('xsi:noNamespaceSchemaLocation');
    expect(r.data.verification.schema.state).toBe('schema-not-found');
    expect(r.data.verification.brex.state).not.toBe('passed'); // BREX が見つからない
    expect(r.data.written).toEqual([]);
    expect(r.data.ledger).toEqual({ 'topic-overview': 'KENBAIKI-A-10-20-00-00A-040A-D' });
    expect(r.data.icnNext).toBe(1);
    expect(r.data._notes.join('\n')).toContain('Nothing was written');
  });

  it('自作の XSD と BREX（lax）に通ると valid / passed / resolved', async () => {
    useSpec(SPEC);
    const r = await call('build_data_module', {
      draft: draft(),
      allocation: allocation(),
      csdbDirs: [LAX],
    });
    expect(r.data.verification.schema).toMatchObject({ state: 'valid', issue: '7' });
    expect(r.data.verification.brex).toMatchObject({
      state: 'passed',
      layers: 2,
      violationCount: 0,
    });
    expect(r.data.verification.references.state).toBe('resolved');
    expect(r.data.appliedFixes).toEqual([]);
    expect(r.data.fixCount).toBe(0);
  });

  it('exact の修正だけを自動で適用し（appliedFixes）、再検証する。several は fixes[] に残す', async () => {
    useSpec(SPEC);
    // 責任企業 K0001 は BREX KB-00001（K0002 だけ）に違反 → exact の置き換え。情報コード 041 は KB-00002 に違反 → several
    const r = await call('build_data_module', {
      draft: draft({ responsiblePartnerCompany: 'K0001' }),
      allocation: allocation({
        rules: {
          sns: { systemCode: '10', subSystemCode: '2', subSubSystemCode: '0', assyCode: '00' },
          infoCodeByKind: { descript: { infoCode: '041', infoCodeVariant: 'A' } },
          itemLocationCode: 'D',
        },
      }),
      csdbDirs: [STRICT],
    });
    expect(r.data.appliedFixes).toHaveLength(1);
    expect(r.data.appliedFixes[0]).toMatchObject({
      round: 1,
      kind: 'brex-value',
      action: 'replace',
      value: 'K0002',
      changed: { before: 'K0001', after: 'K0002' },
    });
    expect(r.data.xml).toContain('<responsiblePartnerCompany enterpriseCode="K0002"');
    expect(r.data.xml).not.toContain('enterpriseCode="K0001"');
    // 残り: 情報コード（候補が複数）。値を選ぶのは利用者
    expect(r.data.verification.brex.state).toBe('violations');
    expect(r.data.verification.brex.violationCount).toBe(1);
    expect(r.data.fixCount).toBe(1);
    expect(r.data.fixes[0]).toMatchObject({ kind: 'brex-value', confidence: 'several' });
    expect(
      r.data.fixes[0].candidates.map((c: { valueForm?: string }) => c.valueForm ?? 'single'),
    ).toEqual(['single', 'range']);
    expect(r.data._notes.join('\n')).toContain('applied automatically');
  });

  it('forbidden 違反の exact（取り除く）も自動で適用する。maxFixRounds: 0 なら適用せず候補だけ返す', async () => {
    const withTitle = draft({
      body: [{ kind: 'section', title: '画面の構成', children: [{ kind: 'para', text: '本文' }] }],
    });
    const off = await call('build_data_module', {
      draft: withTitle,
      allocation: allocation(),
      csdbDirs: [STRICT],
      maxFixRounds: 0,
    });
    expect(off.data.appliedFixes).toEqual([]);
    expect(off.data.xml).toContain('<title>画面の構成</title>');
    expect(
      off.data.fixes.map((f: { kind: string; confidence: string }) => `${f.kind}:${f.confidence}`),
    ).toEqual(['brex-forbidden:exact']);
    const on = await call('build_data_module', {
      draft: withTitle,
      allocation: allocation(),
      csdbDirs: [STRICT],
    });
    expect(on.data.appliedFixes.map((a: { kind: string }) => a.kind)).toEqual(['brex-forbidden']);
    expect(on.data.xml).not.toContain('<title>画面の構成</title>');
    expect(on.data.verification.brex.state).toBe('passed');
  });

  it('write: false では何も書かず、write: true で DMC-….XML を最初のフォルダーに書く。同じ名前は write-conflict', async () => {
    useSpec(SPEC);
    const dir = tmp();
    const args = { draft: draft(), allocation: allocation(), csdbDirs: [dir, LAX] };
    const dry = await call('build_data_module', args);
    expect(dry.data.written).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);

    const wet = await call('build_data_module', { ...args, write: true });
    const file = join(dir, 'DMC-KENBAIKI-A-10-20-00-00A-040A-D_001-00_JA-JP.XML');
    expect(wet.data.written).toEqual([file]);
    expect(readdirSync(dir)).toEqual(['DMC-KENBAIKI-A-10-20-00-00A-040A-D_001-00_JA-JP.XML']);
    expect(readFileSync(file, 'utf8')).toBe(wet.data.xml);

    // 同じ名前（同じ版）は上書きしない
    const sameAlloc = allocation({ ledger: wet.data.ledger });
    const again = await call('build_data_module', {
      ...args,
      allocation: sameAlloc,
      write: true,
      draft: draft({ issueInfo: { issueNumber: '001', inWork: '00' } }),
    });
    expect(again.data.written).toEqual([]);
    expect(again.data.writeSkipped.reason).toBe('write-conflict');
    expect(readFileSync(file, 'utf8')).toBe(wet.data.xml);
    const over = await call('build_data_module', {
      ...args,
      allocation: sameAlloc,
      write: true,
      overwrite: true,
      draft: draft({ issueInfo: { issueNumber: '001', inWork: '00' } }),
    });
    expect(over.data.written).toEqual([file]);

    // 版を決めなければ、CSDB にある版の次（increment-issue）になる
    const next = await call('build_data_module', { ...args, allocation: sameAlloc, write: true });
    expect(next.data.issueInfo).toEqual({ issueNumber: '002', inWork: '00' });
    expect(next.data.fileName).toBe('DMC-KENBAIKI-A-10-20-00-00A-040A-D_002-00_JA-JP.XML');
    expect(readdirSync(dir)).toHaveLength(2);
  });

  it('書き込み先が無いときは書かず、理由を返す', async () => {
    const r = await call('build_data_module', {
      draft: draft(),
      allocation: allocation(),
      write: true,
    });
    expect(r.data.written).toEqual([]);
    expect(r.data.writeSkipped.reason).toBe('no-csdb-dir');
  });

  it('XSD に適合しない XML は allowInvalid: true が無い限り書かない', async () => {
    useSpec(SPEC_STRICT); // descript の本文に levelledPara を置けない XSD
    const dir = tmp();
    const args = { draft: draft(), allocation: allocation(), csdbDirs: [dir, LAX], write: true };
    const blocked = await call('build_data_module', args);
    expect(blocked.data.verification.schema.state).toBe('invalid');
    expect(blocked.data.written).toEqual([]);
    expect(blocked.data.writeSkipped.reason).toBe('schema-invalid');
    expect(readdirSync(dir)).toEqual([]);
    const forced = await call('build_data_module', { ...args, allowInvalid: true });
    expect(forced.data.written).toHaveLength(1);
    expect(forced.data.verification.schema.state).toBe('invalid');
  });

  it('入力の誤り（DraftInputError）は isError ではなく、path 付きの input-error で返る', async () => {
    const bad = await call('build_data_module', {
      draft: draft({ body: [{ kind: 'step', text: '手順は descript に置けない' }] }),
      allocation: allocation(),
    });
    expect(bad.isError).toBe(false);
    expect(bad.data.error).toMatchObject({ code: 'input-error', path: '/body[1]' });
    expect(bad.data.error.detail).toContain('cannot be placed');
    expect(bad.data.xml).toBeUndefined();

    const noInfoCode = await call('build_data_module', {
      draft: draft({ kind: 'proced', body: [{ kind: 'step', text: 'ボタンを押す。' }] }),
      allocation: allocation({
        rules: {
          sns: { systemCode: '10', subSystemCode: '2', subSubSystemCode: '0', assyCode: '00' },
          infoCodeByKind: { descript: { infoCode: '040', infoCodeVariant: 'A' } },
          itemLocationCode: 'D',
        },
      }),
    });
    expect(noInfoCode.isError).toBe(false);
    expect(noInfoCode.data.error).toMatchObject({
      code: 'input-error',
      path: '/allocation/rules/infoCodeByKind/proced',
    });
  });

  it('台帳を渡し直すと同じ sourceId には同じ DMC。別の sourceId は分解コードが進む。図は ICN を採番して返す', async () => {
    const first = await call('build_data_module', {
      draft: draft({
        body: [
          { kind: 'figure', title: '初期画面', refs: [{ kind: 'graphic', target: 'asset-home' }] },
        ],
      }),
      allocation: allocation(),
    });
    expect(first.data.icns['asset-home']).toMatch(/^ICN-K0001-00001-001-01$/);
    expect(first.data.icnNext).toBe(2);
    expect(first.data.xml).toContain(
      '<!ENTITY ICN-K0001-00001-001-01 SYSTEM "ICN-K0001-00001-001-01.PNG" NDATA png>',
    );
    const other = await call('build_data_module', {
      draft: draft({ sourceId: 'topic-other' }),
      allocation: allocation({
        ledger: first.data.ledger,
        icn: { cageCode: 'K0001', next: first.data.icnNext },
      }),
    });
    expect(other.data.dmCode).toBe('KENBAIKI-A-10-20-00-01A-040A-D'); // 分解コードの 2 桁目が進む
    const same = await call('build_data_module', {
      draft: draft(),
      allocation: allocation({
        ledger: other.data.ledger,
        icn: { cageCode: 'K0001', next: other.data.icnNext },
      }),
    });
    expect(same.data.dmCode).toBe('KENBAIKI-A-10-20-00-00A-040A-D'); // 台帳にある sourceId は同じ DMC
  });

  it('pm は pmCode を返し、PMC-….XML になる', async () => {
    useSpec(SPEC);
    const r = await call('build_data_module', {
      draft: draft({
        sourceId: 'manual-1',
        kind: 'pm',
        title: { techName: '指定席券売機' },
        body: [
          {
            kind: 'section',
            title: '概要',
            children: [
              {
                kind: 'entry',
                refs: [
                  {
                    kind: 'dmRef',
                    target: 'KENBAIKI-A-10-20-00-00A-040A-D',
                    title: '指定席券売機',
                  },
                ],
              },
            ],
          },
        ],
      }),
      allocation: allocation(),
      csdbDirs: [LAX],
    });
    expect(r.data.dmCode).toBeUndefined();
    expect(r.data.pmCode).toMatch(/^KENBAIKI-K0001-[A-Z0-9]{5}-00$/);
    expect(r.data.fileName).toMatch(/^PMC-KENBAIKI-K0001-[A-Z0-9]{5}-00_001-00_JA-JP\.XML$/);
    expect(r.data.verification.schema.state).toBe('valid');
    expect(r.data.verification.target.pmCode).toBeDefined();
    expect(r.data.verification.brex.layers).toBe(2); // PM も brexDmRef から連鎖をたどる
  });
});

describe('apply_fixes', () => {
  const offered = async (extra: Record<string, unknown> = {}) => {
    useSpec(SPEC);
    // 見本の DM（責任企業 K0001、段落に題名）。場所不明の選択を 1 つ渡し、返ってくる fixes[] から本物の候補を知る
    const probe = await call('apply_fixes', {
      path: DESCRIPT_DM,
      csdbDirs: [STRICT],
      selections: [{ location: { path: '/dmodule/nothing' }, action: 'remove' }],
      ...extra,
    });
    return probe;
  };

  it('候補と一致しない選択は rejected（理由付き）。何も適用しなければ XML は変わらない', async () => {
    const probe = await offered();
    expect(probe.isError).toBe(false);
    expect(probe.data.appliedCount).toBe(0);
    expect(probe.data.rejected).toHaveLength(1);
    expect(probe.data.rejected[0].reason).toBe('candidate-not-offered');
    expect(probe.data.xml).toBe(readFileSync(DESCRIPT_DM, 'utf8'));
    const kinds = probe.data.fixes.map(
      (f: { kind: string; confidence: string }) => `${f.kind}:${f.confidence}`,
    );
    expect(kinds).toEqual(expect.arrayContaining(['brex-value:exact', 'brex-forbidden:exact']));
  });

  it('提案された候補の写しだけを適用し、候補の外の値は rejected にする', async () => {
    const probe = await offered();
    const fix = probe.data.fixes.find((f: { source: string }) => f.source.endsWith('KB-00001'));
    const cand = fix.candidates[0];
    const sel = {
      location: fix.location,
      action: cand.action,
      target: cand.target,
      value: cand.value,
    };

    const wrong = await call('apply_fixes', {
      path: DESCRIPT_DM,
      csdbDirs: [STRICT],
      selections: [{ ...sel, value: 'K9999' }],
    });
    expect(wrong.data.appliedCount).toBe(0);
    expect(wrong.data.rejected[0]).toMatchObject({ reason: 'candidate-not-offered' });
    expect(wrong.data.xml).not.toContain('K9999');

    const ok = await call('apply_fixes', {
      path: DESCRIPT_DM,
      csdbDirs: [STRICT],
      selections: [sel],
    });
    expect(ok.data.appliedCount).toBe(1);
    expect(ok.data.applied[0].changed).toMatchObject({ before: 'K0001', after: 'K0002' });
    expect(ok.data.xml).toContain('enterpriseCode="K0002"');
    // 再検証: その違反は消え、段落の題名（選ばなかった）は残る
    expect(ok.data.verification.brex.violationCount).toBe(1);
    expect(
      ok.data.fixes.map((f: { kind: string }) => f.kind).filter((k: string) => k !== 'reference'),
    ).toEqual(['brex-forbidden']);
    // 元の宣言・DOCTYPE（ICN の ENTITY）は保たれる
    expect(ok.data.xml).toContain('<!DOCTYPE dmodule [');
    expect(ok.data.xml).toContain('<!ENTITY ICN-KENBAIKI-A-000000-0-K0001-00001-A-01-1 SYSTEM');
  });

  it('range の候補は、範囲に合う値だけを適用する（外れた値は value-not-allowed）。provide は文書を変えない', async () => {
    useSpec(SPEC);
    const xml = readFileSync(DESCRIPT_DM, 'utf8').replace('infoCode="040"', 'infoCode="041"');
    const probe = await call('apply_fixes', {
      xml,
      csdbDirs: [STRICT],
      selections: [{ location: { path: '/dmodule/nothing' }, action: 'remove' }],
    });
    const fix = probe.data.fixes.find((f: { source: string }) => f.source.endsWith('KB-00002'));
    const range = fix.candidates.find((c: { valueForm?: string }) => c.valueForm === 'range');
    const sel = (value: string) => ({
      location: fix.location,
      action: range.action,
      target: range.target,
      value,
    });

    const out = await call('apply_fixes', { xml, csdbDirs: [STRICT], selections: [sel('600')] });
    expect(out.data.rejected[0].reason).toBe('value-not-allowed');
    const inside = await call('apply_fixes', { xml, csdbDirs: [STRICT], selections: [sel('510')] });
    expect(inside.data.applied[0].changed).toMatchObject({ before: '041', after: '510' });
    expect(inside.data.xml).toContain('infoCode="510"');

    const provide = await call('apply_fixes', {
      xml,
      csdbDirs: [STRICT],
      selections: [{ action: 'provide', target: 'model', value: 'MV-50' }],
    });
    expect(provide.data.rejected[0].reason).toBe('provide-is-not-a-document-change');
  });

  it('write: true は path のファイルをその場で書き換える。write: false では書き換えない', async () => {
    useSpec(SPEC);
    const dir = tmp();
    const file = join(dir, 'copy.XML');
    copyFileSync(DESCRIPT_DM, file);
    const probe = await call('apply_fixes', {
      path: file,
      csdbDirs: [STRICT],
      selections: [{ location: { path: '/dmodule/nothing' }, action: 'remove' }],
    });
    const fix = probe.data.fixes.find((f: { source: string }) => f.source.endsWith('KB-00001'));
    const c = fix.candidates[0];
    const selections = [
      { location: fix.location, action: c.action, target: c.target, value: c.value },
    ];
    const dry = await call('apply_fixes', { path: file, csdbDirs: [STRICT], selections });
    expect(dry.data.written).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe(readFileSync(DESCRIPT_DM, 'utf8'));
    const wet = await call('apply_fixes', {
      path: file,
      csdbDirs: [STRICT],
      selections,
      write: true,
    });
    expect(wet.data.written).toEqual([file]);
    expect(readFileSync(file, 'utf8')).toBe(wet.data.xml);
    expect(readFileSync(file, 'utf8')).toContain('enterpriseCode="K0002"');
  });
});

describe('create_comment', () => {
  const comment = (over: Record<string, unknown> = {}) => ({
    refs: [{ kind: 'dmRef', code: 'KENBAIKI-A-10-20-00-00A-040A-D' }],
    commentType: 'q',
    commentPriorityCode: 'cp01',
    title: '用語の確認',
    paragraphs: ['「予約」の定義を確認してほしい。'],
    originator: {
      enterpriseName: 'Kenbaiki Works',
      address: { city: 'Tokyo', country: 'Japan' },
    },
    senderIdent: 'K0001',
    modelIdentCode: 'KENBAIKI',
    securityClassification: '01',
    language: { languageIsoCode: 'ja', countryIsoCode: 'JP' },
    brexDmRef: BREX_CODE,
    issueDate: '2026-10-28',
    yearOfDataIssue: 2026,
    ...over,
  });

  it('comment DM を組み立てて検証し、書き込みは write: true のときだけ。連番は CSDB の次の番号', async () => {
    useSpec(SPEC);
    const dir = tmp();
    const args = comment({ csdbDirs: [dir, LAX] });
    const dry = await call('create_comment', args);
    expect(dry.isError).toBe(false);
    expect(dry.data.commentCode).toBe('KENBAIKI-K0001-2026-00001-Q');
    expect(dry.data.fileName).toMatch(/^COM-KENBAIKI-K0001-2026-00001-Q/);
    expect(dry.data.xml).toContain('<comment');
    expect(dry.data.xml).toContain('commentPriorityCode="cp01"');
    expect(dry.data.verification.schema.state).toBe('valid');
    expect(dry.data.verification.brex).toMatchObject({ state: 'passed', layers: 2 });
    expect(dry.data.verification.target.commentCode).toBeDefined();
    expect(dry.data.written).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);

    const wet = await call('create_comment', { ...args, write: true });
    expect(wet.data.written).toHaveLength(1);
    const next = await call('create_comment', args);
    expect(next.data.commentCode).toBe('KENBAIKI-K0001-2026-00002-Q');
  });

  it('種類の混在など入力の誤りは input-error（isError ではない）', async () => {
    const r = await call(
      'create_comment',
      comment({
        refs: [
          { kind: 'dmRef', code: 'KENBAIKI-A-10-20-00-00A-040A-D' },
          { kind: 'pmRef', code: 'KENBAIKI-K0001-OPM01-00' },
        ],
      }),
    );
    expect(r.isError).toBe(false);
    expect(r.data.error.code).toBe('input-error');
    expect(r.data.error.path).toMatch(/^\/refs\[2\]/);
  });

  it('発信者の住所（city と country）が無いと、入力スキーマで弾かれる', async () => {
    const r = await call(
      'create_comment',
      comment({ originator: { enterpriseName: 'KW', address: { city: 'Tokyo' } } }),
    );
    expect(r.isError).toBe(true);
  });
});

describe('extract_segments / apply_segments', () => {
  it('文を出し、訳した文を元の DM に戻す（同じ DMC、language だけ違う）。結果は検証される', async () => {
    useSpec(SPEC);
    const ex = await call('extract_segments', { path: DESCRIPT_DM });
    expect(ex.isError).toBe(false);
    expect(ex.data.dmCode).toBe('KENBAIKI-A-10-20-00-00A-040A-D');
    expect(ex.data.language).toEqual({ languageIsoCode: 'ja', countryIsoCode: 'JP' });
    expect(ex.data.skeletonHash).toMatch(/^[0-9a-f]{64}$/);
    expect(ex.data.counts.total).toBe(ex.data.segments.length);
    const ids = ex.data.segments.map((s: { id: string }) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const titles = ex.data.segments.filter((s: { category: string }) => s.category === 'title');
    expect(titles.map((s: { text: string }) => s.text)).toContain('指定席券売機');
    expect(JSON.stringify(ex.data)).not.toContain('KENBAIKI-A-000000'); // ICN は出さない

    const only = await call('extract_segments', {
      path: DESCRIPT_DM,
      include: ['para'],
      maxSegments: 1,
    });
    expect(only.data.segments).toHaveLength(1);

    const dir = tmp();
    const translated = ex.data.segments.map((s: { id: string; text: string }) => ({
      id: s.id,
      text: `[en] ${s.text}`,
    }));
    const bad = { id: 'no-such-segment', text: 'x' };
    const ap = await call('apply_segments', {
      path: DESCRIPT_DM,
      skeletonHash: ex.data.skeletonHash,
      segments: [...translated, bad],
      language: { languageIsoCode: 'en', countryIsoCode: 'US' },
      csdbDirs: [dir],
    });
    expect(ap.isError).toBe(false);
    expect(ap.data.fileName).toBe('DMC-KENBAIKI-A-10-20-00-00A-040A-D_002-01_EN-US.XML');
    expect(ap.data.applied).toBe(translated.length);
    expect(ap.data.unapplied).toEqual([{ id: 'no-such-segment', reason: 'unknown-id' }]);
    expect(ap.data.xml).toContain('languageIsoCode="en" countryIsoCode="US"');
    expect(ap.data.xml).toContain('[en] 指定席券売機');
    expect(ap.data.verification.schema.state).toBe('valid');
    expect(ap.data.written).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);

    const wet = await call('apply_segments', {
      path: DESCRIPT_DM,
      skeletonHash: ex.data.skeletonHash,
      segments: translated,
      language: { languageIsoCode: 'en', countryIsoCode: 'US' },
      csdbDirs: [dir],
      write: true,
    });
    expect(wet.data.written).toEqual([
      join(dir, 'DMC-KENBAIKI-A-10-20-00-00A-040A-D_002-01_EN-US.XML'),
    ]);
  });

  it('DM が変わっていると skeleton-mismatch で止まる（isError ではない）', async () => {
    const ex = await call('extract_segments', { path: DESCRIPT_DM });
    const changed = readFileSync(DESCRIPT_DM, 'utf8')
      .replace('<levelledPara>', '<levelledPara id="x">')
      .replace('<para>', '<para><emphasis>強</emphasis>');
    const ap = await call('apply_segments', {
      xml: changed,
      skeletonHash: ex.data.skeletonHash,
      segments: [],
      language: { languageIsoCode: 'en', countryIsoCode: 'US' },
    });
    expect(ap.isError).toBe(false);
    expect(ap.data.error.code).toBe('skeleton-mismatch');
  });
});

describe('convert_manual', () => {
  const manualJson = () => JSON.parse(readFileSync(MANUAL, 'utf8')) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

  /** 素材の原本の代わりの小さなファイルを用意する（マニュアルの Asset.source.path のとおり） */
  function assetDir(): string {
    const dir = tmp();
    for (const a of manualJson().assets) {
      const p = join(dir, a.source.path);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, `dummy ${a.id}`);
    }
    return dir;
  }

  const args = (over: Record<string, unknown> = {}) => ({
    manualPath: MANUAL,
    allocation: allocation({ brexDmRef: undefined }),
    securityClassification: '01',
    responsiblePartnerCompany: 'K0001',
    assetBaseDir: assetDir(),
    ...over,
  });
  // brexDmRef: undefined は JSON にならない（allocation に載せない）。BREX は lax の KENBAIKI 022A を brexDmRef に使う
  const withBrex = (over: Record<string, unknown> = {}) => {
    const a = args(over);
    (a.allocation as Record<string, unknown>).brexDmRef = BREX_CODE;
    return a;
  };

  it('券売機の例を Topic ごとの DM と PM にし、自作の XSD・BREX（lax）で全部 valid / passed。write: false なら何も書かない', async () => {
    useSpec(SPEC);
    const dir = tmp();
    const r = await call('convert_manual', withBrex({ csdbDirs: [dir, LAX] }));
    expect(r.isError).toBe(false);
    expect(r.data.error).toBeUndefined();
    // 説明 1、画面遷移 1 ＋ 画面 4、手順 1、故障探求 1、用語集 1 ＋ PM 1
    expect(r.data.summary).toMatchObject({
      dataModules: 9,
      publicationModules: 1,
      failedToBuild: 0,
      brexViolationCount: 0,
      unresolvedReferenceCount: 0,
      written: 0,
    });
    expect(r.data.summary.schema.valid).toBe(10);
    expect(r.data.summary.brex.passed).toBe(10);
    expect(r.data.summary.references.resolved).toBe(10);
    const roles = r.data.dataModules.map((d: { role: string }) => d.role);
    expect(roles.filter((x: string) => x === 'screen')).toHaveLength(4);
    const kinds = r.data.dataModules.map(
      (d: { fileName: string }) => /-(\d{3})A-D_/.exec(d.fileName)![1],
    );
    expect(kinds.filter((k: string) => k === '130')).toHaveLength(1); // process
    expect(kinds.filter((k: string) => k === '411')).toHaveLength(1); // fault
    expect(r.data.dataModules.every((d: { xml?: string }) => typeof d.xml === 'string')).toBe(true);
    expect(r.data.publicationModule.pmCode).toMatch(/^KENBAIKI-K0001-/);
    expect(readdirSync(dir)).toEqual([]);
    // 素材: 6 つすべて使われ、ICN が付き、原本が見つかっている
    expect(r.data.assets).toHaveLength(6);
    expect(
      r.data.assets.every(
        (a: { icn: string; sourceExists: boolean }) => /^ICN-K0001-/.test(a.icn) && a.sourceExists,
      ),
    ).toBe(true);
    expect(
      r.data.assets.find((a: { assetId: string }) => a.assetId === 'model-door').fileName,
    ).toMatch(/\.JT$/);
    // 表せなかったものは黙って捨てず、件数で返す
    const lost = r.data.notRepresented.map((n: { what: string }) => n.what).join('\n');
    expect(lost).toContain('Hotspot');
    expect(lost).toContain('scopeRefs');
  });

  it('write: true で DM・PM を書き、原本を ICN のファイル名でコピーする。台帳を渡し直すと同じ DMC になる', async () => {
    useSpec(SPEC);
    const dir = tmp();
    const base = withBrex({ csdbDirs: [dir, LAX], write: true });
    const r = await call('convert_manual', base);
    expect(r.data.summary.written).toBe(10);
    const files = readdirSync(dir);
    expect(files.filter((f) => f.startsWith('DMC-'))).toHaveLength(9);
    expect(files.filter((f) => f.startsWith('PMC-'))).toHaveLength(1);
    expect(files.filter((f) => f.startsWith('ICN-'))).toHaveLength(6);
    expect(
      readFileSync(
        join(
          dir,
          files.find((f) => f.endsWith('.JT'))!,
        ),
        'utf8',
      ),
    ).toBe('dummy model-door');
    expect(r.data.dataModules.every((d: { xml?: string }) => d.xml === undefined)).toBe(true); // write 時は XML を返さない

    // 2 回目: 書いた DM があるので版は 002-00。台帳を渡せば DMC は同じ
    const dm = (res: typeof r) =>
      res.data.dataModules.map((d: { sourceId: string; dmCode: string }) => [d.sourceId, d.dmCode]);
    const again = await call('convert_manual', {
      ...base,
      write: false,
      allocation: {
        ...(base.allocation as object),
        ledger: r.data.ledger,
        icn: { cageCode: 'K0001', next: r.data.icnNext },
      },
    });
    expect(dm(again)).toEqual(dm(r));
    // 版はマニュアルの版から決まる。書いてある版をもう一度書こうとしても上書きしない
    const twice = await call('convert_manual', {
      ...base,
      allocation: {
        ...(base.allocation as object),
        ledger: r.data.ledger,
        icn: { cageCode: 'K0001', next: r.data.icnNext },
      },
    });
    expect(twice.data.summary.written).toBe(0);
    expect(readdirSync(dir).filter((f) => f.startsWith('DMC-'))).toHaveLength(9);
  });

  it('原本が見つからない素材の ICN は未解決として報告する（コピーもしない）', async () => {
    useSpec(SPEC);
    const r = await call(
      'convert_manual',
      withBrex({ csdbDirs: [tmp(), LAX], assetBaseDir: tmp() }),
    );
    expect(r.data.assets.every((a: { sourceExists: boolean }) => !a.sourceExists)).toBe(true);
    expect(r.data.summary.references.unresolved).toBeGreaterThan(0);
    expect(r.data._notes.join('\n')).toContain('original file(s) were not found');
  });

  it('topics で変換する Topic を絞る（用語集は全部のときだけ）', async () => {
    const r = await call(
      'convert_manual',
      withBrex({ csdbDirs: [LAX], topics: ['topic-open-door'] }),
    );
    expect(r.data.summary.dataModules).toBe(1);
    expect(r.data.dataModules[0].topicId).toBe('topic-open-door');
    const bad = await call('convert_manual', withBrex({ csdbDirs: [LAX], topics: ['nope'] }));
    expect(bad.data.error).toMatchObject({ code: 'input-error', path: '/topics' });
  });

  it('マニュアルの誤りと採番の規則の不足は input-error', async () => {
    const m = manualJson();
    m.topics[1].screens[0].hotspots[0].transition.to = 'scr-nowhere';
    const invalid = await call('convert_manual', withBrex({ manualPath: undefined, manual: m }));
    expect(invalid.isError).toBe(false);
    expect(invalid.data.error.code).toBe('input-error');
    expect(JSON.stringify(invalid.data.error.issues)).toContain('scr-nowhere');

    const noInfo = await call(
      'convert_manual',
      withBrex({
        allocation: {
          modelIdentCode: 'KENBAIKI',
          systemDiffCode: 'A',
          rules: {
            sns: { systemCode: '10', subSystemCode: '2', subSubSystemCode: '0', assyCode: '00' },
            infoCodeByKind: { descript: { infoCode: '040', infoCodeVariant: 'A' } },
            itemLocationCode: 'D',
          },
          icn: { cageCode: 'K0001', next: 1 },
          brexDmRef: BREX_CODE,
        },
      }),
    );
    expect(noInfo.isError).toBe(false);
    expect(noInfo.data.error.code).toBe('input-error');
    expect(noInfo.data.error.path).toMatch(/^\/allocation\/rules\/infoCodeByKind\//);
  });
});

describe('write は何も書かない既定', () => {
  it('この試験でフォルダーが増えていない（tmp の外には書かない）', () => {
    expect(
      existsSync(join(fixtures, 'csdb-lax')) && readdirSync(join(fixtures, 'csdb-lax')),
    ).toHaveLength(2);
    expect(readdirSync(STRICT)).toHaveLength(4);
  });
});
