# リリース手順

`@shuji-bonji/s1000d-writer-mcp` の公開手順です。認証は Trusted Publisher（GitHub Actions の OIDC）で行い、`NPM_TOKEN` は使いません。

> [!IMPORTANT]
> Trusted Publisher は **既に npm に存在するパッケージ**にしか設定できません。そのため 0.1.0 だけは手動で `npm run build && npm publish --access public` を行います（D-14。公開日は CHANGELOG.md に書きます）。0.1.1 以降は tag の push で `.github/workflows/publish.yml` が公開します。

## 0.1.0 を公開する前に（core 0.8.0 が先）

このサーバーは core の書き出し・修正・コメント・セグメントの API（0.8.0）に依存します。`package.json` は `^0.8.0` を指していますが、`package-lock.json` は core 0.7.0 で作ったままです。0.8.0 が npm に出るまで、`npm install` は通りません。

1. `@shuji-bonji/s1000d-core` 0.8.0 を公開する（core 側の RELEASE.md に従う）
2. このリポジトリで `npm install` を実行し、`package-lock.json` を 0.8.0 に更新してコミットする
3. `npm test && npm run test:spec && npm run lint && npm run format:check && npm run build` が通ることを確認する
4. 手動で `npm publish --access public`（下の注意を参照）
5. 下の「一度だけ行う設定」で Trusted Publisher を設定する
6. `mcp-publisher publish` で MCP Registry に載せる
7. claude-plugins リポジトリに `s1000d-writer` を追加し、`node scripts/marketplace-version-check.mjs --write` を実行する

## 一度だけ行う設定（npm 側。0.1.0 の公開後）

1. https://www.npmjs.com/package/@shuji-bonji/s1000d-writer-mcp/access を開く
2. 「Trusted Publishers」→「Add」
3. Publisher: **GitHub Actions**、Repository: `shuji-bonji/s1000d-writer-mcp`、Workflow filename: `publish.yml`、Environment: 空欄

## 通常のリリース

```sh
# 1. main を最新にし、テストが通ることを確認する
git checkout main && git pull
npm test && npm run lint && npm run format:check && npm run build

# 2. CHANGELOG.md に版の節を書く

# 3. 版を上げる（package.json と git tag を同時に更新）
npm version patch -m "release: v%s"   # 0.1.0 → 0.1.1
# npm version minor -m "release: v%s" # 0.1.0 → 0.2.0

# 4. tag を push する（publish.yml が動く）
git push --follow-tags

# 5. Actions の結果を確認する
gh run watch

# 6. MCP Registry にも同じ版を載せる（npm に反映されてから。Actions が緑になった後、さらに 2〜5 分かかる）
npm view @shuji-bonji/s1000d-writer-mcp@$(node -p "require('./package.json').version") mcpName   # 行が出るまで待つ
mcp-publisher publish   # 初回は先に mcp-publisher login github
```

`npm version` の version フックが `scripts/sync-plugin-version.mjs` を呼び、`.claude-plugin/plugin.json` と `server.json` の版を `package.json` に揃えてリリースコミットに含めます。`claude-plugins` の `marketplace.json` は揃わないので、公開後に claude-plugins リポジトリで `node scripts/marketplace-version-check.mjs --write` を実行してください。

## 版の上げ方の目安

| 変更 | 版 |
|---|---|
| 不具合の修正、既存の振る舞いを変えない追加 | patch |
| ツールや型の追加、応答の形の追加（既存の結果が変わり得る） | minor |
| ツール・公開 API の削除・改名、応答の形の非互換な変更 | major（1.0.0 以降） |

> [!NOTE]
> このサーバーは `@shuji-bonji/s1000d-core` に依存します。0.x の間、`^0.8.0` のような範囲は core の minor をまたぎません。core の minor を上げて使うときは、`dependencies` の範囲を上げてこのサーバーも公開し直してください。

## うまくいかないとき

| 症状 | 原因と対処 |
|---|---|
| `npm publish` が 404 | Trusted Publisher の設定が無い。上の「一度だけ行う設定」を確認する |
| `package.json version does not match tag` | `npm version` を使わず tag だけ打った。版を揃えて tag を付け直す |
| `npx publish` を実行してしまった | 別物の古いパッケージ（`publish@0.6.0`）が起動する。`npm publish` を使う |
