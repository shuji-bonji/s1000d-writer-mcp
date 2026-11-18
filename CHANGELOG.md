# Changelog

## 0.6.0 (2026-11-18)

発行済みのデータモジュールを、S1000D の版の決まりに沿って直すための入口を足しました。ツールは 9 つになります。

### 追加

- **`start_revision`（新しいツール）。** 発行済みの版（`inWork` が `00`）から、作業中の版（`inWork` が `01`）を作ります。`issueType`（`changed`・`revised`・`status`。`001-00` から始めるときだけ `new` も）は必須で、サーバーは選びません。前の版の変更の印と `reasonForUpdate` を消し、`changeType="delete"` の要素を取り除きます。`write: true` のときは、作業中の版を新しいファイル名（応答の `fileName`）で書きます。`path` を渡したときは同じフォルダーに、`xml` を渡したときは CSDB の書き込み先に書きます。発行済みの版のファイルは変えません。同じ名前のファイルがあれば `write-conflict` です。`reason` を渡すと、同じ呼び出しで `reasonForUpdate` を 1 つ足します。理由を足せないときは、版も始めません。
- **`add_reason_for_update`（新しいツール）。** 作業中の版の `dmStatus` に `reasonForUpdate` を 1 つ足します。本文には触らず、変更の印も付けません。変更の印を付けない変更（編集上の変更 `urt01`、`issueType` が `revised`・`status` の版）の理由を書くための入口です。発行済みの版は断ります。
- **`edit_data_module` の `marking`。** 渡すと、作業中の版に変更の印を付けます。insert は `changeType="add"`、remove は要素を残して `changeType="delete"`（`changes[].kept`）、同じ親の中の move は親に `changeType="modify"` です。`marking.reason` は、印が指す `reasonForUpdate` を足します（その理由による最初の編集）。`marking.reasonRefId` は、識別・状態部に既にある `reasonForUpdate` の `id` を指します（同じ理由による 2 回目からの編集）。どちらか一方だけを渡します。応答の `reasonForUpdate`（`added` が `true` なら足したもの）と `changes[].mark` に結果を返します。`marking` を渡したときは、`allowReleasedIssue` があっても発行済みの版を断ります。

### 変わらないもの

- `marking` を渡さない `edit_data_module` の動きは、0.5.1 と同じです。
- 発行（`inWork` を `00` に戻し、`issueNumber` を上げる）、`issueDate`・品質保証の状態の更新は行いません。

### テスト

- 自作の CSDB のテストを 2 件足しました（作業中の版を書く → 印を付けて編集する → 同じ理由で 2 回目の編集をする → 理由だけを足す、の一連。`start_revision` に理由を渡す場合と、断る場合）。

## 0.5.1 (2026-11-17)

`edit_data_module` の応答を、呼んだ側が次の操作を決めやすい形にしました。編集の結果と、書き込むかどうかの判定は変わりません。

### 変更（応答が変わります）

- **編集で増えた XSD のエラーへの候補を、`fixes[]` に載せなくなりました。** これまでは、`newSchemaErrors[]` のエラーに対する候補（その要素を取り除く、前に要素を足す、など）が `fixes[]` に並び、`_notes` が「候補から選んで `apply_fixes` を呼ぶ」と案内していました。この結果は書き込まれないので、`apply_fixes` には渡せません。`_notes` には、位置か編集を変えて `edit_data_module` を呼び直すことを書きます。編集の前からあった問題への候補は、これまでどおり載ります。

### 追加

- **`edit_data_module` に `includeXml` を足しました。** `false` を渡すと、応答に XML を入れません。既定は、`write` が `false` のとき `true`、`write` が `true` のとき `false` です（`convert_manual` と同じ）。0.5.0 は、`write: true` のときも XML を返していました。

## 0.5.0 (2026-11-17)

依存の `@shuji-bonji/s1000d-core` を `^0.13.0` に上げ、`edit_data_module` を足しました。ほかの 6 つのツールの動きは変わりません。

### 追加

- **`edit_data_module` を足しました。** 既にある手順・説明のデータモジュールに、節点を足す（`insert`）・取り除く（`remove`）・移す（`move`）編集を行います。core の `editContent` を呼び、結果を検証し直して返します。
  - 場所は `location.path`（s1000d-reader-mcp の `read_data_module` が返すもの）で指します。複数の編集を渡すときも、すべて編集の前の文書の場所で書きます。足す節点は下書きの節点（`step`・`para`・`admonition`・`listItem`）で、XML は受け取りません。
  - 1 つでも断る理由があれば何も適用せず、`refusals[]` に理由（`id-referenced`・`not-allowed-here`・`unsupported-node`・`released-issue` など）と場所を返します。
  - 元の文字列の編集した範囲だけを書き換えます。ほかは 1 文字も変わりません。
  - 版（`issueInfo`）も変更の印（`changeType`・`changeMark`・`reasonForUpdate`）も変えません。発行済みの版（`inWork` が `00`）は、`allowReleasedIssue: true` が無ければ断ります。
  - **編集の前には無かった XSD のエラーを `newSchemaErrors[]` に返し、その結果は `write: true` でも書き込みません**（`writeSkipped.reason` は `new-schema-errors`）。`allowInvalid` は、元から XSD に合わない文書を書くときだけ効きます。
  - 取り除いた `id` を、CSDB のほかのデータモジュール・PM の `dmRef/@referredFragment` が指しているときは、`referencedFromOtherObjects[]` に返して書き込みません（`referenced-from-other-objects`）。

## 0.4.0 (2026-11-17)

依存の `@shuji-bonji/s1000d-core` を `^0.12.0` に上げ、`apply_fixes` の入力に `position` を足しました。

### 変更（応答が変わります）

- **BREX の違反に返す修正候補が変わります。** core 0.12.0 の変更です。条件付きで禁止する BREX ルールの候補は、「この要素を取り除く」（`exact`）ではなく、条件を成り立たなくする変更（`replace`・`add`。確からしさは `several` か `none`）になります。`exact` の候補は自動で適用するので、これまでは `identAndStatusSection` や文書要素を取り除く候補を適用するおそれがありました。属性が無いことが条件のルールには、`add` の候補か `note` を返します。
- **`apply_fixes` が `candidate-not-offered` で断るときに、食い違った項目を `notes` に書きます。** `action` と値は合うのに `target`・`position` だけが違う候補があれば、その候補の `target` を知らせます。照合の厳しさは変わりません。

### 修正

- **`apply_fixes` の `selections[]` に `position` を足しました。** これまでは `action`・`target`・`value` だけを core に渡していたので、`position: "before"` が付いた候補（XSD の「この要素はここに置けない」に対する、兄弟を前に足す候補）は、候補をそのまま写しても `candidate-not-offered` で断られ、適用できませんでした。候補に `position` があるときは、選択にも写します。

## 0.3.1 (2026-11-16)

依存の `@shuji-bonji/s1000d-core` を `^0.11.0` に上げました。core 0.11.0 の変更は本文の読み取りです。このサーバーの動きは変わりません。

## 0.3.0 (2026-11-16)

実在の技術マニュアルを使った確認で見つかった、`convert_manual` の不足を直しました（s1000d-stack の docs/notes/tm-eval-requests.md の W-3）。ツールの入出力の形は変えていません。

### 変更（出力が変わります）

- **手順の飛び先（`Step.next`）を参照として書きます。** これまでは DM に入れず、`notRepresented` に「Step.next」として件数を返していました。
  - 同じ Topic の手順へは `internalRef`、別の Topic の手順・画面へはその DM への `dmRef` を、「次に進む: 」（条件があれば「〈条件〉、次に進む: 」）の段落にして手順の中に置きます。
  - 困ったときの対処（`isolationProcedureEnd`）は、条件の無い飛び先を対処の文の後ろに参照として並べます。
  - 並びのとおりに次の手順へ進むだけの `next`（条件が無く、行き先が次の手順・最初の子・親の次の手順）は、DM の中の並びが表しているので何も書かず、`notRepresented` にも数えません。
  - 行き先が別の DM の先頭以外の手順のときは、`dmRef` の `@referredFragment` でその手順を指します。変換しない Topic への `next` と、行き先の無い `next` は `notRepresented` に件数で返します。
- **作業前の要件（experiential-manual-model 0.3.0 の `Topic.prerequisites`）を、手順 DM・故障探求 DM の `preliminaryRqmts` に書きます**（W-1）。これまでは置き場所が無く、`preliminaryRqmts` はすべて「なし」でした。
  - `conditions` → 条件（`topicRef` があれば、その Topic の DM への参照を付けた `reqCondDm`）、`personnel` → `reqPersons/personnel`、`references` → `reqTechInfoGroup`（`topicRef` があれば `dmRef`、無ければ題名と番号の `externalPubRef`）、`equipment`・`supplies`・`spares` → `reqSupportEquips`・`reqSupplies`・`reqSpares`、`safety` → `reqSafety/safetyRqmts`。
  - S1000D の品目は識別子と数量が要ります。識別子（`natoStockNumber` か `manufacturerCode`）か `quantity` の無い品目がある Topic の DM は作らず、応答の `dataModules[]` のその行に `error`（`code: "input-error"`、`path` は品目の場所）を返します（W-10）。ほかの DM は作ります。品目を落として書くと、その区分が `noSupplies`・`noSupportEquips`・`noSpares` になり、「要らない」と読める DM になるためです。検証を通すために値を補うことはしません。数量は「As required」のような文でも構いません。
  - 品目の NATO 物品番号（experiential-manual-model 0.4.0 の `natoStockNumber`）を、`natoStockNumber` 要素として書きます。部品番号の無い品目も、NSN があれば書けます。`manufacturerCode` もあるときは、`identNumber` と両方を書きます。部品番号（`partNumber`）は `identNumber` に書くので `manufacturerCode` が要ります。NSN だけがある品目の部品番号は書かず、`notRepresented` に返します。
  - 説明・画面の流れの Topic に置いた `prerequisites` と、変換しない Topic への `topicRef` も、`notRepresented` に返します。
- **画面の手順の文を、Hotspot の名前（`label`）だけから作ります**（W-2）。説明（`description`）は操作の文の後ろに別の文として、図の番号（`callout`）は文の先頭に書きます（「（3）[Exit]を押す。メイン画面に戻る。」）。`label` に名前と説明をまとめて書いていると、文が崩れていました。
- 注意書きの見出し（`Admonition.title`）を書きます。見出しと本文を 2 つの段落にします。これまでは見出しを落としていました。
- **DM への参照（`dmRef`）の題名に、行き先の DM の `infoName` を書きます**（R11）。これまでは `dmTitle` に `techName`（マニュアルの題名）だけを書いていたので、「次に進む: 」の参照、困ったときの対処の参照、画面の流れの節、公開物（PM）の項目のどれにも、行き先の作業の名前が出ませんでした。`infoName` は行き先の DM 自身の `dmTitle/infoName` と同じ値です（Topic は題名、画面は「Topic の題名 - 画面の名前」、用語は「用語」）。作業前の要件の参照は、もともと書いていました。

### 変更

- 依存を `@shuji-bonji/s1000d-core` `^0.10.0`、`@shuji-bonji/experiential-manual-model` `^0.4.0` に上げました。
- 内容を埋め込んだ素材（`Asset.source.data`。model 0.2.0 から `source.path` は任意）は、形式を `mediaType` か data URL の種類から決めます。原本のファイルが無いので、ICN の原本はコピーされません（応答の `assets[].sourceExists` が false になります）。
- テストの券売機の例（`tests/fixtures/kenbaiki.manual.json`）を、model 0.3.0 の例に差し替えました。

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
