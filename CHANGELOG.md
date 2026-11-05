# Changelog

## 0.2.0 (2026-11-06)

Grok Build の試用（hub の `eval/hosts/grok-build/reports/2026-11/FINDINGS.md` の F-03・F-05・F-07）で見つかった点を直しました（[#1](https://github.com/shuji-bonji/s1000d-writer-mcp/issues/1)・[#2](https://github.com/shuji-bonji/s1000d-writer-mcp/issues/2)）。依存の `@shuji-bonji/s1000d-core` は `^0.8.2` のままです（core 0.8.3 の「前に足す」修正候補は、0.8.3 を入れたときに `fixes[]` に出ます）。

### 変更（動きが変わります）

- **`applic` の無い下書きは組み立てません**（#1）。これまでは `_notes` に「applic: not given」と書くだけで、XSD に通らない DM（`schema.state: invalid`）を組み立てていました。`build_data_module` は、組み立てる前に `input-error`（`path` は `/applic`）を返します。適用範囲はサーバーが決めないため、既定の `applic` は入れません。`convert_manual` は、これまでどおり `scopeRefs` の無い Topic に `defaultApplic`（既定は表示文「すべて」）を使うので、動きは変わりません。
- **ツール引数の `csdbDirs` は、設定を置き換えます**（s1000d-verify-mcp#4・s1000d-reader-mcp#3 と同じ直し）。これまでは、渡したフォルダーと `S1000D_CSDB_DIR`・設定ファイルの `csdbDirs` を足し合わせていました。引数で渡したときは、そのフォルダーだけを使い（先頭が書き込み先）、渡さないときは、これまでどおり設定を使います。存在しないフォルダーは `_notes` で知らせます。先頭のフォルダー（書き込み先）がまだ無いときは、「まだ無い。`write: true` のときに作る」と書き分けます。

### 修正

- `convert_manual` を `write: false`・`includeXml: false` で呼ぶと、応答に XML が無いのに `_notes` が「The XML is only returned.」と書いていました（#2）。`includeXml: false` のときは「The XML is not returned either (includeXml is false)」と、応答の形に合う文にしました。

## 0.1.2 (2026-10-29)

hub の E2E テスト（`e2e/`）で見つかった点を直しました。ツールの入出力の形は変えていません。依存の `@shuji-bonji/s1000d-core` は `^0.8.2` です。

### 修正

- `build_data_module` は、既定 BREX が見つからず `brexDmRef` を省いたとき、`_notes` に「`brexDmRef` を省いた」ことしか書かず、BREX を照合していないことが分かりませんでした。照合した層が 0 件で見つからなかった BREX も無いときは、「BREX was not checked」という注記を `_notes` に足します。あわせて core 0.8.2 の修正で、そのときの `verification.brex.state` は `passed` ではなく `not-run` になります（`layers: 0`）。

## 0.1.1 (2026-10-28)

### 修正

- ツールの入力スキーマで、オブジェクトの引数（`draft`・`allocation`・`language` など）を `$ref` だけで書いていたため、`$ref` を解決しないクライアントが引数の型を決められず、オブジェクトを文字列として渡して `data/draft must be object` で拒否されていました（Claude Desktop の plugin 版で確認）。引数の位置に `$defs` の定義を展開し、`type: "object"` をその場に持たせました。入れ子の `$ref`（`DraftNode` の再帰など）は同じ `inputSchema` の `$defs` を指したままです。

## 0.1.0 (2026-10-28)

### 追加

- 初版。S1000D® のデータモジュールを、LLM が XML を書かずに作るための MCP サーバー。6 つのツール:
  - `build_data_module`: 構造化した下書き（`DraftDataModule`）と採番の規則から XML を組み立て、XSD・BREX・参照で検証し、候補が 1 つに決まる修正（`exact`）だけを自動で適用する（最大 `maxFixRounds` 回）。残った修正は `fixes[]` に候補付きで返す。
  - `convert_manual`: 体験型マニュアル（`experiential-manual-model`）を、Topic ごとの DM（説明・手順・故障探求・プロセスと画面ごとの手順・用語集）と PM に変換して組み立てる。DM・PM・ICN の参照は、書き込み前に重ねた CSDB の上で検証する。
  - `apply_fixes`: 提案された候補の写しだけを受け付けて適用する。候補の外の値、範囲に合わない値は理由付きで `rejected` にする。
  - `create_comment`: コメント DM を組み立てて検証する。
  - `extract_segments` / `apply_segments`: 翻訳用の文の取り出しと書き戻し。DM が変わっていれば `skeleton-mismatch` で止まる。
- 書き込みは `write: true` のときだけ。同じ名前のファイルは `overwrite: true` が無い限り上書きせず、XSD に違反する XML は `allowInvalid: true` が無い限り書かない。
- 入力の誤り（`DraftInputError` など）は `isError` ではなく、`path` 付きの構造化された `input-error` で返す。
- マニュアルから下書きへの変換（`manualToDrafts`）を `@shuji-bonji/s1000d-writer-mcp/convert` として公開。
- Streamable HTTP での起動（`--http`）、設定ファイル（`~/.config/s1000d-stack/config.json`）、Claude Code の plugin（`s1000d-writer`）。

### 注意

- core `^0.8.0` に依存する。0.8.0 が npm に出るまで、`package-lock.json` は 0.7.0 のまま。
