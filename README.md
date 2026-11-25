# Gasho

Mac や Ubuntu Server で動く Claude Code のセッションを、1つのブラウザー画面から起動し、指示を送り、見守るためのダッシュボード。スマホからも使える。

- **セッションを起動して操作する**：working server とフォルダーを選んで Claude Code（Remote Control）を起動し、指示、停止、権限の確認、モデルの切り替え、添付ができる。公式アプリからも同じセッションを操作できる
- **worktree ごとに並べる**：サイドバーにセッションを worktree ごとにまとめ、確認待ちやオフラインがひと目でわかる
- **リポジトリの様子を見る**：ブランチグラフ、フォルダーのファイル（編集もできる）、GitHub の Issue と Pull request を、セッションの横に開く
- **通知を受け取る**：応答の完了や確認待ちを、iPhone のホーム画面に追加した Gasho にも通知する
- **プラグインで足す**：[GashoPlugins](https://github.com/4rtofl/GashoPlugins) から画面と機能を足せる

Claude Code が動くマシンを **working server**、ダッシュボードのサーバーを **Gasho サーバー** と呼ぶ。

## 入れ方

Node.js 24 以上が要る。Gasho サーバーと gasho-daemon は、GitHub Packages の npm パッケージとして配っているので、リポジトリの clone は要らない。

### 1. GitHub Packages から入れられるようにする

Gasho サーバーと各 working server で、初めてのときだけ行う。

```bash
gh auth refresh -s read:packages
npm config set @4rtofl:registry https://npm.pkg.github.com
npm config set //npm.pkg.github.com/:_authToken "$(gh auth token)"
```

### 2. Gasho サーバーを常駐させる

```bash
npx @4rtofl/gasho-hub@latest service install   # Ubuntu は systemd、Mac は launchd。LAN 側の 0.0.0.0:7740 で待ち受ける
```

起動すると、LAN から開くときの URL がログに出る。受け付ける接続元は、既定ではこのマシンと LAN のプライベートアドレスだけ。詳しくは [docs/hub-setup.md](docs/hub-setup.md)。

### 3. ブラウザーを登録する

Gasho は、登録した端末からしか使えない。

```bash
npx @4rtofl/gasho-hub pair   # 登録コード（10分間有効、1回だけ使える）を出す
```

ブラウザーで `http://<Gasho サーバーの IP アドレス>:7740` を開き、コードを入れる。2台目からは、登録済みの端末の「端末」画面でもコードを出せる。

### 4. working server に gasho-daemon を入れる

Claude Code を動かすマシンごとに、gasho-daemon を1つ動かす。

```bash
npx @4rtofl/gasho-daemon register --server http://<Gasho サーバーの IP アドレス>:7740 --code <コード>
npx @4rtofl/gasho-daemon doctor            # 要るもの（Claude Code、git、gh、hooks など）が揃っているかを確かめる
npx @4rtofl/gasho-daemon service install   # 常駐させる
```

通知を使うときは hooks も入れる。詳しくは [docs/daemon-setup.md](docs/daemon-setup.md)。

常駐させた Gasho サーバーと gasho-daemon は、Gasho の「端末」の画面から更新できる。新しい版がうまく起動しなかったときは、自動で前の版に戻す。

### 外から使う

Gasho サーバーは LAN の中だけで使う前提にしている。外から使うときや、iPhone のホーム画面に追加して使うときは、Tailscale を入れ、Gasho サーバーで `sudo tailscale serve --bg 7740` を実行する。`https://<マシン名>.<tailnet>.ts.net/` で Gasho を開けるようになる。iPhone で通知を受け取る手順も含め、[docs/iphone.md](docs/iphone.md) にまとめた。

Mac の gasho-daemon を家の外からつなぐときは、Gasho サーバーの `~/.config/gasho/hub.env` に `GASHO_ALLOW_NETS=lan,tailscale` と書いて動かし直し、Tailscale のアドレスからも受け付ける。

LAN の中では通信が暗号化されない。端末のトークンも平文で流れるので、家の LAN を信用できる前提で使う。LAN を信用できないときも Tailscale を使う。

## ドキュメント

| 文書 | 中身 |
|---|---|
| [docs/usage.md](docs/usage.md) | 画面の使い方（セッション、サイドバー、入力欄、パネル、ホーム、プラグイン） |
| [docs/cli.md](docs/cli.md) | working server のコマンド（`gasho-daemon session`・`worktree`） |
| [docs/hub-setup.md](docs/hub-setup.md) | Gasho サーバーの入れ方、更新、設定 |
| [docs/daemon-setup.md](docs/daemon-setup.md) | gasho-daemon の入れ方、更新、設定 |
| [docs/iphone.md](docs/iphone.md) | 外から・iPhone で使う |
| [docs/plugins.md](docs/plugins.md) | プラグインの仕組みと API |
| [docs/development.md](docs/development.md) | 開発、テスト、公開 |
| [docs/spec.md](docs/spec.md) | 仕様 |
| [docs/research.md](docs/research.md) | 調査と検証の記録 |

## 構成

| ディレクトリ | 中身 |
|---|---|
| `apps/hub` | gasho-hub（Gasho サーバー）。各 working server からの情報をまとめて保存し、画面に配信する。端末の登録も管理する |
| `apps/daemon` | gasho-daemon。各 working server で動き、セッションの起動と入力、会話・hooks のイベントの送信を受け持つ |
| `apps/web` | gasho-web。画面（Vite・React・Tailwind CSS・easyui.site の部品） |
| `packages/protocol` | 3つで共有する型 |
| `packages/plugin-sdk` | プラグインの SDK |
| `e2e` | Playwright の E2E テスト |
| `infra/release-trigger` | 公開と E2E を定期的に起動する Cloudflare Worker |
| `nakamaba/` | Nakamaba で配信している「🙏 Gasho」のサイト（ダッシュボードとは別） |

## フォント・アイコン・音

画面のフォントは [Gen Interface JP](https://gen.typesetting.jp/)（Inter と Noto Sans JP を組み合わせた書体）で、npm の `gen-interface-jp` を使い、Gasho サーバーから配信する。外部の CDN には取りに行かない。使う太さは Regular・Medium・SemiBold の3つで、どれも文字の範囲ごとに分かれたファイルなので、ブラウザーは表示する文字を含むファイルだけを読み込む。ライセンスは SIL Open Font License 1.1 で、全文を `apps/web/public/licenses/gen-interface-jp-OFL.txt` に置き、画面と一緒に `/licenses/gen-interface-jp-OFL.txt` で配信している。

ホーム画面のアイコン（`apps/web/public/icons/`）は、[Noto Emoji](https://github.com/googlefonts/noto-emoji) の 🙏（`2D/svg/emoji_u1f64f.svg`）を画面の背景の色の上に置き、PNG にしたもの。ライセンスは SIL Open Font License 1.1 で、全文を `apps/web/public/licenses/noto-emoji-OFL.txt` に置き、`/licenses/noto-emoji-OFL.txt` で配信している。

拍手の音（`apps/web/src/assets/clap.mp3`。サイドバーのロゴの隠し機能で鳴らす）は、Freesound にある Landau00 の [HandClap1.wav](https://freesound.org/people/Landau00/sounds/463687/) のプレビュー（MP3）をそのまま使っている。ライセンスは CC0 1.0（パブリックドメイン）。頭の無音を飛ばすことと、音量をそろえることは、鳴らすときに画面（`apps/web/src/lib/clap.ts`）で行う。
