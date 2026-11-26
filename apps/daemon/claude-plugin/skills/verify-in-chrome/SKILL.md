---
name: verify-in-chrome
description: 作った Web アプリの画面や動きを、実際の Chrome で操作して確かめる。今のセッション（gasho-daemon が起動・管理する Claude Code）を Claude in Chrome つきで fork し、写しに検証だけを任せて、結果を受け取る。「ブラウザーで確かめて」「画面で動くか見て」「Chrome で検証して」と頼まれたとき、または自分の変更を実機で確かめる必要があるのに `mcp__claude-in-chrome__*` の道具が無いときに使う。fork と片付けは `gasho-daemon session` サブコマンドに任せる。
---

# 今のセッションを Chrome つきで fork して検証させる

ブラウザーの道具は、必要なセッションにだけ持たせる。今のセッションはそのままにし、`gasho-daemon session fork --chrome` で、ここまでの会話ごと写したセッションを Claude in Chrome つきで起動する。写しが検証して、結果を SendMessage で返す。

今のセッションに `mcp__claude-in-chrome__*` の道具がもうあるなら、fork せずにそれを使う。

## 0. 先に利用者に確かめる

Claude in Chrome は、利用者の本物の Chrome を、そのプロファイルのログイン状態のまま操作する。その Chrome は working server に無くてもよく、同じ claude.ai アカウントでサインインした拡張機能があれば、別のコンピューター（利用者の手元の Mac など）の Chrome が開く。fork する前に、次のことを利用者に伝えて、よいと言われてから進める（同じ会話で一度よいと言われていれば、同じ種類の検証には聞き直さなくてよい）。

- 何を、どの URL で確かめるか
- その Chrome でタブが開き、操作されること（写しは自分のタブグループを使う）。普段使いでない、検証用のプロファイルを勧める
- 検証する URL に、その Chrome から届くこと（working server の `localhost` は、別のコンピューターの Chrome からは開けない。working server のアドレスか、ポートの転送が要る）

## 1. gasho-daemon の呼び方を決める

```sh
GD="node ${GASHO_DAEMON_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/gasho/daemon}/current/node_modules/@4rtofl/gasho-daemon/lib/cli.js"
command -v gasho-daemon >/dev/null && GD=gasho-daemon
$GD session list --json
```

- `gasho-daemon is not running` と出たら、daemon が止まっている。`usage:` に `session fork` が無ければ、daemon が古い。どちらも自分で起動・更新はせず、利用者に伝える（更新は Gasho の画面から行う）

## 2. 自分のセッションを見つける

`$GD session list --json` から、`sessionId`（または `previousSessionIds`）が環境変数 `CLAUDE_CODE_SESSION_ID` と同じもの（このコマンドを動かしている自分）を選ぶ。その変数が無い Claude Code では、`cwd` が今の作業フォルダーで、`status` が `busy` のものを選ぶ。返ってくる `name` が、写しから SendMessage で返事をもらう宛先になる。

- 見つからないとき: 今のセッションは Gasho が起動したものではないので、fork できない。利用者にそう伝える
- 候補が 2 つ以上あるとき: 推測せず、利用者に確かめる
- 一覧に `"chrome": true` のセッションがもう動いているとき: セッションごとにタブグループは分かれるが、同じ Chrome を同時に操作すると、ウィンドウの前面やフォーカスを取り合うおそれがある。新しく fork せず、終わるのを待つか、利用者に確かめる

## 3. 写しへの指示を書く

指示はファイルに書く（スクラッチパッドがあればそこ）。写しは会話を引き継ぐので、作ったものの説明は要らない。次のことを入れる。

- あなたは検証のために写されたセッションだということ。**ファイルを編集しない・コミットしない・プッシュしない**（親のセッションが同じフォルダーで作業している）
- 開く URL と、たどる手順、合格の条件
- 確かめたら、親のセッション `<自分の name>` に SendMessage で報告すること: 確かめたこと、合格・不合格、不合格ならその様子（コンソールのエラー、スクリーンショットのパスなど）
- `mcp__claude-in-chrome__*` が使えない、"Browser extension is not connected" と出る、または Chrome が応答しない（その Chrome のコンピューターが閉じている・眠っているなど）ときは、直そうとせずに、そのまま親に報告して止まること
- 最初に `tabs_context_mcp` を `createIfEmpty: true` で呼び、自分のタブグループを作ってから操作すること
- ログインやパスワードの入力、購入、送信など、外に作用する操作が要るときは、自分でせず親に報告すること

## 4. fork する

```sh
$GD session fork <自分の name> --name <自分の name>-chrome --chrome --prompt-file <指示のファイル>
```

- 結果は JSON で出る: `{ "sessionId", "name", "cwd", "terminal", "chrome": true, "forkOf" }`。`name` が写しの名前
- `warning` があれば、利用者に伝える
- 失敗したら、daemon が返した理由を利用者に伝える。Claude in Chrome の前提が欠けていそうなら、`$GD doctor` の「Claude in Chrome」を見るよう勧める。直接の Anthropic プランの `/login` が要り、API キーや Bedrock・Vertex では使えない

## 5. 結果を待って、片付ける

- 写しからの SendMessage を待つ。待つあいだ、検証している画面や機能のファイルは変えない
- 報告を受けたら、写しを消す: `$GD session remove <写しの name>`（会話は残る）
- 結果を利用者に伝え、不合格なら直してから、必要ならもう一度この手順で確かめる
- 写しが報告しないまま止まったように見えるときは、`$GD session list` で状態を見て、利用者に確かめる。勝手に消さない
