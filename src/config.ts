/**
 * 設定。環境変数（と設定ファイル）とパッケージ情報をここに集める（s1000d-reader-mcp と同じ名前・同じ形）。
 * writer は状態を持たない。採番の規則（allocation）は環境変数や設定ファイルに置かず、呼び出しごとに渡す。
 */
import { createRequire } from 'node:module';
import {
  resolveStackConfig,
  specDirHowTo,
  type ResolvedStackConfig,
} from '@shuji-bonji/s1000d-core';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json') as { name: string; version: string };

export const PACKAGE_INFO = {
  name: packageJson.name,
  version: packageJson.version,
} as const;

/** 環境変数の名前（無ければ設定ファイルの specDir / csdbDirs を読む） */
export const ENV = {
  /** 利用者が入手した S1000D の配布物を展開したフォルダー。XSD（xml_schema_flat/）と既定 BREX をここから探す */
  specDir: 'S1000D_SPEC_DIR',
  /** プロジェクトの CSDB（データモジュールが置かれたフォルダー）。区切り文字で複数指定できる。書き込み先は最初のフォルダー */
  csdbDirs: 'S1000D_CSDB_DIR',
} as const;

/**
 * 配布物と CSDB の場所。環境変数 → 設定ファイル（既定 ~/.config/s1000d-stack/config.json）の順に読む（core の resolveStackConfig）。
 * 呼ぶたびに読み直す（設定ファイルを直したらサーバーの再起動なしで効く）。
 */
export function stackConfig(): ResolvedStackConfig {
  return resolveStackConfig();
}

export function specDir(): string | undefined {
  return stackConfig().specDir;
}

export function csdbDirs(): string[] {
  return stackConfig().csdbDirs;
}

/** 配布物の場所が決まらないときの案内（環境変数か設定ファイルのどちらで決めるか） */
export function specDirHint(): string {
  return specDirHowTo(stackConfig());
}

/** 設定の注記（置き換えられずに渡った ${VAR}、読めない設定ファイル） */
export function stackConfigWarnings(): string[] {
  const c = stackConfig();
  return [
    ...c.warnings,
    ...(c.configError
      ? [`The config file ${c.configPath} could not be read: ${c.configError}`]
      : []),
  ];
}

/** 応答の大きさ・繰り返しの上限 */
export const LIMITS = {
  /** XML 文字列を直接渡すときの上限（バイト） */
  maxInlineXmlBytes: 5 * 1024 * 1024,
  /** 自動修正（exact の候補の適用）を繰り返す回数。既定と上限 */
  defaultFixRounds: 3,
  maxFixRounds: 10,
  /** 応答に載せる残りの修正候補の件数 */
  defaultMaxFixes: 50,
  maxMaxFixes: 1000,
  /** 候補 1 件に載せる選択肢の数 */
  maxCandidates: 20,
  /** convert_manual が 1 回で変換する DM の上限（画面ごとの手順を含む） */
  maxConvertedModules: 500,
} as const;
