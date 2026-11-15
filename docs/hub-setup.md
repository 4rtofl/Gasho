# Gasho サーバーのセットアップ

Gasho サーバー（gasho-hub）は、ブラウザーと各 working server の gasho-daemon をつなぎ、Gasho の画面を配るプログラム。この文書では、Gasho サーバーを GitHub Packages の npm パッケージ `@4rtoflow/gasho-hub` から入れて常駐させ、Gasho の画面から更新するまでを説明する。working server の用意は [daemon-setup.md](daemon-setup.md) を見る。

## 1. 要るもの

| もの | 使う機能 | ないとき |
|---|---|---|
| Node.js 24 以上 | Gasho サーバーそのもの | 動かない |
| GitHub Packages から入れる npm の設定 | 入れる、更新する、公開されている最新の版を調べる | 入れられない。更新できない |
| GitHub CLI（`gh`）、ログイン済み | プラグインの画面で GashoPlugins からプラグインを追加する | プラグインを追加できない |

npm の設定は、gasho-daemon と同じもの（[daemon-setup.md](daemon-setup.md) の「2. GitHub Packages から入れられるようにする」）。Gasho サーバーと gasho-daemon を同じマシンで動かすときは、一度設定すればよい。

## 2. 入れて常駐させる

```bash
npx @4rtoflow/gasho-hub@latest service install
```

`service install` は、次のことを行う。

1. 実行した版の Gasho サーバーを、版ごとのフォルダー（`~/.local/share/gasho/hub/versions/<版>`）に npm で入れる
2. 入れた版が起動できること、画面のファイルがそろっていること、データベースを開けること（データベースの写しで）を確かめる
3. 使う版を指すリンク（`~/.local/share/gasho/hub/current`）をその版に向け、その版の起動用のファイル（`launcher.mjs`）を横に置く
4. 常駐の設定ファイルを書き出す。Ubuntu では systemd のユーザーサービス（`~/.config/systemd/user/gasho-hub.service`）、Mac では launchd のエージェント（`~/Library/LaunchAgents/local.gasho.hub.plist`）。前の設定ファイルがあれば、`.bak` を付けて残す
5. systemd か launchd に設定を読ませて有効にし、Gasho サーバーを起動する。動いていれば、動かし直す

ほかの Gasho サーバーが 7740 番を使っているときは、5 で有効にするだけで起動しない。その Gasho サーバーを止めてから、表示されるコマンド（Ubuntu では `systemctl --user start gasho-hub`）で起動する。

データベース（`~/.local/share/gasho/hub.db`）、入れたプラグイン、設定は、これまでと同じ場所のものを使う。登録した端末も、そのまま使える。

ブラウザーを登録するコードは、Gasho の「端末」の画面か、次のコマンドで出す。

```bash
npx @4rtoflow/gasho-hub pair
```

### Ubuntu（systemd）

ログインしていなくても、マシンが起動したときから Gasho サーバーが動くように、一度だけ次を実行しておく（`service install` も、まだのときは知らせる）。

```bash
loginctl enable-linger "$USER"
```

| すること | コマンド |
|---|---|
| 状態を見る | `systemctl --user status gasho-hub` |
| ログを見る | `journalctl --user -u gasho-hub -f` |
| 動かし直す | `systemctl --user restart gasho-hub` |
| 止める | `systemctl --user stop gasho-hub` |

### Mac（launchd）

| すること | コマンド |
|---|---|
| 状態を見る | `launchctl print gui/$(id -u)/local.gasho.hub` |
| ログを見る | `tail -f ~/Library/Logs/gasho-hub.log` |
| 動かし直す | `launchctl kickstart -k gui/$(id -u)/local.gasho.hub` |
| 止める | `launchctl bootout gui/$(id -u)/local.gasho.hub` |

### リポジトリの clone から移す

clone で `npm run hub` を動かしていたときは、次の順に移す。場所・host・port が同じなので、登録、トークン、プラグイン、設定は引き継がれる。

1. ふつうの端末で `npx @4rtoflow/gasho-hub@latest service install` を実行する。7740 番は clone の Gasho サーバーが使っているので、常駐の設定をして有効にするだけで、起動はしない
2. clone の Gasho サーバーを止める（動かしている端末で Ctrl+C）
3. `systemctl --user start gasho-hub`（Mac では表示された `launchctl bootstrap …`）で起動する
4. ブラウザーで Gasho を読み込み直す

起動するときに環境変数で渡していた設定（`GASHO_ALLOW_NETS=lan,tailscale` など）は、先に `~/.config/gasho/hub.env` に書いておく（「設定」の節）。clone に戻すときは、`systemctl --user disable --now gasho-hub` のあと、clone で `npm run hub` を動かす。

## 3. 更新する

`service install` で常駐させた Gasho サーバーは、Gasho の画面から更新できる。「端末」の画面の「Gasho サーバーと gasho-daemon の更新」の先頭の行に、Gasho サーバーの版と、公開されている最新の版が出る。更新できるときは、サイドバーの「端末」に「更新」と出る。「<版> に更新」を押すと、Gasho サーバーが次の順に進め、画面にもその段階が出る。

1. 新しい版を、今の版とは別のフォルダーに npm で入れる
2. 新しい版が起動できること、画面のファイルがそろっていること、データベースの写しを開けること（移行が要る版なら、写しで移行できること）を確かめる
3. 処理中の命令（セッションへの送信、起動、clone、プラグインの呼び出しと追加など）が終わるのを待つ。そのあいだ新しい命令は「Gasho サーバーを更新しています」と断る。2分たっても終わらないときは、更新をやめる
4. データベースを `hub.db.before-<版>` に写し、使う版を新しい版に切り替えて終わる。systemd か launchd が、新しい版で起動し直す

1〜3 で失敗したときは何も変えず、画面に理由を出す。

- 起動し直すあいだ（数秒）は、Gasho につながらない。セッションは working server で動き続ける
- 開いているページは、つながり直したときに新しい画面へ読み込み直す。入力欄に書きかけの文や添付があるページ、保存していないファイルがあるページ、ダイアログを開いているページは読み込み直さず、「Gasho が新しい版になりました」の帯を出す。帯の「読み込み直す」で読み込み直す（書きかけは消える）
- clone の Gasho サーバーで `npm run web:build` をしたときも、開いているページは同じように新しい画面になる

### 新しい版がうまく起動しなかったとき

切り替えたあとの新しい版は、最初の1分を試しの期間として動く。1分動き続け、自分の確かめ（`/api/health` に答えること、画面のファイルがあること、起動用のファイルが動くこと）が通ったら、うまく起動したとみなす。

試しの期間のうちに止まった版（データベースを開けない、待ち受けられない、例外で落ちたなど）は、次に起動するときに、起動用のファイルが前の版に戻す。読み込むこともできない版は、その場で前の版に戻して起動する。戻したときは、画面の Gasho サーバーの行に理由が出る。

- 試しの期間に、サービスを止めたり、マシンを起動し直したりしても、失敗には数えない。次に起動したときに、新しい版をもう一度試す
- 7740 番をほかの Gasho サーバーがまだ使っているときも、失敗には数えない。空くまで数秒ごとに起動し直す（systemd では2秒、launchd では5秒）
- 起動用のファイルは、うまく起動した最後の版のものを使う。新しい版の起動用のファイルが壊れていても、戻すことはできる

次のものは自動では戻せない。画面の「<前の版> に戻す」か、Gasho サーバーのマシンの端末で `npx @4rtoflow/gasho-hub service use <前の版>` を実行して戻す。

- 止まらずに固まる版
- 試しの期間を過ぎてから落ちる版（systemd が起動し直し続ける）
- ブラウザーでだけ壊れる画面

前の版のフォルダーは、「<前の版> に戻す」のために残しておく。うまく起動したあとで、今の版と戻す先の版のほかのフォルダーと、最後の更新の前のデータベースの写しのほかを消す。

### 手で更新する

Gasho の画面から更新できないときは、画面にその理由とコマンドが出る。

- clone から動かしている：`git pull` のあと、`npm ci`（依存が変わったとき）と `npm run web:build` をして、Gasho サーバーを動かし直す
- 常駐させずに動かしている、`npm install -g` で入れた、Gasho からの更新に対応する前の版：Gasho サーバーのマシンで `npx @4rtoflow/gasho-hub@latest service install` を一度実行する。これからは Gasho から更新できる

### データベースの決まり（Gasho を作る人へ）

前の版に戻すと、前の版が、新しい版が触ったデータベースを開く。そのため、データベースの変更（`apps/hub/src/store.ts` の移行）は、足すのを先に、消すのは次の版にする。

- 新しい表、NULL か既定値のある列、索引、JSON の項目は、足してよい
- 前の版が読み書きする表と列は、消さない、名前を変えない、型を変えない。消すのは、それを読まない版を公開したあとにする
- どうしても守れない移行は、`meta` の表の `min_schema` を自分の schema に上げる。それより古い版は、データベースを開かずに理由を出す。このときは自動で前の版に戻すこともできなくなるので、`hub.db.before-<版>` から戻す手順を添えて公開する

## 設定（環境変数）

Gasho サーバーの設定は環境変数で変える。Gasho サーバーのコマンドは、どれも起動するときに `~/.config/gasho/hub.env` を読むので、そこに `名前=値` の形で1行ずつ書いておけば、常駐させたときも端末で動かすときも同じ値になる。端末で設定した値のほうが優先される。ほかのファイルを読ませるときは `GASHO_HUB_ENV=<ファイル>`、読ませないときは `GASHO_HUB_ENV=off` にする。

```bash
mkdir -p ~/.config/gasho
echo "GASHO_ALLOW_NETS=lan,tailscale" >> ~/.config/gasho/hub.env
```

変数の一覧は [README](../README.md) の「環境変数」にある。常駐と更新に使うものは次のとおり。

| 変数 | 意味 | 既定値 |
|---|---|---|
| `GASHO_HUB_HOME` | `service install` と更新が、Gasho サーバーを版ごとに入れるフォルダー | `~/.local/share/gasho/hub` |
| `GASHO_HUB_PROBATION_MS` | 更新したあとの試しの期間（ミリ秒） | `60000` |
| `GASHO_NPM_BIN` | 版を入れ、最新の版を調べる npm | Node.js と同じフォルダーの `npm` |
| `GASHO_LATEST_CHECK` | `off` にすると、公開されている最新の版を調べない | なし |

## やめる

1. 常駐をやめる
   - Ubuntu：`systemctl --user disable --now gasho-hub` のあと、`~/.config/systemd/user/gasho-hub.service` を消す
   - Mac：`launchctl bootout gui/$(id -u)/local.gasho.hub` のあと、`~/Library/LaunchAgents/local.gasho.hub.plist` を消す
2. 入れた版を消す：`~/.local/share/gasho/hub` をフォルダーごと消す
3. データをすべて消すときは、`~/.local/share/gasho/hub.db`（と `hub.db.before-<版>`）、`~/.local/share/gasho/plugins`、`~/.cache/gasho/hub-plugins` を消す。登録した端末は、すべて登録し直しになる

## うまくいかないとき

| こと | 確かめること |
|---|---|
| 「この版の Gasho サーバーは、Gasho からは更新できません」と出る | 更新に対応する前の版。Gasho サーバーのマシンで `npx @4rtoflow/gasho-hub@latest service install` を一度実行する |
| 「Gasho サーバーの版は、まだ公開されていません」と出る | `@4rtoflow/gasho-hub` がまだ公開されていない。公開されると、最新の版が出る |
| 更新に失敗する（npm で入れられない） | Gasho サーバーのマシンの npm の設定（1）。`npm view @4rtoflow/gasho-hub version` が版を返すか |
| 更新に失敗する（データベースを開けない） | 新しい版の移行が、データベースの写しで失敗した。何も変わっていない。理由を添えて知らせる |
| 更新に失敗する（処理中の命令が終わらない） | 長くかかる clone や起動が終わってから、もう一度更新する |
| 更新のあと、Gasho につながらない | ログ（2 の表）。試しの期間のうちに止まっていれば、次の起動で前の版に戻る。戻らないときは `npx @4rtoflow/gasho-hub service use <前の版>` |
| 「自動で戻しました」と出る | 画面の理由と、ログ（2 の表）の、新しい版が止まったところ |
| `service install` のあと起動しない | 7740 番を使っているほかの Gasho サーバーを止めて、`systemctl --user start gasho-hub` |
