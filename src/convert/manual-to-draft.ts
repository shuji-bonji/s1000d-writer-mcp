/**
 * 体験型マニュアル（experiential-manual-model の `Manual`）を、データモジュールの入力（`DraftDataModule`）に変換する。
 *
 * 設計: s1000d-stack の docs/design/writer-mcp.md「`convert_manual` の対応」、docs/design/manual-model.md「S1000D との対応」。
 * D-09: S1000D との対応は、manual-model には入れず、この変換関数に集める。MCP を介さずライブラリとしても呼べる
 * （`@shuji-bonji/s1000d-writer-mcp/convert`）。XML は作らない。XML の組み立ては core の `buildDataModule`。
 *
 * 対応（Topic ごと）:
 * - description → descript（blocks を節点に 1 対 1。summary は先頭の段落）
 * - procedure → proced（steps を step の入れ子に。expected は手順の文の末尾、admonitions は手順の先頭の警告・注意）
 * - troubleshooting → fault（steps を平らにし、question / answers を問いと選択肢に）
 * - screenFlow → process 1 件（画面を dmNode、条件付きの遷移を dmIf に）＋ 画面ごとの proced
 *   process の dmNode は画面ごとの proced を dmRef で呼ぶ。操作できる場所（Hotspot）は proced の手順になる
 * - Manual → pm（Topic の並び）、glossary → descript（用語の定義リスト）、Scope → applic、Asset → ICN の図
 *
 * 表せないもの（`notRepresented` に件数と場所を返す。黙って捨てない）:
 * - Hotspot の形と座標、`hotspot/@applicationStructureIdent`（core の `DraftNode` に hotspot が無い）
 * - 手順・ブロックごとの scopeRefs（DM 単位の applic だけ。`applicRefId` が指す applic の置き場所が core に無い）
 * - 木にならない遷移（戻る遷移など）、Step.next / targetRef、Asset.display、ACT（`DraftKind` に無い）
 * 木にならない遷移は、画面の proced の手順の文に「次の画面」として書く。
 */
import { extname } from 'node:path';
import {
  DraftInputError,
  allocateDmc,
  allocatePmc,
  formatDmc,
  formatPmc,
  type Allocation,
  type CsdbIndex,
  type DmCode,
  type DraftApplic,
  type DraftDataModule,
  type DraftKind,
  type DraftNode,
  type DraftRef,
  type GraphicFormat,
  type IssueInfo,
  type Language,
} from '@shuji-bonji/s1000d-core';
import type {
  Admonition,
  Asset,
  Block,
  Hotspot,
  Manual,
  Scope,
  Screen,
  Step,
  Topic,
} from '@shuji-bonji/experiential-manual-model';

export interface ConvertOptions {
  /** 採番の規則と台帳。DMC・PMC・ICN は writer が付ける。情報コードの既定は持たない（kind ごとに与える） */
  allocation: Allocation;
  /** 機密区分（列挙のまま。Manual に無いので省略を許さない） */
  securityClassification: string;
  /** 省略すると `Manual.language`。BCP 47 の文字列か、languageIsoCode と countryIsoCode */
  language?: string | Language;
  /** 変換する `Topic.id`（省略で全部）。用語集は省略したときだけ変換する */
  topics?: string[];
  /** Scope を持たない DM と PM の適用性。省略すると表示文だけの「すべて」 */
  defaultApplic?: DraftApplic;
  responsiblePartnerCompany?: string;
  originator?: string;
  /** 図の原本の形式（Asset.id → 形式）。省略すると原本の拡張子から決める */
  assetFormats?: Record<string, GraphicFormat>;
  /** 既存の DMC・PMC を避ける採番のために使う */
  index?: CsdbIndex;
  /** false なら PM を作らない（既定 true） */
  publicationModule?: boolean;
}

export type DraftRole = 'topic' | 'screen' | 'glossary' | 'publication-module';

export interface ConvertedDraft {
  draft: DraftDataModule;
  role: DraftRole;
  /** 採番の元（台帳のキー） */
  sourceId: string;
  topicId?: string;
  screenId?: string;
  /** 採番済みの DMC（PM では undefined） */
  dmCode?: DmCode;
  /** 採番済みの PMC の文字列 */
  pmCode?: string;
}

export interface ConvertedAsset {
  assetId: string;
  kind: Asset['kind'];
  /** 原本のパス（`Asset.source.path`。マニュアルからの相対のまま） */
  sourcePath: string;
  /** DOCTYPE の ENTITY / NOTATION に使う形式 */
  format: GraphicFormat;
}

export interface NotRepresented {
  /** 何が表せなかったか */
  what: string;
  count: number;
  /** 場所（最初の 5 件） */
  where: string[];
}

export interface ConvertResult {
  /** 作る順（DM を先に、PM を最後に） */
  drafts: ConvertedDraft[];
  /** 台帳に全 DM・PM の採番を加えた allocation（これを buildDataModule に渡せば、相互の参照が解決する） */
  allocation: Allocation;
  /** 使われた素材（Asset.id の順） */
  assets: ConvertedAsset[];
  assetFormats: Record<string, GraphicFormat>;
  notRepresented: NotRepresented[];
  notes: string[];
}

// ---------------------------------------------------------------------------
// 小さな道具

const COUNTRY_OF: Record<string, string> = {
  ja: 'JP',
  en: 'US',
  de: 'DE',
  fr: 'FR',
  es: 'ES',
  it: 'IT',
  zh: 'CN',
  ko: 'KR',
  pt: 'PT',
  ru: 'RU',
  nl: 'NL',
  sv: 'SE',
};

/** BCP 47（`ja`、`en-US`）を languageIsoCode と countryIsoCode に分ける。国が無いときは表で補い、補ったことを返す */
export function parseLanguage(
  input: string | Language | undefined,
  path = '/language',
): { language: Language; note?: string } {
  if (input && typeof input === 'object') {
    if (!input.languageIsoCode || !input.countryIsoCode) {
      throw new DraftInputError(path, 'language needs both languageIsoCode and countryIsoCode');
    }
    return { language: input };
  }
  const tag = (input ?? '').trim();
  if (!tag) throw new DraftInputError(path, 'language is required');
  const parts = tag.split(/[-_]/);
  const lang = parts[0]!.toLowerCase();
  if (!/^[a-z]{2,3}$/.test(lang)) {
    throw new DraftInputError(path, `"${tag}" is not a BCP 47 language tag`);
  }
  const region = parts.slice(1).find((p) => /^[A-Za-z]{2}$/.test(p));
  if (region) return { language: { languageIsoCode: lang, countryIsoCode: region.toUpperCase() } };
  const country = COUNTRY_OF[lang];
  if (!country) {
    throw new DraftInputError(
      path,
      `"${tag}" has no region and there is no default country for "${lang}": give language as { languageIsoCode, countryIsoCode } or a tag like "${lang}-XX"`,
    );
  }
  return {
    language: { languageIsoCode: lang, countryIsoCode: country },
    note: `language: "${tag}" has no region; used ${lang}-${country}.`,
  };
}

/** `1.0` → 001-00、`2` → 002-00。読めない表記（`2026-10` など）は undefined */
export function issueInfoOfVersion(number: string): IssueInfo | undefined {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(number.trim());
  if (!m) return undefined;
  return { issueNumber: m[1]!.padStart(3, '0'), inWork: (m[2] ?? '0').padStart(2, '0') };
}

/** XML の id にできる文字列にする（英字か _ で始め、英数字・_・.・- だけ） */
export function xmlId(raw: string): string {
  const s = raw.replace(/[^A-Za-z0-9_.-]/g, '-');
  return /^[A-Za-z_]/.test(s) ? s : `id-${s}`;
}

interface Phrases {
  join(a: string, b: string): string;
  hotspot(label: string, action: Hotspot['action'], next?: string, condition?: string): string;
  all: string;
  glossary: string;
  sep: string;
}

const PHRASES: Record<'ja' | 'en', Phrases> = {
  ja: {
    join: (a, b) => `${a}${b}`,
    hotspot: (label, action, next, condition) => {
      const verb =
        action === 'press'
          ? '押す'
          : action === 'input'
            ? '入力する'
            : action === 'read'
              ? '確認する'
              : '操作する';
      const go = next ? `${condition ? `${condition}、` : ''}「${next}」に進む。` : '';
      return `${label}を${verb}。${go}`;
    },
    all: 'すべて',
    glossary: '用語',
    sep: '、',
  },
  en: {
    join: (a, b) => `${a} ${b}`,
    hotspot: (label, action, next, condition) => {
      const verb =
        action === 'press'
          ? 'Press'
          : action === 'input'
            ? 'Enter'
            : action === 'read'
              ? 'Read'
              : 'Operate';
      const go = next ? ` ${condition ? `If ${condition}, go` : 'Go'} to "${next}".` : '';
      return `${verb} ${label}.${go}`;
    },
    all: 'All',
    glossary: 'Glossary',
    sep: ', ',
  },
};

/** 図の原本の拡張子から、DOCTYPE の ENTITY / NOTATION の形式を決める */
const KNOWN_FORMATS: Record<string, GraphicFormat> = {
  png: { extension: 'PNG', notation: 'png' },
  jpg: { extension: 'JPG', notation: 'jpg' },
  jpeg: { extension: 'JPG', notation: 'jpg' },
  gif: { extension: 'GIF', notation: 'gif' },
  svg: { extension: 'SVG', notation: 'svg' },
  cgm: { extension: 'CGM', notation: 'cgm' },
  pdf: { extension: 'PDF', notation: 'pdf' },
};

export function formatOfAsset(asset: Asset): { format: GraphicFormat; placeholder: boolean } {
  const ext = extname(asset.source.path).slice(1).toLowerCase();
  const known = KNOWN_FORMATS[ext];
  if (known) return { format: known, placeholder: false };
  if (!/^[a-z0-9]{1,8}$/.test(ext)) {
    throw new DraftInputError(
      `/assets/${asset.id}`,
      `cannot tell the file format of "${asset.source.path}": it has no usable extension; give assetFormats["${asset.id}"]`,
    );
  }
  return {
    format: {
      extension: ext.toUpperCase(),
      notation: ext,
      publicId: `-//s1000d-writer-mcp//NOTATION ${ext}//EN`,
    },
    placeholder: true,
  };
}

// ---------------------------------------------------------------------------
// 変換

class Converter {
  readonly drafts: ConvertedDraft[] = [];
  readonly notes: string[] = [];
  private readonly lost = new Map<string, { count: number; where: string[] }>();
  private readonly scopes = new Map<string, Scope>();
  private readonly assets = new Map<string, Asset>();
  readonly usedAssets = new Set<string>();
  private allocation: Allocation;
  private language!: Language;
  private lang!: 'ja' | 'en';
  private phrases!: Phrases;
  private issueInfo?: IssueInfo;
  private issueDate?: string;
  private defaultApplic!: DraftApplic;

  constructor(
    private readonly manual: Manual,
    private readonly options: ConvertOptions,
  ) {
    this.allocation = { ...options.allocation, ledger: { ...(options.allocation.ledger ?? {}) } };
    for (const s of manual.scopes ?? []) this.scopes.set(s.id, s);
    for (const a of manual.assets ?? []) this.assets.set(a.id, a);
  }

  private lose(what: string, where: string): void {
    const e = this.lost.get(what) ?? { count: 0, where: [] };
    e.count++;
    if (e.where.length < 5) e.where.push(where);
    this.lost.set(what, e);
  }

  notRepresented(): NotRepresented[] {
    return [...this.lost.entries()].map(([what, e]) => ({ what, count: e.count, where: e.where }));
  }

  // ---- 採番 ----

  private allocate(sourceId: string, kind: DraftKind): DmCode {
    const a = allocateDmc(sourceId, { kind }, this.allocation, this.options.index);
    this.allocation = { ...this.allocation, ledger: a.ledger };
    return a.dmCode;
  }

  // ---- 共通部分 ----

  private applicOf(scopeRefs: string[] | undefined): DraftApplic {
    if (!scopeRefs || scopeRefs.length === 0) return this.defaultApplic;
    const used = scopeRefs.map((id) => this.scopes.get(id)).filter((s): s is Scope => !!s);
    if (used.length === 0) return this.defaultApplic;
    // 同じ property の値は「または」（値を | でつなぐ）、違う property は「かつ」
    const byProperty = new Map<string, string[]>();
    for (const s of used) {
      const list = byProperty.get(s.property) ?? [];
      for (const v of s.values) if (!list.includes(v)) list.push(v);
      byProperty.set(s.property, list);
    }
    const asserts = [...byProperty.entries()].map(([property, values]) => ({
      applicPropertyIdent: property,
      applicPropertyType: 'prodattr' as const,
      applicPropertyValues: values.join('|'),
    }));
    const displayText = [...new Set(used.map((s) => s.displayText))].join(this.phrases.sep);
    return asserts.length > 1
      ? { displayText, assert: asserts, andOr: 'and' }
      : { displayText, assert: asserts };
  }

  private base(
    sourceId: string,
    kind: DraftKind,
    infoName: string | undefined,
    scopeRefs: string[] | undefined,
    body: DraftNode[],
  ): DraftDataModule {
    return {
      sourceId,
      kind,
      language: this.language,
      ...(this.issueInfo ? { issueInfo: this.issueInfo } : {}),
      ...(this.issueDate ? { issueDate: this.issueDate } : {}),
      title: { techName: this.manual.title, ...(infoName ? { infoName } : {}) },
      securityClassification: this.options.securityClassification,
      ...(this.options.responsiblePartnerCompany
        ? { responsiblePartnerCompany: this.options.responsiblePartnerCompany }
        : {}),
      ...(this.options.originator ? { originator: this.options.originator } : {}),
      applic: this.applicOf(scopeRefs),
      body,
    };
  }

  private admonitions(list: Admonition[] | undefined): DraftNode[] {
    return (list ?? []).map((a) => ({ kind: 'admonition', level: a.level, text: a.text }));
  }

  /** 素材 1 つを図の節点にする（image は graphic、それ以外は multimedia） */
  private figureOf(assetId: string, where: string, title?: string): DraftNode | undefined {
    const a = this.assets.get(assetId);
    if (!a) {
      this.lose('reference to an asset that is not in Manual.assets', where);
      return undefined;
    }
    this.usedAssets.add(a.id);
    const ref: DraftRef =
      a.kind === 'image'
        ? { kind: 'graphic', target: a.id }
        : {
            kind: 'multimedia',
            target: a.id,
            multimediaType: a.kind === 'video' ? 'video' : a.kind === 'model3d' ? '3D' : 'other',
          };
    if (a.display)
      this.lose('Asset.display (a display copy is for viewers, not for S1000D)', where);
    return { kind: 'figure', title: title ?? a.alt ?? a.id, refs: [ref] };
  }

  private scopeLoss(refs: string[] | undefined, where: string): void {
    if (refs && refs.length > 0)
      this.lose(
        'scopeRefs on a block, step or screen below the topic (applic is per data module)',
        where,
      );
  }

  // ---- description ----

  private block(b: Block, where: string): DraftNode | undefined {
    this.scopeLoss(b.scopeRefs, where);
    const id = b.id ? xmlId(b.id) : undefined;
    switch (b.kind) {
      case 'section': {
        const children: DraftNode[] = [];
        if (b.text) children.push({ kind: 'para', text: b.text });
        (b.children ?? []).forEach((c, i) => {
          const n = this.block(c, `${where}/children/${i}`);
          if (n) children.push(n);
        });
        return {
          kind: 'section',
          ...(id ? { id } : {}),
          ...(b.title ? { title: b.title } : {}),
          children,
        };
      }
      case 'para':
        return { kind: 'para', ...(id ? { id } : {}), text: b.text ?? '' };
      case 'list':
        return {
          kind: 'list',
          ...(id ? { id } : {}),
          ...(b.title ? { title: b.title } : {}),
          ordered: b.ordered === true,
          children: (b.items ?? []).map((t) => ({ kind: 'listItem' as const, text: t })),
        };
      case 'table':
        return {
          kind: 'table',
          ...(id ? { id } : {}),
          ...(b.title ? { title: b.title } : {}),
          rows: b.rows ?? [],
        };
      case 'figure': {
        if (!b.assetRef) {
          throw new DraftInputError(where, 'a figure block needs assetRef');
        }
        const f = this.figureOf(b.assetRef, where, b.title);
        if (f && id) f.id = id;
        return f;
      }
      case 'admonition':
        return {
          kind: 'admonition',
          ...(id ? { id } : {}),
          level: b.level ?? 'note',
          text: b.text ?? '',
        };
    }
  }

  private description(t: Topic): DraftNode[] {
    const body: DraftNode[] = [];
    if (t.summary) body.push({ kind: 'para', text: t.summary });
    (t.blocks ?? []).forEach((b, i) => {
      const n = this.block(b, `/topics/${t.id}/blocks/${i}`);
      if (n) body.push(n);
    });
    return body;
  }

  // ---- procedure ----

  private step(s: Step, where: string): DraftNode {
    this.scopeLoss(s.scopeRefs, where);
    if (s.next && s.next.length > 0)
      this.lose('Step.next (the order of steps is the order in the data module)', where);
    if (s.targetRef) this.lose('Step.targetRef', where);
    if (s.question || s.answers)
      this.lose('question / answers on a step of a procedure (use troubleshooting)', where);
    const text = s.expected ? this.phrases.join(s.text, s.expected) : s.text;
    const children: DraftNode[] = [...this.admonitions(s.admonitions)];
    for (const ref of s.assetRefs ?? []) {
      const f = this.figureOf(ref, where);
      if (f) children.push(f);
    }
    (s.children ?? []).forEach((c, i) => children.push(this.step(c, `${where}/children/${i}`)));
    return { kind: 'step', id: xmlId(s.id), text, ...(children.length ? { children } : {}) };
  }

  private procedure(t: Topic): DraftNode[] {
    return (t.steps ?? []).map((s, i) => this.step(s, `/topics/${t.id}/steps/${i}`));
  }

  // ---- troubleshooting ----

  private faultSteps(t: Topic): DraftNode[] {
    const flat: Array<{ step: Step; where: string }> = [];
    let flattened = false;
    const walk = (steps: Step[], where: string) =>
      steps.forEach((s, i) => {
        flat.push({ step: s, where: `${where}/${i}` });
        if (s.children?.length) {
          flattened = true;
          walk(s.children, `${where}/${i}/children`);
        }
      });
    walk(t.steps ?? [], `/topics/${t.id}/steps`);
    if (flattened)
      this.notes.push(
        `${t.id}: nested steps of a troubleshooting topic were flattened (a fault data module has no nested steps).`,
      );
    return flat.map(({ step: s, where }) => {
      this.scopeLoss(s.scopeRefs, where);
      if (s.next && s.next.length > 0)
        this.lose('Step.next on a troubleshooting step (use answers)', where);
      if (s.targetRef) this.lose('Step.targetRef', where);
      const text = s.expected ? this.phrases.join(s.text, s.expected) : s.text;
      const children: DraftNode[] = [...this.admonitions(s.admonitions)];
      for (const ref of s.assetRefs ?? []) {
        const f = this.figureOf(ref, where);
        if (f) children.push(f);
      }
      const node: DraftNode = { kind: 'step', id: xmlId(s.id), text };
      if (s.question) node.question = s.question;
      if (s.answers && s.answers.length > 0) {
        node.choices = s.answers.map((a) => ({ text: a.text, next: xmlId(a.next.to) }));
        if (s.answers.some((a) => a.next.condition))
          this.lose('Transition.condition on an answer (the answer text is the condition)', where);
      }
      if (children.length) node.children = children;
      return node;
    });
  }

  // ---- screenFlow ----

  private screenLabel(s: Screen): string {
    return s.caption ?? s.description ?? s.id;
  }

  private screenProced(t: Topic, s: Screen, byId: Map<string, Screen>): DraftNode[] {
    const where = `/topics/${t.id}/screens/${s.id}`;
    this.scopeLoss(s.scopeRefs, where);
    const children: DraftNode[] = [...this.admonitions(s.admonitions)];
    const fig = this.figureOf(s.assetRef, where);
    if (fig) children.push(fig);
    for (const h of s.hotspots) {
      const hw = `${where}/hotspots/${h.id}`;
      this.lose('Hotspot shape and coords (no hotspot element in the draft)', hw);
      const target = h.transition ? byId.get(h.transition.to) : undefined;
      if (h.transition && !target)
        this.lose('transition to something that is not a screen of this topic', hw);
      children.push({
        kind: 'step',
        id: xmlId(h.id),
        text: this.phrases.hotspot(
          h.label ?? h.id,
          h.action,
          target ? this.screenLabel(target) : undefined,
          h.transition?.condition,
        ),
      });
    }
    return [
      {
        kind: 'step',
        id: xmlId(s.id),
        ...(s.caption ? { title: s.caption } : {}),
        text: s.description ?? s.caption ?? s.id,
        children,
      },
    ];
  }

  /** 画面の遷移を dmSeq / dmIf の木にする。最初に着いた順に画面を並べ、条件付きの遷移は dmIf、戻る遷移は文に任せる */
  private flow(t: Topic, byId: Map<string, Screen>, dmOf: Map<string, DmCode>): DraftNode[] {
    const screens = t.screens ?? [];
    const visited = new Set<string>();
    let variable = 0;
    const node = (s: Screen): DraftNode => ({
      kind: 'section',
      title: this.screenLabel(s),
      refs: [{ kind: 'dmRef', target: formatDmc(dmOf.get(s.id)!), title: this.manual.title }],
    });
    const visit = (s: Screen): DraftNode[] => {
      visited.add(s.id);
      const items: DraftNode[] = [node(s)];
      for (const h of s.hotspots) {
        const tr = h.transition;
        const target = tr ? byId.get(tr.to) : undefined;
        if (!tr || !target) continue;
        if (tr.condition) {
          const then = visited.has(target.id) ? [node(target)] : visit(target);
          items.push({
            kind: 'if',
            id: `cond${++variable}`,
            question: tr.condition,
            children: [{ kind: 'sequence', children: then }],
          });
        } else if (!visited.has(target.id)) {
          items.push(...visit(target));
        } else {
          this.lose(
            "a transition back to a screen already in the flow (written in the screen's procedure only)",
            `/topics/${t.id}/screens/${s.id}/hotspots/${h.id}`,
          );
        }
      }
      return items;
    };
    const start = (t.startScreenRef ? byId.get(t.startScreenRef) : undefined) ?? screens[0];
    const items: DraftNode[] = start ? visit(start) : [];
    for (const s of screens) if (!visited.has(s.id)) items.push(...visit(s));
    return [{ kind: 'sequence', children: items }];
  }

  // ---- 入口 ----

  run(): ConvertResult {
    const { manual, options } = this;
    const lang = parseLanguage(options.language ?? manual.language);
    this.language = lang.language;
    if (lang.note) this.notes.push(lang.note);
    this.lang = lang.language.languageIsoCode === 'ja' ? 'ja' : 'en';
    this.phrases = PHRASES[this.lang];
    this.issueInfo = issueInfoOfVersion(manual.version.number);
    if (!this.issueInfo)
      this.notes.push(
        `Manual.version.number "${manual.version.number}" is not NNN or NNN.NN; issueInfo was left to the issue policy (001-00 for a new data module).`,
      );
    if (manual.version.date && /^\d{4}-\d{2}-\d{2}$/.test(manual.version.date))
      this.issueDate = manual.version.date;
    else if (manual.version.date)
      this.notes.push(
        `Manual.version.date "${manual.version.date}" is not YYYY-MM-DD; issueDate was left to the builder (today).`,
      );
    if (options.defaultApplic) this.defaultApplic = options.defaultApplic;
    else {
      this.defaultApplic = { displayText: this.phrases.all };
      this.notes.push(
        `applic: data modules without scopeRefs get the display text "${this.phrases.all}" (no assert). Pass defaultApplic to change it.`,
      );
    }

    const wanted = options.topics ? new Set(options.topics) : undefined;
    if (wanted) {
      const known = new Set(manual.topics.map((t) => t.id));
      const unknown = [...wanted].filter((id) => !known.has(id));
      if (unknown.length > 0)
        throw new DraftInputError('/topics', `unknown topic id(s): ${unknown.join(', ')}`);
    }
    const topics = manual.topics.filter((t) => !wanted || wanted.has(t.id));
    if (topics.length === 0) throw new DraftInputError('/topics', 'there is no topic to convert');

    // 1. 採番（相互の参照のため、先にすべての DMC を決める）
    const plan: Array<{
      topic: Topic;
      sourceId: string;
      kind: DraftKind;
      role: DraftRole;
      screen?: Screen;
    }> = [];
    for (const t of topics) {
      if (t.kind === 'screenFlow') {
        if (!t.screens || t.screens.length === 0)
          throw new DraftInputError(
            `/topics/${t.id}`,
            'a screenFlow topic needs at least one screen',
          );
        plan.push({ topic: t, sourceId: t.id, kind: 'process', role: 'topic' });
        for (const s of t.screens)
          plan.push({
            topic: t,
            sourceId: `${t.id}/${s.id}`,
            kind: 'proced',
            role: 'screen',
            screen: s,
          });
      } else {
        const kind: DraftKind =
          t.kind === 'description' ? 'descript' : t.kind === 'procedure' ? 'proced' : 'fault';
        plan.push({ topic: t, sourceId: t.id, kind, role: 'topic' });
      }
    }
    const glossary = !wanted && (manual.glossary?.length ?? 0) > 0;
    const glossaryId = `${manual.id}#glossary`;
    const dmOf = new Map<string, DmCode>();
    for (const p of plan) dmOf.set(p.sourceId, this.allocate(p.sourceId, p.kind));
    if (glossary) dmOf.set(glossaryId, this.allocate(glossaryId, 'descript'));

    // 2. 内容部
    for (const p of plan) {
      const t = p.topic;
      let draft: DraftDataModule;
      if (p.role === 'screen') {
        const byId = new Map((t.screens ?? []).map((s) => [s.id, s] as const));
        const s = p.screen!;
        draft = this.base(
          p.sourceId,
          'proced',
          `${t.title} - ${this.screenLabel(s)}`,
          s.scopeRefs ?? t.scopeRefs,
          this.screenProced(t, s, byId),
        );
        this.drafts.push({
          draft,
          role: 'screen',
          sourceId: p.sourceId,
          topicId: t.id,
          screenId: s.id,
          dmCode: dmOf.get(p.sourceId),
        });
        continue;
      }
      if (t.kind === 'screenFlow') {
        const byId = new Map((t.screens ?? []).map((s) => [s.id, s] as const));
        const screenDm = new Map(
          (t.screens ?? []).map((s) => [s.id, dmOf.get(`${t.id}/${s.id}`)!] as const),
        );
        draft = this.base(
          p.sourceId,
          'process',
          t.title,
          t.scopeRefs,
          this.flow(t, byId, screenDm),
        );
      } else if (t.kind === 'description') {
        draft = this.base(p.sourceId, 'descript', t.title, t.scopeRefs, this.description(t));
      } else if (t.kind === 'procedure') {
        draft = this.base(p.sourceId, 'proced', t.title, t.scopeRefs, this.procedure(t));
        if (t.summary) this.lose('Topic.summary of a non-description topic', `/topics/${t.id}`);
      } else {
        draft = this.base(p.sourceId, 'fault', t.title, t.scopeRefs, this.faultSteps(t));
        if (t.summary) this.lose('Topic.summary of a non-description topic', `/topics/${t.id}`);
      }
      if (t.kind === 'screenFlow' && t.summary)
        this.lose('Topic.summary of a non-description topic', `/topics/${t.id}`);
      this.drafts.push({
        draft,
        role: 'topic',
        sourceId: p.sourceId,
        topicId: t.id,
        dmCode: dmOf.get(p.sourceId),
      });
    }
    if (glossary) {
      const draft = this.base(glossaryId, 'descript', this.phrases.glossary, undefined, [
        {
          kind: 'list',
          title: this.phrases.glossary,
          children: (manual.glossary ?? []).map((term) => ({
            kind: 'definition' as const,
            title: term.term,
            text: term.definition,
          })),
        },
      ]);
      this.drafts.push({
        draft,
        role: 'glossary',
        sourceId: glossaryId,
        dmCode: dmOf.get(glossaryId),
      });
    }
    if (manual.description)
      this.lose('Manual.description (a publication module has no description)', '/description');

    // 3. 公開物（PM）
    if (options.publicationModule !== false) {
      const entry = (dm: DmCode): DraftNode => ({
        kind: 'entry',
        refs: [{ kind: 'dmRef', target: formatDmc(dm), title: manual.title }],
      });
      const sections: DraftNode[] = topics.map((t) => ({
        kind: 'section',
        title: t.title,
        children: [
          entry(dmOf.get(t.id)!),
          ...(t.kind === 'screenFlow'
            ? (t.screens ?? []).map((s) => entry(dmOf.get(`${t.id}/${s.id}`)!))
            : []),
        ],
      }));
      if (glossary)
        sections.push({
          kind: 'section',
          title: this.phrases.glossary,
          children: [entry(dmOf.get(glossaryId)!)],
        });
      const draft = this.base(manual.id, 'pm', undefined, undefined, sections);
      const pmc = allocatePmc(manual.id, {}, this.allocation, options.index);
      this.allocation = { ...this.allocation, ledger: pmc.ledger };
      this.drafts.push({
        draft,
        role: 'publication-module',
        sourceId: manual.id,
        pmCode: formatPmc(pmc.pmCode),
      });
    }

    // 4. 素材の形式
    const assets: ConvertedAsset[] = [];
    const formats: Record<string, GraphicFormat> = {};
    for (const a of manual.assets ?? []) {
      if (!this.usedAssets.has(a.id)) continue;
      const given = options.assetFormats?.[a.id];
      let format: GraphicFormat;
      if (given) format = given;
      else {
        const r = formatOfAsset(a);
        format = r.format;
        if (r.placeholder)
          this.notes.push(
            `asset ${a.id}: no known public identifier for ".${r.format.notation}"; a placeholder was used for the NOTATION declaration. Give assetFormats["${a.id}"] with the project's identifier.`,
          );
      }
      formats[a.id] = format;
      assets.push({ assetId: a.id, kind: a.kind, sourcePath: a.source.path, format });
    }

    return {
      drafts: this.drafts,
      allocation: this.allocation,
      assets,
      assetFormats: formats,
      notRepresented: this.notRepresented(),
      notes: this.notes,
    };
  }
}

/**
 * マニュアルを `DraftDataModule` の並びに変換する（採番も済ませる）。
 *
 * @throws DraftInputError 言語が決まらない、変換対象の Topic が無い、素材の形式が決まらない など
 */
export function manualToDrafts(manual: Manual, options: ConvertOptions): ConvertResult {
  return new Converter(manual, options).run();
}
