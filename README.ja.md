# @shuji-bonji/s1000d-writer-mcp

[English](./README.md) | **日本語**

S1000D® のデータモジュールを、LLM が XML を書かずに作るための MCP サーバーです。LLM は構造化した下書き（`draft`）と採番の規則を渡し、サーバーが XML を組み立て、XSD・BREX・参照で検証して、候補が 1 つに決まる修正（`exact`）だけを自動で適用します。候補が複数ある修正は選択を受けて適用し、候補の外の値は受け付けません。既定では何も書き込みません。

> [!IMPORTANT]
> このサーバーは ASD（Aerospace, Security and Defence Industries Association of Europe）とは無関係の個人プロジェクトです。S1000D® は ASD の登録商標です。
> S1000D の仕様書・XML スキーマ・公式サンプルは、利用条件により再配布できないため、このパッケージには含まれていません。XSD 検証を行うには、利用者ご自身で [s1000d.org](https://s1000d.org/) から配布物を入手し、展開したフォルダーを環境変数 `S1000D_SPEC_DIR` で指定してください。

## できること

| ツール | 内容 |
|---|---|
| `build_data_module` | 下書き 1 件（説明・手順・プロセス・故障探求・PM）と採番の規則から、データモジュールを組み立てます。DMC・ICN・版は台帳（`ledger`）と CSDB から決まり、同じ `sourceId` には同じ DMC が付きます。組み立てたあとに XSD・BREX・参照を検証し、`exact` の修正だけを最大 `maxFixRounds` 回まで自動で適用します。残った修正は `fixes[]` に候補付きで返します |
| `convert_manual` | 体験型マニュアル（[`@shuji-bonji/experiential-manual-model`](https://www.npmjs.com/package/@shuji-bonji/experiential-manual-model)）を、Topic ごとのデータモジュールとパブリケーションモジュールに変換して組み立てます。説明・手順・故障探求のほか、画面遷移はプロセス 1 件と画面ごとの手順にします。DM・PM・ICN の相互の参照は、CSDB に今回作った DM と原本のある ICN を重ねた上で解決します。変換で表せなかったものは `notRepresented` に件数で返します |
| `apply_fixes` | `fixes[]` で返した候補の中から選んだ修正を適用します。選択は候補の写しでなければならず、候補の外の値や、範囲に合わない値は理由付きで `rejected` にします。適用後に再検証します |
| `create_comment` | コメント DM（`comment`）を組み立てて検証します。連番は CSDB の次の番号です |
| `extract_segments` | データモジュールから、人が読む文（題名・段落・手順・警告・表のセル・図の題）を、翻訳用に取り出します。インライン要素は `{1}` `{2}` の記号に置き換え、`skeletonHash` を返します |
| `apply_segments` | 訳した文を元のデータモジュールに戻します。DMC は同じで、言語だけが変わります。取り出したあとにデータモジュールが変わっていれば `skeleton-mismatch` で止まります |

### 書き込みの規則

- **既定では何も書きません。** `write: true` を渡したときだけ、`csdbDirs` の最初のフォルダー（無ければ `S1000D_CSDB_DIR` の最初）に `DMC-….XML` を書きます。書き先が無ければ書かず、理由（`no-csdb-dir`）を返します。
- 同じ名前のファイルがあるときは上書きしません（`write-conflict`）。`overwrite: true` を渡すと上書きします。
- XSD に違反する XML は書きません（`schema-invalid`）。`allowInvalid: true` を渡すと書きます。`schema-not-found`（XSD が見つからない）は違反ではなく、未検証として書きます。
- `convert_manual` は、`write: true` のとき原本の素材を ICN のファイル名でコピーします。

### 自動で直す範囲

自動で適用するのは、`confidence` が `exact` で、候補がちょうど 1 つの修正だけです（例: BREX が責任企業を 1 つに決めているときの置き換え、BREX が禁じている要素の削除）。`several`（候補が複数、または範囲で示された値）と `none` は適用せず、`fixes[]` に返します。選ぶのは利用者で、サーバーは候補の外の値では直しません。適用した修正は `appliedFixes[]` に、変更前後の値つきで返します。

### 検証状態（`verification`）

すべての応答に、XSD・BREX・参照の検証状態が付きます。XSD が見つからなければ `schema-not-found`、省いた工程は `not-run` と明記され、どちらも `valid` ではありません。サーバーは検証の結果を伝えるだけで、S1000D への準拠は判定せず、違反の重大度も解釈しません。

### 入力の誤り

下書きや採番の規則の誤りは `isError` ではなく、`error: { code: "input-error", path, detail }` で返します。`path` は誤りの位置です（例: `/body[1]`、`/allocation/rules/infoCodeByKind/proced`）。直して呼び直してください。

## できないこと

> [!WARNING]
> - **LLM が書いた XML は受け取りません。** 組み立てるのは下書きからだけです。既存の XML を渡せるのは `apply_fixes` / `extract_segments` / `apply_segments` で、これらは文書の構造を変えません。
> - **候補の外の値では直しません。** 値を自由に書き込む入口はありません。
> - **検証を省きません。** 組み立てた XML は必ず検証して返します。
> - **S1000D への準拠は判定せず、違反の重大度も解釈しません。** 違反の中身は `s1000d-verify-mcp`、BREX のルールの説明は `s1000d-brex-mcp` で読んでください。
> - **翻訳はしません。** 文を取り出して戻すだけです。訳すのは LLM か人です。
> - **図の作成や、制限言語（STE）の判定はしません。** 図は ICN を採番して参照を入れるだけです。
> - 体験型マニュアルのホットスポットの座標や、`scopeRefs` の一部など、データモジュールで表せないものは `notRepresented` に報告し、黙って捨てません。
> - ACT・CCT・PCT は作りません。適用性は、下書きの `applic` と既存の適用性リポジトリを前提にします。

## 設定

| 環境変数 | 内容 |
|---|---|
| `S1000D_SPEC_DIR` | 利用者が入手した S1000D の配布物を展開したフォルダー。XSD（`xml_schema_flat/`）と既定 BREX をこの下から探します |
| `S1000D_CSDB_DIR` | プロジェクトのデータモジュールが置かれたフォルダー。`:`（Windows は `;`）区切りで複数指定できます。BREX の連鎖・参照先・既存の版をここから探し、最初のフォルダーが書き込み先になります |

ツールの引数 `csdbDirs` でフォルダーを追加することもできます（先頭が書き込み先）。

### 設定ファイル（Claude Desktop の plugin など、環境変数が渡らないとき）

`S1000D_SPEC_DIR` / `S1000D_CSDB_DIR` が無いときは、設定ファイル `~/.config/s1000d-stack/config.json`（`XDG_CONFIG_HOME` があればその下、`S1000D_CONFIG` で場所を変更可）を読みます。Claude Desktop は、plugin で入れたサーバーに環境変数を渡さないので、plugin で入れたときはこちらに書いてください。

```json
{
  "specDir": "/path/to/s1000d/issue-7",
  "csdbDirs": ["/path/to/your/csdb"]
}
```

環境変数があれば、そちらが優先します。設定ファイルは呼び出しのたびに読み直します。

### Claude Desktop / Claude Code の設定例

```json
{
  "mcpServers": {
    "s1000d-writer": {
      "command": "npx",
      "args": ["-y", "@shuji-bonji/s1000d-writer-mcp"],
      "env": {
        "S1000D_SPEC_DIR": "/path/to/s1000d/issue-7",
        "S1000D_CSDB_DIR": "/path/to/your/csdb"
      }
    }
  }
}
```

### HTTP で起動する（製品への組み込み）

既定は stdio です。`--http` を付けると Streamable HTTP で起動します。

```sh
npx -y @shuji-bonji/s1000d-writer-mcp --http                      # http://127.0.0.1:3000/mcp
npx -y @shuji-bonji/s1000d-writer-mcp --http --port 3102 --path /writer
```

| 引数 | 既定 | 内容 |
|---|---|---|
| `--host` | `127.0.0.1` | 束縛するアドレス |
| `--port` | `3000` | ポート。`0` で空いているポート |
| `--path` | `/mcp` | MCP のエンドポイントのパス。`GET /healthz` は名前と版を返します |
| `--allowed-host` | （下記） | `Host` ヘッダーに許すホスト名。カンマ区切りか複数回 |
| `--allowed-origin` | （下記） | `Origin` ヘッダーに許すホスト名 |

`--host` が loopback のときは、`Host` と `Origin` を localhost 系に限ります（DNS rebinding 対策）。それ以外のアドレスに束縛したときは検査しないので、製品側のリバースプロキシや認証の後ろに置いてください。このサーバーはファイルを書き込めるため、とくに認証の無い公開は避けてください。

## 仕組み

組み立て・検証・修正・コメント・セグメントの処理はすべて共有ライブラリ [`@shuji-bonji/s1000d-core`](https://www.npmjs.com/package/@shuji-bonji/s1000d-core) にあり、このサーバーは引数の解釈と応答の形、そしてマニュアルから下書きへの変換（`src/convert/`）だけを持ちます。入力スキーマは core の `draft.schema.json` の定義を取り込んでいます。変換は `@shuji-bonji/s1000d-writer-mcp/convert` からも使えます。

## 開発

```sh
npm install
npm test            # 自作のテストデータ（tests/fixtures/）だけで動く
npm run test:spec   # 利用者が入手した配布物を使う（S1000D_SPEC_DIR で場所を指定。既定 ../../specs/s1000d/issue-7）
npm run build && S1000D_SPEC_DIR=/path/to/issue-7 S1000D_CSDB_DIR=/path/to/csdb npm start   # stdio で起動
```

## ライセンス

MIT。S1000D® は ASD の登録商標です。このソフトウェアは ASD とは無関係で、仕様書・スキーマ・公式サンプルを含みません。
