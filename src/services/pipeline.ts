/**
 * 「検証 → 修正提案 → exact の候補だけを自動で適用 → 再検証」の流れ（design/writer-mcp.md「全体の流れ」）。
 * 検証・候補の決定・適用はすべて s1000d-core（verifyDataModule / suggestFixes / applyFixes）。ここは呼ぶ順番と応答の形だけ。
 *
 * 守ること:
 * - 自動で適用するのは `confidence: 'exact'`（候補が 1 つで値が決まっている）だけ。several / none は残して返す
 * - 適用するときは必ず `offered`（suggestFixes の結果）を渡す。渡さないと候補の照合が緩む
 * - 準拠の判定・重大度の解釈はしない（verification をそのまま返す）
 */
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  CsdbIndex,
  CsdbWriteConflictError,
  MemoryCsdbSource,
  applyFixes,
  defaultXmlEngine,
  findApplicTables,
  findUndeterminedApplicability,
  loadXsdIndex,
  readBrexDmRefOf,
  resolveBrexChain,
  suggestFixes,
  verifyDataModule,
  formatDmc,
  type BrexDocument,
  type BrexResolver,
  type CsdbObject,
  type CsdbSource,
  type DirectoryCsdbSource,
  type Fix,
  type FixCandidate,
  type NodeLocation,
  type Product,
  type SuggestFixesOptions,
  type VerificationStatus,
  type VerifyResult,
  type XsdIndex,
} from '@shuji-bonji/s1000d-core';
import { LIMITS } from '../config.js';
import {
  brexResolver,
  csdbIndex,
  schemaDirs,
  schemaValidator,
  type ContextOptions,
} from './context.js';

/** 1 回の呼び出しの中で同じ BREX を 2 度読まないための解決器（検証と修正提案の両方で連鎖をたどるため） */
function memoResolver(inner: BrexResolver): BrexResolver {
  const cache = new Map<string, Promise<BrexDocument | undefined>>();
  return (ref) => {
    const key = formatDmc(ref.dmCode);
    let hit = cache.get(key);
    if (!hit) {
      hit = Promise.resolve(inner(ref));
      cache.set(key, hit);
    }
    return hit;
  };
}

export interface PipelineContext {
  /** BREX・CSDB を探すフォルダー（ツール引数） */
  ctx: ContextOptions;
  /** 参照の解決と修正候補に使う CSDB の索引 */
  csdb: CsdbIndex | undefined;
  /** 適用性の判定に使う製品（省略可） */
  product?: Product;
  resolver: BrexResolver;
}

/** 検証に使うものを作る。`csdb` を渡すと（作っている最中の CSDB など）フォルダーの代わりにそれを使う */
export function makePipelineContext(
  ctx: ContextOptions,
  options: { csdb?: CsdbIndex; product?: Product } = {},
): PipelineContext {
  return {
    ctx,
    csdb: options.csdb ?? csdbIndex(ctx),
    product: options.product,
    resolver: memoResolver(brexResolver(ctx)),
  };
}

/** 仕様書（モデル識別コード S1000D）への dmRef は誤りではなく、CSDB にも無い（verify-mcp と同じ扱い） */
export function isSpecificationFix(f: Fix): boolean {
  return f.kind === 'reference' && f.source === 'modelIdentCode S1000D';
}

export interface Verified {
  result: VerifyResult;
  /** 候補（仕様書への参照を除く） */
  fixes: Fix[];
  /** 仕様書への dmRef の件数（応答には載せない） */
  specificationReferences: number;
  applicability: { checked: boolean; undetermined?: number; missingTables?: string[] };
}

/** 検証して、違反があれば候補を付ける */
export async function verifyWithFixes(
  xml: string,
  pc: PipelineContext,
  path?: string,
): Promise<Verified> {
  const result = await verifyDataModule(xml, {
    path,
    schema: { validator: schemaValidator(), schemaDirs: schemaDirs() },
    brex: { resolver: pc.resolver },
    references: { csdb: pc.csdb },
  });
  const applicability: Verified['applicability'] = { checked: false };
  if (!result.status.wellFormed) {
    return { result, fixes: [], specificationReferences: 0, applicability };
  }

  let brexLayers: BrexDocument[] | undefined;
  if (result.brex) {
    const ref =
      result.info?.identAndStatus?.brexDmRef ??
      readBrexDmRefOf(defaultXmlEngine.parse(xml).document);
    brexLayers = (await resolveBrexChain(ref, pc.resolver)).layers;
  }

  let applic: SuggestFixesOptions['applicability'];
  if (pc.product) {
    const tables = findApplicTables(xml, pc.csdb);
    const findings = findUndeterminedApplicability(xml, pc.product);
    applic = { findings, act: tables.act?.act, cct: tables.cct?.cct, pct: tables.pct?.pct };
    applicability.checked = true;
    applicability.undetermined = findings.length;
    applicability.missingTables = tables.missing;
  }

  const s = result.status;
  const clean =
    s.schema.state !== 'invalid' &&
    s.brex.state !== 'violations' &&
    s.references.state !== 'unresolved' &&
    !(applic && applic.findings.length > 0);
  if (clean) return { result, fixes: [], specificationReferences: 0, applicability };

  const all = suggestFixes(result, { xml, csdb: pc.csdb, brexLayers, applicability: applic });
  return {
    result,
    fixes: all.filter((f) => !isSpecificationFix(f)),
    specificationReferences: all.filter(isSpecificationFix).length,
    applicability,
  };
}

const xsdCache = new Map<string, XsdIndex | false>();
/** 要素を足す位置を決める XSD の定義（同じ XSD は読み直さない）。読めなければ false（末尾に足す） */
export function xsdFor(result: VerifyResult): XsdIndex | false {
  const p = result.schema.xsdPath;
  if (!p) return false;
  const cached = xsdCache.get(p);
  if (cached !== undefined) return cached;
  let loaded: XsdIndex | false;
  try {
    loaded = loadXsdIndex(p, defaultXmlEngine) ?? false;
  } catch {
    loaded = false;
  }
  xsdCache.set(p, loaded);
  return loaded;
}

export interface AppliedFix {
  /** 何回目の修正の繰り返しか（自動適用のみ。apply_fixes では 1） */
  round: number;
  kind: Fix['kind'];
  location?: NodeLocation;
  problem: string;
  source: string;
  action: FixCandidate['action'];
  target?: string;
  value?: string;
  description: string;
  changed?: { xpath: string; before?: string; after?: string };
  notes: string[];
}

/** exact の候補だけを選ぶ（候補が 1 つで、文書を変える種類のもの） */
export function exactSelections(fixes: Fix[]): Array<{ fix: Fix; candidate: FixCandidate }> {
  return fixes
    .filter((f) => f.confidence === 'exact' && f.candidates.length === 1 && !isSpecificationFix(f))
    .filter((f) => f.candidates[0]!.action !== 'provide')
    .map((fix) => ({ fix, candidate: fix.candidates[0]! }));
}

export interface FixSummary {
  fixCount: number;
  byConfidence: { exact: number; several: number; none: number };
  fixes: Array<Fix & { candidateCount?: number }>;
  omitted: { fixes: number; specificationReferences: number };
}

/** 残った候補を応答の形にする（件数と候補の数を絞る） */
export function summarizeFixes(
  v: Verified,
  maxFixes: number = LIMITS.defaultMaxFixes,
  maxCandidates: number = LIMITS.maxCandidates,
): FixSummary {
  const byConfidence = { exact: 0, several: 0, none: 0 };
  for (const f of v.fixes) byConfidence[f.confidence]++;
  const listed = v.fixes.slice(0, maxFixes).map((f) =>
    f.candidates.length > maxCandidates
      ? {
          ...f,
          candidates: f.candidates.slice(0, maxCandidates),
          candidateCount: f.candidates.length,
        }
      : f,
  );
  return {
    fixCount: v.fixes.length,
    byConfidence,
    fixes: listed,
    omitted: {
      fixes: v.fixes.length - listed.length,
      specificationReferences: v.specificationReferences,
    },
  };
}

export interface FixLoopResult {
  xml: string;
  verified: Verified;
  verification: VerificationStatus;
  appliedFixes: AppliedFix[];
  rounds: number;
}

/**
 * 検証し、exact の候補を適用して再検証する。最大 `maxRounds` 回。
 * 適用できる exact が無くなる、または何も適用できなくなったら止める。
 */
export async function verifyAndAutoFix(
  xml: string,
  pc: PipelineContext,
  options: { path?: string; maxRounds: number },
): Promise<FixLoopResult> {
  let current = xml;
  let verified = await verifyWithFixes(current, pc, options.path);
  const appliedFixes: AppliedFix[] = [];
  let rounds = 0;
  for (let round = 1; round <= options.maxRounds; round++) {
    const selections = exactSelections(verified.fixes);
    if (selections.length === 0) break;
    const out = applyFixes(current, selections, {
      offered: verified.fixes,
      xsd: xsdFor(verified.result),
    });
    if (out.appliedCount === 0) break;
    rounds = round;
    out.results.forEach((r, i) => {
      if (!r.applied) return;
      const { fix, candidate } = selections[i]!;
      appliedFixes.push({
        round,
        kind: fix.kind,
        location: fix.location,
        problem: fix.problem,
        source: fix.source,
        action: candidate.action,
        target: candidate.target,
        value: candidate.value,
        description: candidate.description,
        changed: r.changed,
        notes: r.notes,
      });
    });
    current = out.xml;
    verified = await verifyWithFixes(current, pc, options.path);
  }
  return { xml: current, verified, verification: verified.result.status, appliedFixes, rounds };
}

// ---------------------------------------------------------------------------
// 作っている最中の CSDB（まだ書いていない DM を参照の解決に見せる）

/** フォルダーの CSDB に、メモリー上の DM・ICN を重ねた読み取り専用の置き場所 */
export class OverlayCsdbSource implements CsdbSource {
  readonly description: string;
  private readonly memory: MemoryCsdbSource;
  private readonly memoryObjects = new Set<CsdbObject>();

  constructor(
    private readonly base: CsdbSource | undefined,
    entries: Array<{ fileName: string; xml?: string }>,
  ) {
    this.memory = new MemoryCsdbSource(entries, 'data modules built in this call');
    for (const o of this.memory.list()) this.memoryObjects.add(o);
    this.description = `${base ? `${base.description} + ` : ''}data modules built in this call`;
  }
  list(): CsdbObject[] {
    return [...(this.base?.list() ?? []), ...this.memory.list()];
  }
  readText(object: CsdbObject): string {
    return this.memoryObjects.has(object)
      ? this.memory.readText(object)
      : this.base!.readText(object);
  }
}

// ---------------------------------------------------------------------------
// 書き込み

export type WriteSkipReason = 'no-csdb-dir' | 'schema-invalid' | 'write-conflict';

export interface WriteOutcome {
  written?: string;
  skipped?: { reason: WriteSkipReason; detail: string };
}

/**
 * 1 つのファイルを書く。書かない理由（置き場所が無い、XSD に適合しない、同じ名前がある）は例外にせず返す。
 * `schema-not-found` と `not-run` は書く（XSD が無い環境を止めない。設計書「WritableCsdbSource」）
 */
export function tryWriteText(
  source: DirectoryCsdbSource | undefined,
  name: string,
  text: string,
  options: { overwrite?: boolean; allowInvalid?: boolean; verification?: VerificationStatus },
): WriteOutcome {
  if (!source) {
    return {
      skipped: {
        reason: 'no-csdb-dir',
        detail:
          'No folder to write to: pass "csdbDirs" or set S1000D_CSDB_DIR (the first folder is the target).',
      },
    };
  }
  if (options.verification?.schema.state === 'invalid' && !options.allowInvalid) {
    return {
      skipped: {
        reason: 'schema-invalid',
        detail: `The XML is not valid against the XSD (${options.verification.schema.errorCount ?? '?'} error(s)); nothing was written. Pass allowInvalid: true to write it anyway.`,
      },
    };
  }
  try {
    return { written: source.writeText(name, text, { overwrite: options.overwrite }) };
  } catch (e) {
    if (e instanceof CsdbWriteConflictError) {
      return {
        skipped: {
          reason: 'write-conflict',
          detail: `${e.path} already exists; pass overwrite: true to replace it.`,
        },
      };
    }
    throw e;
  }
}

/** 書き込み先のフォルダーに同じ名前があるか（複数ファイルを書く前の確認） */
export function existsInDir(source: DirectoryCsdbSource | undefined, name: string): boolean {
  const root = source?.dirs[0];
  return root !== undefined && existsSync(join(root, name));
}
