# Gasho を開発する

Node.js 24 以上が要る。TypeScript はビルドせずにそのまま実行する。リポジトリの構成は [README](../README.md#構成) を見る。

## clone から動かす

```bash
npm install
npm run web:build
npm run hub        # Gasho サーバー。LAN 側の 0.0.0.0:7740 で待ち受ける
npm run hub:pair   # 登録コードを出す
npm run web:dev    # Vite。/ws、/api、/plugins は Gasho サーバー（127.0.0.1:7740）に中継する
```

clone から動かしている Gasho サーバーは、Gasho の画面からは更新できない（`git pull` のあと動かし直す）。

## テストと型の確認

```bash
npm test
npm run typecheck
npm run test:coverage   # node --test で流すテスト（apps/*/test・scripts・e2e の .test.ts）について、ソースのファイルごとに、通った行・分岐・関数の割合を出す。画面を描く Vitest のテストは含まない（CI では流さない）
```

PR と main への push のたびに、GitHub Actions（`.github/workflows/ci.yml`）が Ubuntu で `npm run typecheck`・`npm test`・`npm run web:build` を流す。PR の画面に、それぞれの結果が別々に出る。

## E2E テスト

`e2e/` に、Playwright で実際の画面を操作するテストがある。ビルドした画面（`apps/web/dist`）を、Chromium（PC の幅）と WebKit（iPhone の幅・タッチ）で開く。

```bash
npx playwright install chromium webkit   # 初回だけ。ブラウザーを入れる
npm run e2e                              # 画面をビルドしてから、全部のテストを流す
npm run e2e -- --project chromium        # Chromium だけ。後ろに Playwright の引数を付けられる
npx playwright show-trace e2e/test-results/<テスト>/trace.zip   # 落ちたテストの操作と画面を見る
```

- テストごとに、`/tmp/ge2e-*` に置き場を作り、Gasho サーバーを 127.0.0.1 の空いているポートで起動する。DB・プラグイン・キャッシュ・`HOME` もそこに置くので、ふだん使う Gasho サーバー・gasho-daemon・Claude Code の設定と会話には触れない。テストが終わると置き場を消す
- ブラウザーは、登録コードで登録した状態（Cookie）で始まる
- working server は、テストから動かす偽の gasho-daemon（`hub.fakeDaemon()`）を主に使う。版・できること・セッション・会話・答えの遅れや失敗・オフラインを、テストから決められる
- 本物の gasho-daemon（`hub.startDaemon()`）も起動できる。claude と gh は偽物（`e2e/harness/bin/`）で、テストが渡した表から答え、受けた引数を記録する。偽の claude は、端末で動かすと入力欄を描き、送られた文に答えて会話のファイルに書く
- Gasho サーバーが使う gh（プラグインの一覧）と npm（公開されている最新の版）も偽物にしてある
- 起動の処理（`e2e/harness/index.ts`）は `@playwright/test` を読み込まないので、GashoPlugins のテストからも使える。Playwright の fixture は `e2e/tests/fixtures.ts` で組む

main では、GitHub Actions の `.github/workflows/e2e.yml` が毎日 5:00（日本時間）に流す。起動するのは Cloudflare Worker（`infra/release-trigger`）である。手で流すときは `gh workflow run e2e.yml`。テストが落ちると、trace・スクリーンショット・動画を run の artifact（`e2e-results`）に残し、落ちたテストの名前と run の URL を書いた Issue（`bug` ラベル）を立てる。同じテストの Issue が開いていれば、そこにコメントを足す。PR の CI では流さない。

## プラグインを作る

作っているプラグインは、Gasho サーバーでコマンドを実行して入れる。プラグインの仕組みと API は [plugins.md](plugins.md) にまとめた。

```bash
npm run hub:plugin -- add --link ~/repos/GashoPlugins/github/dist   # 作っているあいだ。ビルドするたびに画面と gasho-daemon が入れ替わる
npm run hub:plugin -- add ~/repos/GashoPlugins/github/dist          # ビルドしたものを写して入れる（カタログを使わないとき）
npm run hub:plugin -- list
npm run hub:plugin -- remove github
```

## 公開

gasho-daemon（`@4rtofl/gasho-daemon`）、Gasho サーバー（`@4rtofl/gasho-hub`。画面も入る）、プラグインの SDK（`@4rtofl/gasho-plugin-sdk`）は、GitHub Actions（`.github/workflows/release.yml`）が GitHub Packages に公開する。15分ごとに main を見て、前に公開してから中身が変わったパッケージだけを公開する。まだ一度も公開していないパッケージ（タグが無いもの）は、ソースに書いてある版のまま公開する。

ワークフローを15分ごとに起動するのは、Cloudflare Worker（`infra/release-trigger`）である。GitHub Actions の `schedule` では動かなかったため、Cron Trigger から `workflow_dispatch` で起動している。Worker のデプロイと、使うトークンの作り方・替え方は、[infra/release-trigger/README.md](../infra/release-trigger/README.md) に書いた。

版は x.y.z の形にする。

- x は変えない。gasho-daemon と Gasho サーバーは 0、SDK はプラグインの API のメジャーと同じ 1
- 機能を足したときは y を上げ、z を 0 に戻す。前に公開してからマージした PR に `enhancement` のラベルが付いているとき、またはプラグインの API の版（`PLUGIN_API`）が変わったときを、機能の追加とする
- それ以外は直しとして、z を上げる

機能を足す PR には `enhancement` のラベルを付ける。PR では版を変えない。公開するときに、GitHub Actions が新しい版を `apps/daemon/src/daemon.ts` の `DAEMON_VERSION`、`apps/hub/src/version.ts` の `HUB_VERSION`、`packages/plugin-sdk/package.json` に書いて main にコミットし、そのコミットに `daemon-v<版>`・`hub-v<版>`・`plugin-sdk-v<版>` のタグを付けてから公開する。タグを付けたあとで公開に失敗したときは、次の回にそのタグから公開し直す。Gasho サーバーは、画面（`apps/web`）や SDK の名前と見た目（`packages/plugin-sdk` の `src` と `theme.css`）が変わったときと、`package-lock.json` で外の依存の版が変わったときにも公開する。

15分を待たずに公開するときは、`gh workflow run release.yml` で動かす。次に何が公開されるかは、最新の main を checkout して `node scripts/release.ts plan` を実行すると見られる（何も変えない）。パッケージの中身を確かめるときは、`npm run pack -w @gasho/daemon`、`npm run pack -w @gasho/hub`、`npm run pack -w @gasho/plugin-sdk` で、それぞれの `dist/package` に作る。

## nakamaba/

`nakamaba/` は Nakamaba で配信している「🙏 Gasho」のサイト（ダッシュボードとは別）で、公開・更新は `nakamaba/` フォルダを指定して行う。

```bash
node <nakamaba スキルのフォルダ>/scripts/nakamaba.mjs publish nakamaba
```
