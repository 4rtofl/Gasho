# gasho-release-trigger

GitHub Actions のワークフローを、決まった時刻に動かす Cloudflare Worker。次の 2 つを動かす。

- Gasho の Release ワークフロー（`.github/workflows/release.yml`）：15分ごと
- Gasho と GashoPlugins の E2E（どちらも `e2e.yml`）：毎日 5:00（日本時間。Cron は UTC で `0 20 * * *`）

GitHub Actions の `schedule` は、遅れたり動かなかったりする。Gasho でも、`schedule` で一度も動かなかった。そこで、Cloudflare の Cron Trigger でこの Worker を動かし、GitHub の API（`POST /repos/<リポジトリ>/actions/workflows/<ワークフロー>/dispatches`）で、main のワークフローを `workflow_dispatch` として起動する。どの Cron で何を動かすかは、`wrangler.jsonc` の `vars.DISPATCHES` に、Cron の式ごとに書く。式は `triggers.crons` と同じ文字列にする。

公開するかどうかは、これまでどおりワークフローの中の `scripts/release.ts plan` が決める。この Worker は起動するだけである。GitHub が起動を断ったとき（トークンの期限切れなど）は、例外を投げる。同じ Cron のほかのワークフローは、それでも起動する。Cloudflare のダッシュボードで、この Worker のログと Cron の実行結果を見るとわかる。

GashoPlugins の `e2e.yml` は 4rtofl/GashoPlugins#135 で足す。それまでは GitHub が 404 を返すので、`mayBeMissing` を付けて、404 を失敗にせずログに書くだけにしている。#135 が main に入ったら、`mayBeMissing` を外す（外さないと、ワークフローの名前を変えたときなどの 404 に気付けない）。

## 準備

### 1. トークンを作る

GitHub の Settings → Developer settings → Personal access tokens → Fine-grained tokens で作る。

- Resource owner：`4rtofl`
- Expiration：組織が認める最長
- Repository access：Only select repositories → `4rtofl/Gasho` と `4rtofl/GashoPlugins`
- Permissions：Repository permissions の Actions を Read and write にする。ほかは足さない（Metadata の Read-only は自動で付く）

組織が fine-grained PAT に承認を求めているときは、組織のオーナーが承認するまで使えない。

Release だけを動かしていたころのトークンは、`4rtofl/Gasho` にしか権限がない。GitHub の画面でそのトークンを開き、Repository access に `4rtofl/GashoPlugins` を足す（作り直さなくてよい）。足すまでは、GashoPlugins の E2E の起動を GitHub が断り、Cloudflare のログに失敗が出る。

### 2. デプロイする

Cloudflare には `npx wrangler login` でログインしておく。

```sh
cd infra/release-trigger
npm install
npx wrangler deploy
npx wrangler secret put GITHUB_TOKEN   # 1 で作ったトークンを貼る
```

`npx wrangler tail` を開いておくと、次の15分の区切りで起動したことがわかる。GitHub 側では `gh run list --workflow release.yml` に、`workflow_dispatch` の実行が15分ごとに並ぶ。E2E は、毎日 5:00（日本時間）のあとに `gh run list --workflow e2e.yml` に並ぶ。

## 公開を止める

main にマージすると、最長15分で公開される。マージしても公開したくないときは、ワークフローを止める。

```sh
gh workflow disable release.yml   # 止める
gh workflow enable release.yml    # 戻す
```

止めているあいだも Worker は起動を頼むが、GitHub が断るので Cloudflare のログに失敗が出る。長く止めるときは、Cloudflare のダッシュボードでこの Worker の Cron を外す。

## トークンを替える

期限が来る前に、1 と同じ手順で新しいトークンを作り、`npx wrangler secret put GITHUB_TOKEN` で入れ替える。期限が切れると、Release ワークフローは起動しなくなる（Cloudflare のログに `HTTP 401` が出る）。

## テスト

```sh
npm test
```

この Worker は npm workspaces に入れていない。入れると、Release ワークフローの `npm ci` で wrangler まで入るためである。
