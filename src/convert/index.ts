/**
 * 体験型マニュアル → データモジュールの入力（`DraftDataModule`）の変換関数（ライブラリとして使う入口）。
 * MCP を介さずに呼べる。XML の組み立ては core の `buildDataModule`。
 */
export {
  formatOfAsset,
  issueInfoOfVersion,
  manualToDrafts,
  parseLanguage,
  xmlId,
  type ConvertOptions,
  type ConvertResult,
  type ConvertedAsset,
  type ConvertedDraft,
  type DraftRole,
  type NotRepresented,
} from './manual-to-draft.js';
