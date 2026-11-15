# gasho-release-trigger

GitHub Actions の Release ワークフロー（`.github/workflows/release.yml`）を、15分ごとに動かす Cloudflare Worker。

GitHub Actions の `schedule` は、遅れたり動かなかったりする。Gasho でも、`schedule` で一度も動かなかった。そこで、Cloudflare の Cron Trigger で15分ごとにこの Worker を動かし、GitHub の API（`POST /repos/4rtoflow/Gasho/actions/workflows/release.yml/dispatches`）で、main の Release ワークフローを `workflow_dispatch` として起動する。

公開するかどうかは、これまでどおりワークフローの中の `scripts/release.ts plan` が決める。この Worker は起動するだけである。GitHub が起動を断ったとき（トークンの期限切れなど）は、例外を投げる。Cloudflare のダッシュボードで、この Worker のログと Cron の実行結果を見るとわかる。

## 準備

### 1. トークンを作る

GitHub の Settings → Developer settings → Personal access tokens → Fine-grained tokens で作る。

- Resource owner：`4rtoflow`
- Expiration：組織が認める最長
- Repository access：Only select repositories → `4rtoflow/Gasho`
- Permissions：Repository permissions の Actions を Read and write にする。ほかは足さない（Metadata の Read-only は自動で付く）

組織が fine-grained PAT に承認を求めているときは、組織のオーナーが承認するまで使えない。

### 2. デプロイする

Cloudflare には `npx wrangler login` でログインしておく。

```sh
cd infra/release-trigger
npm install
npx wrangler deploy
npx wrangler secret put GITHUB_TOKEN   # 1 で作ったトークンを貼る
```

`npx wrangler tail` を開いておくと、次の15分の区切りで起動したことがわかる。GitHub 側では `gh run list --workflow release.yml` に、`workflow_dispatch` の実行が15分ごとに並ぶ。

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
