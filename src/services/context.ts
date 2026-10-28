/**
 * 検証と書き込みに使うもの（CSDB の索引、XSD の検証器、BREX の解決器、書き込み先）をまとめて作る。
 * 探索・検証・組み立ての処理はすべて s1000d-core。ここは環境変数とツール引数の解釈だけ。
 * writer は自分が書いたファイルを次の呼び出しで読むので、CSDB の索引は呼び出しごとに作り直す（キャッシュしない）。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import {
  CsdbIndex,
  DirectoryCsdbSource,
  createDirectoryBrexResolver,
  findSchemaDirs,
  type BrexResolver,
  type SchemaDir,
} from '@shuji-bonji/s1000d-core';
import { Libxml2SchemaValidator } from '@shuji-bonji/s1000d-core/xsd-libxml2';
import {
  ENV,
  csdbDirs,
  specDir,
  specDirHint,
  stackConfig,
  stackConfigWarnings,
} from '../config.js';

export interface ContextOptions {
  /** ツール引数で追加されたフォルダー */
  extraDirs?: string[];
}

function existingDirs(dirs: string[]): string[] {
  return [...new Set(dirs.filter((d) => existsSync(d) && statSync(d).isDirectory()))];
}

/** CSDB として探すフォルダー（優先順: ツール引数 → S1000D_CSDB_DIR）。存在するものだけ */
export function csdbSearchDirs(options: ContextOptions = {}): string[] {
  return existingDirs([...(options.extraDirs ?? []), ...csdbDirs()]);
}

/** 書き込み先のフォルダー（`csdbDirs` の最初のフォルダー。無ければ S1000D_CSDB_DIR の最初）。まだ存在しなくてもよい */
export function writeDir(options: ContextOptions = {}): string | undefined {
  return [...(options.extraDirs ?? []), ...csdbDirs()][0];
}

/** 書き込み先 */
export function writableSource(options: ContextOptions = {}): DirectoryCsdbSource | undefined {
  const dir = writeDir(options);
  return dir ? new DirectoryCsdbSource([dir]) : undefined;
}

/** BREX を探すフォルダー（CSDB ＋ 配布物） */
export function brexSearchDirs(options: ContextOptions = {}): string[] {
  const spec = specDir();
  return existingDirs([...csdbSearchDirs(options), ...(spec ? [spec] : [])]);
}

let validator: Libxml2SchemaValidator | undefined;
export function schemaValidator(): Libxml2SchemaValidator {
  validator ??= new Libxml2SchemaValidator();
  return validator;
}
export function disposeValidator(): void {
  validator?.dispose();
  validator = undefined;
}

const schemaDirCache = new Map<string, SchemaDir[]>();
/** `S1000D_SPEC_DIR` の下の xml_schema_flat/（データ辞書の写しは除く）。未設定なら空 */
export function schemaDirs(): SchemaDir[] {
  const spec = specDir();
  if (!spec || !existsSync(spec)) return [];
  let dirs = schemaDirCache.get(spec);
  if (!dirs) {
    dirs = findSchemaDirs([spec]).filter(
      (d) => !/(^|[\\/])data_dictionary[^\\/]*[\\/]/i.test(d.dir),
    );
    schemaDirCache.set(spec, dirs);
  }
  return dirs;
}

/** CSDB の索引（呼び出しごとに作る）。フォルダーが無ければ undefined */
export function csdbIndex(options: ContextOptions = {}): CsdbIndex | undefined {
  const dirs = csdbSearchDirs(options);
  return dirs.length === 0 ? undefined : CsdbIndex.fromDirs(dirs);
}

export function clearCaches(): void {
  schemaDirCache.clear();
}

export function brexResolver(options: ContextOptions = {}): BrexResolver {
  return createDirectoryBrexResolver(brexSearchDirs(options));
}

/** 既定 BREX を探すフォルダー（組み立てのとき brexDmRef が決まらなければ使う） */
export function specDirs(): string[] {
  const spec = specDir();
  return spec && existsSync(spec) ? [spec] : [];
}

export function configNotes(options: ContextOptions = {}): string[] {
  const notes: string[] = [...stackConfigWarnings()];
  if (!specDir()) {
    notes.push(
      `${ENV.specDir} is not set: verification.schema is reported as schema-not-found and the default BREX cannot be located. ${specDirHint()}`,
    );
  } else if (schemaDirs().length === 0) {
    notes.push(
      `No xml_schema_flat/ folder (containing brex.xsd) was found under ${ENV.specDir}=${specDir()}.`,
    );
  }
  if (csdbSearchDirs(options).length === 0) {
    notes.push(
      `No CSDB folders: set ${ENV.csdbDirs}, add "csdbDirs" to ${stackConfig().configPath}, or pass "csdbDirs". References cannot be resolved, BREX in the CSDB cannot be found, and nothing can be written.`,
    );
  }
  return notes;
}

export function loadXml(input: { path?: string; xml?: string }, maxBytes: number): string {
  if (input.xml !== undefined && input.xml.trim() !== '') {
    if (Buffer.byteLength(input.xml, 'utf8') > maxBytes)
      throw new Error(`Inline XML exceeds ${maxBytes} bytes`);
    return input.xml;
  }
  if (input.path !== undefined && input.path.trim() !== '') {
    if (!existsSync(input.path)) throw new Error(`File not found: ${input.path}`);
    return readFileSync(input.path, 'utf8');
  }
  throw new Error('Either "path" or "xml" is required');
}
