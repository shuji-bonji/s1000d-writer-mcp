/**
 * 変換関数（体験型マニュアル → 下書き）を直接呼び、手順の飛び先（Step.next）が参照になることを確かめる。
 * テストデータは自作。XML の組み立てと検証は server.test.ts と spec.test.ts が確かめる。
 */
import { describe, expect, it } from 'vitest';
import type { Allocation, DraftNode } from '@shuji-bonji/s1000d-core';
import type { Manual } from '@shuji-bonji/experiential-manual-model';
import { manualToDrafts } from './manual-to-draft.js';

const allocation: Allocation = {
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
};

const manual: Manual = {
  id: 'm-next',
  title: '券売機 保守の手引き',
  version: { number: '1' },
  language: 'ja-JP',
  assets: [{ id: 'img-panel', kind: 'image', source: { path: 'panel.png' } }],
  topics: [
    {
      id: 't-start',
      kind: 'procedure',
      title: '始動',
      steps: [
        { id: 's1', text: '扉を開ける。', next: [{ to: 's2' }] },
        {
          id: 's2',
          text: '表示を見る。',
          next: [
            { to: 's4', condition: '表示が消えているとき' },
            { to: 'r1' },
            { to: 'r2', condition: '用紙が無いとき' },
            { to: 'scr-main' },
          ],
          children: [
            { id: 's2a', text: '電源のランプを見る。', next: [{ to: 's2b' }] },
            { id: 's2b', text: '用紙のランプを見る。', next: [{ to: 's3' }] },
          ],
        },
        { id: 's3', text: '扉を閉める。' },
        { id: 's4', text: '係員を呼ぶ。', next: [{ to: 'nowhere' }] },
      ],
    },
    {
      id: 't-refill',
      kind: 'procedure',
      title: '用紙の補充',
      steps: [
        { id: 'r1', text: '用紙を出す。' },
        { id: 'r2', text: '用紙を入れる。' },
      ],
    },
    {
      id: 't-screens',
      kind: 'screenFlow',
      title: '画面',
      screens: [{ id: 'scr-main', caption: 'メイン画面', assetRef: 'img-panel', hotspots: [] }],
    },
    {
      id: 't-trouble',
      kind: 'troubleshooting',
      title: '始動しないとき',
      steps: [
        {
          id: 'q1',
          text: '電源を確かめる。',
          question: 'ランプは点いているか。',
          answers: [
            { text: 'はい', next: { to: 'a1' } },
            { text: 'いいえ', next: { to: 'a2' } },
          ],
        },
        { id: 'a1', text: '始動の手順に戻って、続きを行う。', next: [{ to: 's1' }] },
        {
          id: 'a2',
          text: '電源を入れる。',
          next: [{ to: 'q1', condition: 'ランプが点いたとき' }],
        },
      ],
    },
  ],
};

const run = (topics?: string[]) =>
  manualToDrafts(manual, { allocation, securityClassification: '01', topics });
const bodyOf = (r: ReturnType<typeof run>, sourceId: string) =>
  r.drafts.find((d) => d.sourceId === sourceId)!.draft.body;
const dmcOf = (r: ReturnType<typeof run>, sourceId: string) => {
  const c = r.drafts.find((d) => d.sourceId === sourceId)!.dmCode!;
  return `${c.modelIdentCode}-${c.systemDiffCode}-${c.systemCode}-${c.subSystemCode}${c.subSubSystemCode}-${c.assyCode}-${c.disassyCode}${c.disassyCodeVariant}-${c.infoCode}${c.infoCodeVariant}-${c.itemLocationCode}`;
};
const paras = (n: DraftNode) => (n.children ?? []).filter((c) => c.kind === 'para');
const lost = (r: ReturnType<typeof run>) =>
  Object.fromEntries(r.notRepresented.map((n) => [n.what, n.count]));

describe('manualToDrafts: Step.next', () => {
  it('並びのとおりに次へ進むだけの next は何も書かず、表せなかったものにも数えない', () => {
    const r = run();
    const [s1, s2] = bodyOf(r, 't-start');
    expect(paras(s1!)).toEqual([]);
    const [s2a, s2b] = (s2!.children ?? []).filter((c) => c.kind === 'step');
    expect(paras(s2a!)).toEqual([]);
    // 最後の子から親の次の手順へ進むのも、並びのとおり
    expect(paras(s2b!)).toEqual([]);
    expect(Object.keys(lost(r)).some((w) => w.startsWith('Step.next (the order'))).toBe(false);
  });

  it('同じ Topic の手順へは internalRef、別の Topic の手順・画面へは dmRef を、条件の文と一緒に書く', () => {
    const r = run();
    const s2 = bodyOf(r, 't-start')[1]!;
    expect(paras(s2)).toEqual([
      {
        kind: 'para',
        text: '表示が消えているとき、次に進む: ',
        refs: [{ kind: 'internalRef', target: 's4' }],
      },
      {
        kind: 'para',
        text: '次に進む: ',
        refs: [{ kind: 'dmRef', target: dmcOf(r, 't-refill'), title: manual.title }],
      },
      {
        kind: 'para',
        text: '用紙が無いとき、次に進む: ',
        // 別の DM の先頭以外の手順は、fragment（@referredFragment）で指す
        refs: [
          { kind: 'dmRef', target: dmcOf(r, 't-refill'), title: manual.title, fragment: 'r2' },
        ],
      },
      {
        kind: 'para',
        text: '次に進む: ',
        refs: [{ kind: 'dmRef', target: dmcOf(r, 't-screens/scr-main'), title: manual.title }],
      },
    ]);
    // 飛び先の段落は、入れ子の手順より前に置く
    expect((s2.children ?? []).map((c) => c.kind)).toEqual([
      'para',
      'para',
      'para',
      'para',
      'step',
      'step',
    ]);
  });

  it('行き先の無い next は件数で返す', () => {
    const l = lost(run());
    expect(l['Step.next to an id that is not a step, a screen or a topic']).toBe(1);
    expect(Object.keys(l).some((w) => w.startsWith('the step inside another data module'))).toBe(
      false,
    );
  });

  it('困ったときの対処: 条件の無い next は対処の文の後ろの参照に、条件のある next は条件の文にする', () => {
    const r = run();
    const [, a1, a2] = bodyOf(r, 't-trouble');
    expect(a1).toMatchObject({
      text: '始動の手順に戻って、続きを行う。',
      refs: [{ kind: 'dmRef', target: dmcOf(r, 't-start'), title: manual.title }],
    });
    expect(a1!.children).toBeUndefined();
    expect(a2!.refs).toBeUndefined();
    expect(paras(a2!)).toEqual([
      {
        kind: 'para',
        text: 'ランプが点いたとき、次に進む: ',
        refs: [{ kind: 'internalRef', target: 'q1' }],
      },
    ]);
    expect(Object.keys(lost(r)).some((w) => w.startsWith('Step.next on a troubleshooting'))).toBe(
      false,
    );
  });

  it('変換しない Topic への next は件数で返す', () => {
    const r = run(['t-trouble']);
    expect(bodyOf(r, 't-trouble')[1]!.refs).toBeUndefined();
    expect(lost(r)['Step.next to a topic that is not converted in this call']).toBe(1);
  });
});

describe('manualToDrafts: 作業前の要件（Topic.prerequisites）', () => {
  const withPre = (): Manual => {
    const m: Manual = JSON.parse(JSON.stringify(manual));
    m.topics[0]!.prerequisites = {
      conditions: [
        { text: '発売を停止していること。' },
        { text: '用紙を補充してあること。', topicRef: 't-refill' },
      ],
      personnel: [{ role: '係員', count: 2 }, { role: '補助者' }],
      references: [
        { title: '保守の手引き', code: 'KB-M-001' },
        { title: '用紙の補充', topicRef: 't-refill', code: 'X-1' },
      ],
      equipment: [
        {
          name: '保守鍵',
          quantity: '1',
          unit: 'EA',
          partNumber: 'KEY-01',
          manufacturerCode: 'K0001',
          note: '係員が持つ',
        },
        { name: 'ドライバー' },
      ],
      supplies: [{ name: 'ウエス', quantity: '1' }],
      spares: [{ name: 'ヒューズ', quantity: '2', manufacturerCode: 'K0001' }],
      safety: [
        { level: 'warning', title: '感電', text: '指定された場所以外に触れない。' },
        { level: 'caution', text: '扉は重い。' },
      ],
    };
    m.topics[3]!.prerequisites = { safety: [{ level: 'warning', text: '高電圧。' }] };
    m.topics[2]!.prerequisites = { conditions: [{ text: '表示する場所が無い' }] };
    return m;
  };
  const convert = (topics?: string[]) =>
    manualToDrafts(withPre(), { allocation, securityClassification: '01', topics });

  it('7 つの区分を、DM の先頭の requirements に写す', () => {
    const r = convert();
    const body = bodyOf(r, 't-start');
    const refill = {
      kind: 'dmRef',
      target: dmcOf(r, 't-refill'),
      title: manual.title,
      infoName: '用紙の補充',
    };
    expect(body[0]).toEqual({
      kind: 'requirements',
      children: [
        { kind: 'para', text: '発売を停止していること。' },
        { kind: 'para', text: '用紙を補充してあること。', refs: [refill] },
        { kind: 'person', text: '係員', count: 2 },
        { kind: 'person', text: '補助者' },
        { kind: 'document', title: '保守の手引き', text: 'KB-M-001' },
        { kind: 'document', refs: [refill] },
        {
          kind: 'equipment',
          title: '保守鍵',
          text: '係員が持つ',
          quantity: '1',
          unit: 'EA',
          partNumber: 'KEY-01',
          manufacturerCode: 'K0001',
        },
        { kind: 'spare', title: 'ヒューズ', quantity: '2', manufacturerCode: 'K0001' },
        {
          kind: 'admonition',
          level: 'warning',
          children: [
            { kind: 'para', text: '感電' },
            { kind: 'para', text: '指定された場所以外に触れない。' },
          ],
        },
        { kind: 'admonition', level: 'caution', text: '扉は重い。' },
      ],
    });
    expect(body[1]).toMatchObject({ kind: 'step', id: 's1' });
    // 困ったときの Topic も同じ
    expect(bodyOf(r, 't-trouble')[0]).toEqual({
      kind: 'requirements',
      children: [{ kind: 'admonition', level: 'warning', text: '高電圧。' }],
    });
    // 要件の無い Topic には requirements を置かない
    expect(bodyOf(r, 't-refill')[0]).toMatchObject({ kind: 'step' });
  });

  it('識別子か数量の無い品目は書かず、件数で返す（値は補わない）。写せないものも件数で返す', () => {
    const l = lost(convert());
    expect(
      l[
        'prerequisites item without manufacturerCode or quantity (S1000D requires an identifier and a quantity for each item; none is made up)'
      ],
    ).toBe(2);
    expect(
      l['DocumentReference.code on a reference to a topic (the data module is the reference)'],
    ).toBe(1);
    expect(l['prerequisites on a topic that is not a procedure or troubleshooting topic']).toBe(1);
    // 変換しない Topic への topicRef は、文だけを書く
    const only = convert(['t-start']);
    expect(lost(only)['prerequisites topicRef to a topic that is not converted in this call']).toBe(
      2,
    );
    const children = bodyOf(only, 't-start')[0]!.children!;
    expect(children[1]).toEqual({ kind: 'para', text: '用紙を補充してあること。' });
    expect(children[5]).toEqual({ kind: 'document', title: '用紙の補充', text: 'X-1' });
  });
});

describe('manualToDrafts: 画面の手順の文（Hotspot の label・description・callout）', () => {
  const screen = (language: string) => {
    const m: Manual = JSON.parse(JSON.stringify(manual));
    m.language = language;
    m.topics[2]!.screens![0]!.hotspots = [
      {
        id: 'h1',
        label: '[Exit]',
        description: 'メイン画面に戻る',
        callout: '3',
        shape: 'rect',
        coords: [0, 0, 10, 10],
        action: 'press',
      },
      { id: 'h2', label: '燃料計', shape: 'rect', coords: [0, 0, 10, 10], action: 'read' },
    ];
    const r = manualToDrafts(m, { allocation, securityClassification: '01' });
    return bodyOf(r, 't-screens/scr-main')[0]!.children!.filter((c) => c.kind === 'step');
  };

  it('名前だけから操作の文を作り、説明は後ろの別の文に、図の番号は先頭に置く', () => {
    expect(screen('ja-JP').map((s) => s.text)).toEqual([
      '（3）[Exit]を押す。メイン画面に戻る。',
      '燃料計を確認する。',
    ]);
    expect(screen('en-US').map((s) => s.text)).toEqual([
      '(3) Press [Exit]. メイン画面に戻る.',
      'Read 燃料計.',
    ]);
  });
});
