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
        refs: [{ kind: 'dmRef', target: dmcOf(r, 't-refill'), title: manual.title }],
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

  it('dmRef で表せない位置（別の DM の先頭以外の手順）と、行き先の無い next は件数で返す', () => {
    const l = lost(run());
    expect(
      l[
        'the step inside another data module that a Step.next points at (the dmRef points at the data module)'
      ],
    ).toBe(1);
    expect(l['Step.next to an id that is not a step, a screen or a topic']).toBe(1);
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
