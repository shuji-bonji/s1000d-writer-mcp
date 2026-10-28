/**
 * ツールの実装。definitions.ts の name と 1 対 1 で対応する。
 * 組み立て・検証・修正・文の出し入れの中身はすべて s1000d-core。ここは引数の解釈と応答の形だけ。
 * 変換関数（manual-model → draft）だけは writer-mcp に置く（src/convert/）。
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import {
  CsdbIndex,
  DirectoryCsdbSource,
  applyFixes,
  applySegments,
  buildComment,
  buildDataModule,
  extractSegments,
  formatCommentCode,
  formatDmc,
  formatDmcFileName,
  formatPmc,
  readDataModuleInfo,
  type Allocation,
  type BuildOptions,
  type BuildResult,
  type CommentInput,
  type DraftDataModule,
  type Fix,
  type FixCandidate,
  type GraphicFormat,
  type IssuePolicy,
  type Language,
  type NodeLocation,
  type Product,
  type SegmentCategory,
  type VerificationStatus,
} from '@shuji-bonji/s1000d-core';
import { validateManual, type Manual } from '@shuji-bonji/experiential-manual-model';
import { LIMITS } from '../config.js';
import { manualToDrafts, type ConvertedDraft } from '../convert/index.js';
import {
  configNotes,
  csdbIndex,
  csdbSearchDirs,
  loadXml,
  specDirs,
  writableSource,
  type ContextOptions,
} from '../services/context.js';
import {
  OverlayCsdbSource,
  makePipelineContext,
  summarizeFixes,
  tryWriteText,
  verifyAndAutoFix,
  verifyWithFixes,
  xsdFor,
  type AppliedFix,
  type FixSummary,
  type WriteOutcome,
} from '../services/pipeline.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Args = Record<string, any>;
export type ToolHandler = (args: Args) => Promise<unknown>;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}
function strArray(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
}
function int(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : def;
  return Math.min(max, Math.max(min, n));
}
function productArg(v: unknown): Product | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as { attributes?: Record<string, string>; conditions?: Record<string, string> };
  if (!o.attributes && !o.conditions) return undefined;
  return { attributes: o.attributes ?? {}, conditions: o.conditions ?? {} };
}
function issuePolicyArg(v: unknown): IssuePolicy | undefined {
  return v === 'increment-issue' || v === 'increment-inwork' || v === 'keep' ? v : undefined;
}
function assetFormatsArg(v: unknown): Record<string, GraphicFormat> | undefined {
  return v && typeof v === 'object' ? (v as Record<string, GraphicFormat>) : undefined;
}

const STANDARD_NOTES = [
  'verification tells how far this XML has been checked. schema-not-found and not-run are NOT "valid"; see the reason. S1000D conformance is never decided here.',
  'Severity codes (brslNN) and other enumerations are passed through, not interpreted.',
];

/** 組み立てた XML をそのまま応答に載せ、写しを書くかどうかは write で決める（既定は書かない） */
const NOT_WRITTEN_NOTE = 'Nothing was written (write is false). The XML is only returned.';

function writeNotes(write: boolean, outcome: WriteOutcome | undefined): string[] {
  if (!write) return [NOT_WRITTEN_NOTE];
  if (outcome?.written) return [`Written: ${outcome.written}`];
  return outcome?.skipped
    ? [`Not written (${outcome.skipped.reason}): ${outcome.skipped.detail}`]
    : [];
}

function fixNotes(applied: AppliedFix[], summary: FixSummary): string[] {
  const notes: string[] = [];
  if (applied.length > 0) {
    notes.push(
      `${applied.length} fix(es) with a single certain candidate (confidence "exact") were applied automatically; see appliedFixes and check them.`,
    );
  }
  if (summary.fixCount > 0) {
    notes.push(
      'Choose only among the candidates in fixes[]. When confidence is "none", ask the user. Candidates with valueForm "range" or "pattern" are constraints, not values: ask the user for a value that satisfies them, then call apply_fixes.',
    );
  }
  if (summary.omitted.fixes > 0) {
    notes.push(
      `Only ${summary.fixes.length} of ${summary.fixCount} fixes are listed. Raise maxFixes to see more.`,
    );
  }
  if (summary.omitted.specificationReferences > 0) {
    notes.push(
      `${summary.omitted.specificationReferences} dmRef(s) to the S1000D specification itself are not listed; they are not errors.`,
    );
  }
  return notes;
}

/** DMC / PMC / ファイル名を、最終の XML から読み直す（自動修正で識別が変わりうる） */
function identityOf(
  xml: string,
  built: BuildResult,
): { dmCode?: string; pmCode?: string; fileName: string } {
  if (built.kind === 'pm') {
    return { pmCode: built.pmCode ? formatPmc(built.pmCode) : undefined, fileName: built.fileName };
  }
  try {
    const id = readDataModuleInfo(xml).identAndStatus;
    if (id) {
      return {
        dmCode: formatDmc(id.dmCode),
        fileName: formatDmcFileName({
          dmCode: id.dmCode,
          issueInfo: id.issueInfo,
          language: id.language,
          extension: 'XML',
        }),
      };
    }
  } catch {
    // 読めないときは組み立てたときの値
  }
  return { dmCode: built.dmCode ? formatDmc(built.dmCode) : undefined, fileName: built.fileName };
}

// ---------------------------------------------------------------------------
// build_data_module

async function buildDataModuleTool(args: Args) {
  if (!args.draft || typeof args.draft !== 'object') throw new Error('"draft" is required');
  if (!args.allocation || typeof args.allocation !== 'object')
    throw new Error('"allocation" is required');
  const draft = args.draft as DraftDataModule;
  const allocation = args.allocation as Allocation;
  const ctx: ContextOptions = { extraDirs: strArray(args.csdbDirs) };
  const index = csdbIndex(ctx);

  const options: BuildOptions = {
    index,
    specDirs: specDirs(),
    issuePolicy: issuePolicyArg(args.issuePolicy),
    assetFormats: assetFormatsArg(args.assetFormats),
  };
  const built = buildDataModule(draft, allocation, options);

  const pc = makePipelineContext(ctx, { csdb: index, product: productArg(args.product) });
  const loop = await verifyAndAutoFix(built.xml, pc, {
    path: built.fileName,
    maxRounds: int(args.maxFixRounds, LIMITS.defaultFixRounds, 0, LIMITS.maxFixRounds),
  });
  const id = identityOf(loop.xml, built);
  const ledger = { ...built.ledger };
  const notes = [...built.notes];
  if (
    draft.sourceId &&
    id.dmCode &&
    ledger[draft.sourceId] !== undefined &&
    ledger[draft.sourceId] !== id.dmCode
  ) {
    ledger[draft.sourceId] = id.dmCode;
    notes.push(
      `ledger: an automatic fix changed the DMC; the ledger now holds ${id.dmCode} for "${draft.sourceId}".`,
    );
  }

  const write = args.write === true;
  const outcome = write
    ? tryWriteText(writableSource(ctx), id.fileName, loop.xml, {
        overwrite: args.overwrite === true,
        allowInvalid: args.allowInvalid === true,
        verification: loop.verification,
      })
    : undefined;

  const summary = summarizeFixes(
    loop.verified,
    int(args.maxFixes, LIMITS.defaultMaxFixes, 1, LIMITS.maxMaxFixes),
  );
  return {
    xml: loop.xml,
    fileName: id.fileName,
    kind: built.kind,
    ...(id.dmCode ? { dmCode: id.dmCode } : {}),
    ...(id.pmCode ? { pmCode: id.pmCode } : {}),
    issueInfo: built.issueInfo,
    verification: loop.verification,
    appliedFixes: loop.appliedFixes,
    fixRounds: loop.rounds,
    ...summary,
    ...(loop.verified.applicability.checked ? { applicability: loop.verified.applicability } : {}),
    ledger,
    icnNext: built.icnNext,
    icns: built.icns,
    written: outcome?.written ? [outcome.written] : [],
    ...(outcome?.skipped ? { writeSkipped: outcome.skipped } : {}),
    _notes: [
      ...notes,
      ...fixNotes(loop.appliedFixes, summary),
      ...writeNotes(write, outcome),
      ...STANDARD_NOTES,
      ...configNotes(ctx),
    ],
  };
}

// ---------------------------------------------------------------------------
// convert_manual

interface ConvertedEntry {
  item: ConvertedDraft;
  built?: BuildResult;
  error?: { code: 'input-error'; path: string; detail: string };
}

function loadManual(args: Args): { manual: unknown; baseDir?: string } {
  if (args.manual && typeof args.manual === 'object') return { manual: args.manual };
  const p = str(args.manualPath);
  if (!p) throw new Error('Either "manual" or "manualPath" is required');
  if (!existsSync(p)) throw new Error(`File not found: ${p}`);
  try {
    return { manual: JSON.parse(readFileSync(p, 'utf8')), baseDir: dirname(resolve(p)) };
  } catch (e) {
    throw new Error(`${p} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function convertManualTool(args: Args) {
  const { manual: rawManual, baseDir } = loadManual(args);
  const validation = validateManual(rawManual);
  if (!validation.ok) {
    return {
      error: {
        code: 'input-error',
        path: '/manual',
        detail: `The manual is not valid (${validation.errors.length} error(s)); fix it with the manual's own tooling and try again.`,
        issues: validation.errors.slice(0, 50),
      },
      _notes: ['Nothing was built or written.'],
    };
  }
  const manual = rawManual as Manual;
  const ctx: ContextOptions = { extraDirs: strArray(args.csdbDirs) };
  const index = csdbIndex(ctx);
  const allocation = args.allocation as Allocation;

  const conv = manualToDrafts(manual, {
    allocation,
    securityClassification: String(args.securityClassification),
    language: args.language,
    topics: strArray(args.topics),
    defaultApplic: args.defaultApplic,
    responsiblePartnerCompany: str(args.responsiblePartnerCompany),
    originator: str(args.originator),
    assetFormats: assetFormatsArg(args.assetFormats),
    index,
    publicationModule: args.publicationModule !== false,
  });
  if (conv.drafts.length > LIMITS.maxConvertedModules) {
    return {
      error: {
        code: 'input-error',
        path: '/topics',
        detail: `${conv.drafts.length} data modules would be built; the limit is ${LIMITS.maxConvertedModules} per call. Convert fewer topics (topics).`,
      },
      _notes: ['Nothing was built or written.'],
    };
  }

  // 1. 組み立て（DMC は変換のときに決めてあるので、台帳を引き継ぐだけ。順番に ICN が採番される）
  let alloc: Allocation = conv.allocation;
  const buildOptions: BuildOptions = {
    index,
    specDirs: specDirs(),
    issuePolicy: issuePolicyArg(args.issuePolicy),
    assetFormats: conv.assetFormats,
  };
  const entries: ConvertedEntry[] = [];
  for (const item of conv.drafts) {
    try {
      const built = buildDataModule(item.draft, alloc, buildOptions);
      alloc = { ...alloc, ledger: built.ledger, icn: { ...alloc.icn, next: built.icnNext } };
      entries.push({ item, built });
    } catch (e) {
      if (e instanceof Error && e.name === 'DraftInputError') {
        const err = e as Error & { path: string; detail: string };
        entries.push({
          item,
          error: { code: 'input-error', path: err.path, detail: `${item.sourceId}: ${err.detail}` },
        });
      } else throw e;
    }
  }

  // 2. 素材（原本の場所と ICN）
  const ledger = alloc.ledger ?? {};
  const base = str(args.assetBaseDir) ?? baseDir;
  const assetRows = conv.assets.map((a) => {
    const icn = ledger[a.assetId];
    const p = a.sourcePath;
    const resolved = isAbsolute(p) ? p : base ? resolve(base, p) : undefined;
    const exists = resolved !== undefined && existsSync(resolved) && statSync(resolved).isFile();
    return {
      assetId: a.assetId,
      kind: a.kind,
      icn,
      fileName: icn ? `${icn}.${a.format.extension}` : undefined,
      sourcePath: p,
      resolvedSourcePath: resolved,
      sourceExists: exists,
    };
  });

  // 3. 検証と自動修正。参照は、CSDB に今回作った DM と原本のある ICN を重ねて解決する
  const dirs = csdbSearchDirs(ctx);
  const overlay = new OverlayCsdbSource(
    dirs.length > 0 ? new DirectoryCsdbSource(dirs) : undefined,
    [
      ...entries
        .filter((e) => e.built)
        .map((e) => ({ fileName: e.built!.fileName, xml: e.built!.xml })),
      ...assetRows
        .filter((a) => a.sourceExists && a.fileName)
        .map((a) => ({ fileName: a.fileName! })),
    ],
  );
  const pc = makePipelineContext(ctx, {
    csdb: CsdbIndex.fromSource(overlay),
    product: productArg(args.product),
  });
  const maxRounds = int(args.maxFixRounds, LIMITS.defaultFixRounds, 0, LIMITS.maxFixRounds);
  const maxFixes = int(args.maxFixes, LIMITS.defaultMaxFixes, 1, LIMITS.maxMaxFixes);
  const write = args.write === true;
  const includeXml = typeof args.includeXml === 'boolean' ? args.includeXml : !write;
  const source = write ? writableSource(ctx) : undefined;

  const totals = {
    schema: { valid: 0, invalid: 0, 'schema-not-found': 0, 'not-run': 0 } as Record<string, number>,
    brex: { passed: 0, violations: 0, incomplete: 0, 'not-run': 0 } as Record<string, number>,
    references: { resolved: 0, unresolved: 0, 'not-run': 0 } as Record<string, number>,
    brexViolationCount: 0,
    unresolvedReferenceCount: 0,
    appliedFixes: 0,
    remainingFixes: 0,
    written: 0,
    notWritten: 0,
  };
  const rows = [];
  for (const e of entries) {
    const base = {
      role: e.item.role,
      sourceId: e.item.sourceId,
      ...(e.item.topicId ? { topicId: e.item.topicId } : {}),
      ...(e.item.screenId ? { screenId: e.item.screenId } : {}),
    };
    if (!e.built) {
      rows.push({ ...base, error: e.error });
      continue;
    }
    const loop = await verifyAndAutoFix(e.built.xml, pc, { path: e.built.fileName, maxRounds });
    const id = identityOf(loop.xml, e.built);
    const v: VerificationStatus = loop.verification;
    totals.schema[v.schema.state] = (totals.schema[v.schema.state] ?? 0) + 1;
    totals.brex[v.brex.state] = (totals.brex[v.brex.state] ?? 0) + 1;
    totals.references[v.references.state] = (totals.references[v.references.state] ?? 0) + 1;
    totals.brexViolationCount += v.brex.violationCount;
    totals.unresolvedReferenceCount += v.references.unresolvedCount;
    totals.appliedFixes += loop.appliedFixes.length;
    const summary = summarizeFixes(loop.verified, maxFixes);
    totals.remainingFixes += summary.fixCount;
    const outcome = write
      ? tryWriteText(source, id.fileName, loop.xml, {
          overwrite: args.overwrite === true,
          allowInvalid: args.allowInvalid === true,
          verification: v,
        })
      : undefined;
    if (outcome?.written) totals.written++;
    else if (write) totals.notWritten++;
    rows.push({
      ...base,
      ...(id.dmCode ? { dmCode: id.dmCode } : {}),
      ...(id.pmCode ? { pmCode: id.pmCode } : {}),
      fileName: id.fileName,
      ...(includeXml ? { xml: loop.xml } : {}),
      verification: v,
      appliedFixes: loop.appliedFixes,
      ...summary,
      ...(outcome?.written ? { written: outcome.written } : {}),
      ...(outcome?.skipped ? { writeSkipped: outcome.skipped } : {}),
    });
  }

  // 4. 原本のコピー（write: true のときだけ。ICN のファイル名で）
  const assets = assetRows.map((a) => {
    if (!write || !a.fileName || !a.sourceExists || !source) return a;
    const out = (() => {
      try {
        return {
          copied: source.writeBytes(a.fileName, readFileSync(a.resolvedSourcePath!), {
            overwrite: args.overwrite === true,
          }),
        };
      } catch (e) {
        if (e instanceof Error && e.name === 'CsdbWriteConflictError')
          return {
            copySkipped: {
              reason: 'write-conflict',
              detail: `${a.fileName} already exists; pass overwrite: true to replace it.`,
            },
          };
        throw e;
      }
    })();
    return { ...a, ...out };
  });

  const dm = rows.filter((r) => 'role' in r && r.role !== 'publication-module');
  const pm = rows.find((r) => 'role' in r && r.role === 'publication-module');
  const failed = rows.filter((r) => 'error' in r && r.error).length;
  const notes = [
    ...conv.notes,
    `References are resolved against the CSDB folders plus the ${entries.filter((e) => e.built).length} data module(s) built in this call and the originals that were found on disk${base ? '' : ' (no assetBaseDir / manualPath: relative original paths could not be checked)'}.`,
    ...(assets.filter((a) => !a.sourceExists).length > 0
      ? [
          `${assets.filter((a) => !a.sourceExists).length} original file(s) were not found on disk: their ICN references are reported as unresolved and nothing is copied for them.`,
        ]
      : []),
    ...(write
      ? [
          `Written ${totals.written} file(s)${totals.notWritten ? `; ${totals.notWritten} not written (see writeSkipped)` : ''}.`,
        ]
      : [NOT_WRITTEN_NOTE]),
    ...(totals.appliedFixes > 0
      ? [
          `${totals.appliedFixes} fix(es) with a single certain candidate were applied automatically (appliedFixes of each data module).`,
        ]
      : []),
    ...(conv.notRepresented.length > 0
      ? [
          'notRepresented lists what the draft format cannot express; those parts of the manual are not in the data modules.',
        ]
      : []),
    ...STANDARD_NOTES,
    ...configNotes(ctx),
  ];
  return {
    dataModules: dm,
    ...(pm ? { publicationModule: pm } : {}),
    assets,
    ledger: alloc.ledger,
    icnNext: alloc.icn.next,
    summary: {
      dataModules: dm.length,
      publicationModules: pm ? 1 : 0,
      failedToBuild: failed,
      schema: totals.schema,
      brex: totals.brex,
      brexViolationCount: totals.brexViolationCount,
      references: totals.references,
      unresolvedReferenceCount: totals.unresolvedReferenceCount,
      appliedFixes: totals.appliedFixes,
      remainingFixes: totals.remainingFixes,
      written: totals.written,
    },
    notRepresented: conv.notRepresented,
    _notes: notes,
  };
}

// ---------------------------------------------------------------------------
// apply_fixes

interface Selection {
  location?: NodeLocation;
  action: FixCandidate['action'];
  target?: string;
  value?: string;
}

async function applyFixesTool(args: Args) {
  const path = str(args.path);
  const xml = loadXml({ path, xml: str(args.xml) }, LIMITS.maxInlineXmlBytes);
  const ctx: ContextOptions = { extraDirs: strArray(args.csdbDirs) };
  const pc = makePipelineContext(ctx, { product: productArg(args.product) });
  const selections = (args.selections as Selection[]) ?? [];
  if (selections.length === 0) throw new Error('"selections" must have at least one item');

  const before = await verifyWithFixes(xml, pc, path);
  const asFix = (s: Selection): { fix: Fix; candidate: FixCandidate } => ({
    // 照合は offered（サーバーが計算し直した候補）と行う。ここで作る Fix は場所を渡すための入れ物
    fix: {
      kind: 'schema',
      location: s.location,
      problem: '(selection)',
      candidates: [],
      confidence: 'none',
      source: 'selection',
    },
    candidate: { action: s.action, target: s.target, value: s.value, description: '(selection)' },
  });
  const out = applyFixes(xml, selections.map(asFix), {
    offered: before.fixes,
    xsd: xsdFor(before.result),
  });
  const applied = out.results
    .filter((r) => r.applied)
    .map((r) => ({
      index: r.index,
      selection: selections[r.index],
      changed: r.changed,
      notes: r.notes,
    }));
  const rejected = out.results
    .filter((r) => !r.applied)
    .map((r) => ({
      index: r.index,
      selection: selections[r.index],
      reason: r.reason,
      notes: r.notes,
    }));

  const after = out.appliedCount > 0 ? await verifyWithFixes(out.xml, pc, path) : before;
  const summary = summarizeFixes(
    after,
    int(args.maxFixes, LIMITS.defaultMaxFixes, 1, LIMITS.maxMaxFixes),
  );

  const write = args.write === true;
  let outcome: WriteOutcome | undefined;
  if (write) {
    if (out.appliedCount === 0) {
      outcome = {
        skipped: {
          reason: 'write-conflict',
          detail: 'No selection was applied; nothing to write.',
        },
      };
    } else if (path) {
      if (after.result.status.schema.state === 'invalid' && args.allowInvalid !== true) {
        outcome = {
          skipped: {
            reason: 'schema-invalid',
            detail:
              'The result is not valid against the XSD; the file was not changed. Pass allowInvalid: true to write it anyway.',
          },
        };
      } else {
        writeFileSync(path, out.xml);
        outcome = { written: path };
      }
    } else {
      const info = (() => {
        try {
          return readDataModuleInfo(out.xml).identAndStatus;
        } catch {
          return undefined;
        }
      })();
      const name = info
        ? formatDmcFileName({
            dmCode: info.dmCode,
            issueInfo: info.issueInfo,
            language: info.language,
            extension: 'XML',
          })
        : undefined;
      outcome = name
        ? tryWriteText(writableSource(ctx), name, out.xml, {
            overwrite: args.overwrite === true,
            allowInvalid: args.allowInvalid === true,
            verification: after.result.status,
          })
        : {
            skipped: {
              reason: 'no-csdb-dir',
              detail: 'The file name could not be derived from the XML; pass path instead.',
            },
          };
    }
  }
  const notes = [
    ...(rejected.length > 0
      ? [
          'rejected[] lists selections that were not applied (reason: candidate-not-offered = no suggested fix has this location and candidate; value-not-allowed = the value is outside the range / pattern; provide-is-not-a-document-change = pass it as "product").',
        ]
      : []),
    ...fixNotes([], summary),
    ...writeNotes(write, outcome),
    ...(write && path && outcome?.written ? ['The file at "path" was overwritten in place.'] : []),
    ...STANDARD_NOTES,
    ...configNotes(ctx),
  ];
  return {
    xml: out.xml,
    appliedCount: out.appliedCount,
    applied,
    rejected,
    verification: after.result.status,
    ...summary,
    written: outcome?.written ? [outcome.written] : [],
    ...(outcome?.skipped ? { writeSkipped: outcome.skipped } : {}),
    _notes: notes,
  };
}

// ---------------------------------------------------------------------------
// create_comment

async function createCommentTool(args: Args) {
  const ctx: ContextOptions = { extraDirs: strArray(args.csdbDirs) };
  const index = csdbIndex(ctx);
  const input: CommentInput = {
    refs: args.refs ?? [],
    commentType: args.commentType,
    commentPriorityCode: args.commentPriorityCode,
    title: args.title,
    paragraphs: args.paragraphs,
    originator: args.originator,
    senderIdent: args.senderIdent,
    modelIdentCode: args.modelIdentCode,
    yearOfDataIssue: args.yearOfDataIssue,
    seqNumber: args.seqNumber,
    securityClassification: args.securityClassification,
    responseType: args.responseType,
    issueDate: args.issueDate,
    language: args.language as Language,
    brexDmRef: args.brexDmRef,
    issueType: args.issueType,
    remarks: args.remarks,
  };
  const built = buildComment(input, { index, specDirs: specDirs() });
  const pc = makePipelineContext(ctx, { csdb: index });
  const v = await verifyWithFixes(built.xml, pc, built.fileName);
  const summary = summarizeFixes(
    v,
    int(args.maxFixes, LIMITS.defaultMaxFixes, 1, LIMITS.maxMaxFixes),
  );
  const write = args.write === true;
  const outcome = write
    ? tryWriteText(writableSource(ctx), built.fileName, built.xml, {
        overwrite: args.overwrite === true,
        allowInvalid: args.allowInvalid === true,
        verification: v.result.status,
      })
    : undefined;
  return {
    xml: built.xml,
    fileName: built.fileName,
    commentCode: formatCommentCode(built.commentCode),
    verification: v.result.status,
    ...summary,
    written: outcome?.written ? [outcome.written] : [],
    ...(outcome?.skipped ? { writeSkipped: outcome.skipped } : {}),
    _notes: [
      ...built.notes,
      'commentType, commentPriorityCode, responseType and issueType are written as given; their meaning is decided by the project and its BREX, not here.',
      ...fixNotes([], summary),
      ...writeNotes(write, outcome),
      ...STANDARD_NOTES,
      ...configNotes(ctx),
    ],
  };
}

// ---------------------------------------------------------------------------
// extract_segments / apply_segments

async function extractSegmentsTool(args: Args) {
  const path = str(args.path);
  const xml = loadXml({ path, xml: str(args.xml) }, LIMITS.maxInlineXmlBytes);
  const r = extractSegments(xml, {
    include: strArray(args.include) as SegmentCategory[] | undefined,
    maxSegments: typeof args.maxSegments === 'number' ? args.maxSegments : undefined,
  });
  return {
    dmCode: formatDmc(r.dmCode),
    language: r.language,
    skeletonHash: r.skeletonHash,
    counts: r.counts,
    segments: r.segments.map((s) => ({
      id: s.id,
      xpath: s.xpath,
      element: s.element,
      category: s.category,
      context: s.context,
      text: s.text,
      placeholders: s.placeholders,
    })),
    _notes: [
      ...r.notes,
      'Translate only "text". Keep every {n} placeholder exactly once (they stand for inline elements); write a literal brace as {{ or }}. This server does not translate and does not score translations.',
      'Pass skeletonHash and the translated segments (id, text) to apply_segments.',
    ],
  };
}

async function applySegmentsTool(args: Args) {
  const path = str(args.path);
  const xml = loadXml({ path, xml: str(args.xml) }, LIMITS.maxInlineXmlBytes);
  const ctx: ContextOptions = { extraDirs: strArray(args.csdbDirs) };
  const r = applySegments(xml, args.segments, {
    language: args.language as Language,
    issueInfo: args.issueInfo,
    skeletonHash: String(args.skeletonHash),
  });
  const pc = makePipelineContext(ctx);
  const v = await verifyWithFixes(r.xml, pc, r.fileName);
  const summary = summarizeFixes(
    v,
    int(args.maxFixes, LIMITS.defaultMaxFixes, 1, LIMITS.maxMaxFixes),
  );
  const write = args.write === true;
  const outcome = write
    ? tryWriteText(writableSource(ctx), r.fileName, r.xml, {
        overwrite: args.overwrite === true,
        allowInvalid: args.allowInvalid === true,
        verification: v.result.status,
      })
    : undefined;
  return {
    xml: r.xml,
    fileName: r.fileName,
    applied: r.applied,
    unapplied: r.unapplied,
    verification: v.result.status,
    ...summary,
    written: outcome?.written ? [outcome.written] : [],
    ...(outcome?.skipped ? { writeSkipped: outcome.skipped } : {}),
    _notes: [
      ...r.notes,
      ...(r.unapplied.length > 0
        ? [
            'unapplied[] lists sentences that were not put back (the original sentence stays): unknown-id, duplicate-id, or placeholder-mismatch ({n} missing, repeated or invented).',
          ]
        : []),
      ...fixNotes([], summary),
      ...writeNotes(write, outcome),
      ...STANDARD_NOTES,
      ...configNotes(ctx),
    ],
  };
}

export const toolHandlers: Record<string, ToolHandler> = {
  build_data_module: buildDataModuleTool,
  convert_manual: convertManualTool,
  apply_fixes: applyFixesTool,
  create_comment: createCommentTool,
  extract_segments: extractSegmentsTool,
  apply_segments: applySegmentsTool,
};
