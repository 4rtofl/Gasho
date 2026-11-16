# iPhone で使う

Gasho の画面を、iPhone のホーム画面に追加した Web アプリとして使う。ブラウザの枠（アドレスバーやツールバー）が消えるので、画面を広く使える。この文書では、そのための用意と、これから作るものをまとめる。

## 方針

- iPhone 用のネイティブのアプリは作らない。いまの画面を、ホーム画面の Web アプリとして使う
- HTTPS は Tailscale Serve で用意する。ホーム画面の Web アプリで通知（Web Push）を受け取るには、HTTPS のページである必要がある。Tailscale なら、家の外からも同じ URL で使える
- 通知は Web Push で送る

ネイティブのアプリ（画面を Swift で作るもの、または WKWebView でこの画面を表示する殻）を採らなかった理由は次のとおり。

- 自分の iPhone に入れるだけなら無料でもできるが、署名が7日で切れ、通知（APNs）も使えない。通知を使うには Apple Developer Program（年99米ドル）が要る
- 画面を Swift で作り直すと、web と2つを保守することになる
- ネイティブでしかできないのは、ロック画面の通知から直接「許可」「拒否」を押すことや、Live Activity くらいである。いまは、通知からアプリを開いて答えれば足りる。足りなくなったら、Developer Program に入って、WKWebView の殻に APNs の通知を足すことを考える

## 用意する

### Gasho サーバー

1. Tailscale を入れて、ログインする
   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```
2. Tailscale の管理画面の DNS のページで、MagicDNS がオンになっているのを確かめ、HTTPS Certificates の「Enable HTTPS」を押す。マシン名と tailnet の名前は、証明書の公開ログ（Certificate Transparency）に載る。名前を変えるなら、この前に変える
3. Tailscale Serve で、Gasho サーバーの前に HTTPS の入り口を作る
   ```bash
   sudo tailscale serve --bg 7740
   ```
   `https://<マシン名>.<tailnet>.ts.net/` が Gasho の URL になる。`--bg` を付けると、再起動のあとも続く。設定は `tailscale serve status` で見られ、やめるときは `sudo tailscale serve reset` を実行する。証明書の取得と更新は Tailscale がする

### iPhone

1. Tailscale のアプリを入れ、同じアカウントでログインして、VPN をオンにする。オンのままにしておけば、再起動のあともつながる。ふだんはオフにしておきたいときは、アプリの設定の「VPN On Demand」で、`*.ts.net` を開いたときにつなぐようにもできる
2. Safari で Gasho の URL を開き、共有から「ホーム画面に追加」を選ぶ
3. ホーム画面のアイコンから開いて、登録コードを入れる。ホーム画面の Web アプリと Safari では Cookie が分かれていることがあるので、アプリの中で登録する

manifest やアイコンを変えたときは、ホーム画面から消して追加し直さないと反映されない。消すと登録も消えることがあるので、そのときは登録し直す。

### Tailscale Serve と Gasho サーバー

- Serve は、tailnet の端末から HTTPS で受けた通信を `http://127.0.0.1:7740` に渡す。Host をそのまま渡し、`X-Forwarded-Proto: https` を付けるので、同じオリジンかの確認と、Cookie の Secure はそのまま働く。WebSocket も通る
- Gasho サーバーからは、Serve を通る接続はどれも 127.0.0.1 から来たように見える。接続元を tailnet の端末に絞るのは、Serve の役目になる。登録コードの入力ミスの制限は、Serve を通る端末全体で1つになる
- そのため、`GASHO_ALLOW_NETS` は既定のままでよい。`tailscale` を加えると、HTTPS を通らない入り口（`http://100.x.y.z:7740`）も開く
- LAN の `http://<IP>:7740` も、これまでどおり使える。ただし、ホーム画面の Web アプリと通知は、HTTPS の URL でしか使えない

## 作るもの

### 1. ホーム画面向けの手直し

済んだもの：

- manifest（`display: standalone`）とアイコン（`apps/web/public/`）。アイコンは、Noto Emoji の 🙏 を画面の背景の色の上に置いた PNG（180・192・512 ピクセル）
- 画面に戻ったときと、ネットワークが戻ったときは、再接続の待ち時間（最大15秒）を待たずに、すぐつなぎ直す（`apps/web/src/lib/store.ts`）。iPhone は裏に回った Web アプリを止めるので、戻ったときには接続が切れていることが多い
- Gasho サーバーは、Vite がハッシュを付けて `assets/` に書き出すファイルだけを長くキャッシュさせ、ほかのファイル（index.html、manifest、アイコン、ライセンス）は毎回確かめさせる。名前の変わらないファイルを変えたときに、端末に古いものが残らないようにするためである
- スマホのセッション画面では、セッション名と状態を画面上部のバーに出し、セッションのヘッダーには出さない。ヘッダーを閉じたときの1行（約37px）がなくなり、会話がバーのすぐ下から始まる（`apps/web/src/App.tsx`、`apps/web/src/views/session.tsx`）
- スマホでパネル（ファイル、ブランチグラフ、Issues・Pull requests、プラグインのパネル）を開いたときも、パネルの題名と副題、右上のボタンを画面上部のバーに出し、パネルの見出しの段は出さない。「セッションに戻る」は、バーの左の ← になる。ボタンがバーに入りきらないときは、題名を数文字ぶん残し、ボタンの並びを横にスクロールして見る（`apps/web/src/components/side-panel.tsx`）

これから：

- 画面のいちばん上（時計の並ぶところ）まで背景を伸ばす（`apple-mobile-web-app-status-bar-style` と `env(safe-area-inset-top)`）。広さは変わらず、見た目だけが変わる

### 2. 通知（Web Push）

済んだもの（#77）：

- 使い方：ホーム画面に追加した Gasho で「設定」を開き、「この端末に通知する」をオンにする。iOS が通知の許可を求めるので、許可する。オンにすると、通知の種類（完了・確認待ち・入力待ち・エラー）ごとの切り替えが出る。最初は、入力待ち（応答のあと、しばらく入力がないとき）だけをオフにしている。完了の通知と続けて届くことが多いためである
- ロック画面に出すのは、セッションの名前と通知の種類（「応答が終わりました」など）だけで、会話の中身は出さない。同じセッションの通知は、新しいものが古いものと入れ替わる。通知を押すと、そのセッションを開く
- その端末で Gasho が前面に出ているあいだは、その端末には送らない。画面は、前面に出たときと裏に回ったときに Gasho サーバーに知らせ、前面にいるあいだは25秒ごとに ping を送る。60秒のあいだ何も届かない画面は、前面にいないものとみなす（iPhone は、知らせる前に止めることがあるため）
- アイコンのバッジに、確認待ちのセッションの数を出す（Badging API）。画面を開いているあいだは画面が、閉じているあいだは通知が届いたときに Service Worker が書き換える。閉じているあいだに確認が済んでも、バッジは次に通知が届くか、画面を開くまで減らない
- web：Service Worker（`apps/web/public/sw.js`）は、`push` で通知を出し、`notificationclick` でそのセッションを開くだけにした。ファイルはキャッシュしない。設定の画面は `apps/web/src/components/push-settings.tsx`、購読とバッジは `apps/web/src/lib/push.ts`
- hub：VAPID の鍵（P-256）は初回に作り、データベースの `meta` に保存する。購読は、端末ごとに `push_subscriptions` に保存する（schema 5）。通知を作るところ（`apps/hub/src/hub.ts` で `notificationFor` を呼ぶところ）で送る。暗号化（RFC 8291 の aes128gcm）と VAPID の署名（RFC 8292）は `node:crypto` で書き、依存は増やしていない（`apps/hub/src/push.ts`）。push service が 404・410 を返した購読は消す。端末の登録を取り消すと、その端末の購読も消す。Service Worker のファイルは `Cache-Control: no-store` で返す
- VAPID の `sub`（push service に伝える送り手）は、環境変数 `GASHO_VAPID_SUBJECT` で変えられる。既定は `https://github.com/4rtoflow/Gasho` で、個人の連絡先は入れない
- 通知は Apple の push service（`web.push.apple.com`）を経由するので、Gasho サーバーから外へつながる必要がある。iPhone の Tailscale がオフでも通知は届くが、タップして開くには Tailscale が要る
- Gasho サーバーのデータベースを作り直すと VAPID の鍵が変わり、それまでの購読には送れなくなる。そのときは、設定でもう一度オンにする

### 3. 接続の見張り

済んだもの（#77）：

- 画面は、前面にいるあいだは25秒ごとと、前面に戻ったとき（`visibilitychange`、`pageshow`、`online`）に、Gasho サーバーに `ping` を送る。8秒のうちに何も返ってこなければ、その接続をあきらめて、すぐにつなぎ直す。実際には切れているのに、切れたことが分からない接続を見分けるためである
- `ping` に答えない古い Gasho サーバー（最初に送る snapshot に `heartbeat` が無いもの）には、送らない

## 確かめたこと（2026年11月14日）

- Tailscale 1.104.7 の Serve で、`https://<マシン名>.<tailnet>.ts.net/` の Gasho を開けた。証明書は Let's Encrypt が出したもので、ISRG Root X1 につながる。同じオリジンかの確認、WebSocket（wss）、登録していない接続の切断（4401）は、Serve を通しても働いた
- iPhone は Tailscale で（中継なしで）直接つながり、この URL で登録して使えた
