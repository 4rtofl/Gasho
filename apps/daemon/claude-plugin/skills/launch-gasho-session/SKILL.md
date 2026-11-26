---
name: launch-gasho-session
description: ワークツリーを作り、その中で Gasho のセッション（gasho-daemon が起動・管理する Claude Code）を立ち上げて、作業を指示する。「セッションを立ち上げて実装させて」「#79 を別セッションでやって」「ワークツリーを切って Issue を進めさせて」「並行で作業させて」「worktree で作業して」などと頼まれたとき、また Subagent を worktree で動かそうとしたとき（Agent の isolation "worktree" や EnterWorktree）に使う。起動と入力は `gasho-daemon session` サブコマンドに任せる。
---

# Gasho のセッションを立ち上げて作業させる

ワークツリーを作り、`gasho-daemon session launch` でその中にセッションを起動して、指示文を送る。起動したセッションは Gasho の画面に出て、ほかのセッションと同じように見守れる。

Gasho のセッションでは、worktree での作業を Agent ツールの `isolation: "worktree"` の Subagent や `EnterWorktree` でしない（gasho-daemon の hook が止める）。それらでは worktree の中にセッションができず、Gasho の画面から作業を見守れないため。「Subagent でやって」と頼まれても、worktree を使う作業はこの手順にする。worktree を使わない Subagent（Explore などの調べもの）はそのまま使ってよい。

起動と入力は gasho-daemon がする。hub へのペアリングや WebSocket など、プロトコルの細かい部分はここでは扱わない。

## 1. gasho-daemon の呼び方を決める

`gasho-daemon` が PATH にあればそれを使う。`service install` で入れた daemon（managed install）は PATH に無いので、`current` の cli.js を node で直接呼ぶ。Bash の呼び出しをまたいでシェルの変数は残らないので、毎回同じ書き方で始める。

```sh
GD="node ${GASHO_DAEMON_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/gasho/daemon}/current/node_modules/@4rtofl/gasho-daemon/lib/cli.js"
command -v gasho-daemon >/dev/null && GD=gasho-daemon
$GD session list
```

- `gasho-daemon is not running` と出たら、daemon が止まっているか、`session` サブコマンドを持たない古い版が動いている。自分で起動・更新はせず、利用者に伝える（更新は Gasho の画面から行う）。
- `usage:` だけが出て `session` が載っていないときも、daemon が古い。同じく利用者に伝える。
- daemon は state フォルダー（`~/.config/gasho/`、`GASHO_DAEMON_CONFIG` で変えられる）のソケット `control.sock` で受け付ける。別の state フォルダーで動かしている daemon に頼むときは、同じ `GASHO_DAEMON_CONFIG` を付けて呼ぶ。

## 2. ワークツリーを作る

場所とブランチの名前は、リポジトリ（CLAUDE.md、docs の開発の手引きなど）や利用者に決まりがあればそれに従う。無ければ次のようにする。

- 場所: リポジトリの隣の `<Repo>-worktrees/<名前>`（リポジトリが `~/src/Foo` なら `~/src/Foo-worktrees/79-session-launch`）
- ブランチ: `feat/<名前>`。Issue の作業なら `<名前>` は `<issue>-<slug>`
- 既定のブランチ（`origin/main` など）から作る

```sh
git -C <Repo> fetch origin
git -C <Repo> worktree add -b feat/<名前> <Repo>-worktrees/<名前> origin/main
```

依存関係が要るリポジトリなら、ここで入れておく（`package-lock.json` があれば、そのフォルダーで `npm ci`）。指示文に「済み」と書けば、セッションは入れ直さずに始められる。

同じ名前のブランチやフォルダーが既にあるときは、上書きせず、利用者に確かめる。

## 3. 指示文を書く

指示文はファイルに書いてから渡す（長い文や記号を、シェルの引用で崩さないため）。スクラッチパッドがあればそこに置く。次のことを入れる。

- 何をするか。Issue なら番号と、本文の読み方（`gh issue view <番号>`）
- 作業フォルダーとブランチ（このワークツリーで作業し、元のリポジトリでは作業しないこと）
- 完了の条件（通すテストや型チェック、確かめること）
- PR にするなら、その書き方（`Closes #<番号>`、付けるラベル）と、最後に報告すること
- してはいけないこと（live の環境を止める・更新する、手でバージョンを上げる、など）
- 関連するセッションの探し方: 名前ではなく作業フォルダーで探す（`$GD session list` や ListAgents の一覧の作業フォルダー）。名前は、最初のメッセージのあとに変わることがあるため
- 迷う判断は、決める前に確認すること
- 利用者の言語やコミットの書き方など、利用者の決まりがあればそれも

## 4. 起動する

```sh
$GD session launch --cwd <Repo>-worktrees/<名前> --name <名前> --trust --prompt-file <指示文のファイル>
```

- `--name` は必ず付ける。付けると、daemon はまず `/rename` でその名前を Claude Code に付け、ListAgents にその名前が出るまで待ってから指示文を送る。付けないと、最初のメッセージのあとで Gasho がタイトルから名前を付け直すので、返ってきた名前がすぐ古くなる
- `--trust` は、作ったばかりのワークツリーを Claude Code に信頼させる（「このフォルダーを信頼するか」に Yes と答える）。利用者のリポジトリに自分で作ったワークツリーにだけ使う
- 指示文は `--prompt TEXT`、`--prompt-file FILE`、`--prompt -`（標準入力）のどれかで渡す
- 呼んだセッション（このセッション）は、起動したセッションの親として覚えられる。Gasho の画面は、それを元に親子を出す
- 結果は JSON で出る:

```json
{ "sessionId": "…", "name": "79-session-launch", "cwd": "/home/u/src/Foo-worktrees/79-session-launch", "terminal": "gasho-79-session-launch-1a2b", "launchedBy": "…" }
```

`name` は、ListAgents に出る実際の名前。`launchedBy` は親として覚えたセッションの ID。`warning` があれば、名前を付け直せなかったなど、うまくいかなかったことが書いてあるので、利用者に伝える。失敗したときは、daemon が返した理由（フォルダーが無い、信頼されていない、など）がエラーとして出る。

## 5. 起動したあと

- 連絡は、返ってきた `name` で SendMessage する（ListAgents に出る名前と同じ）。指示を足すときは `$GD session send <name> --text "…"`（または `--file FILE`、`-`）でも入力欄に送れる。セッションが作業中なら、終わるまで待ってから入力される
- 様子を見るには `$GD session list`（名前・状態・作業フォルダー・ID）。端末をそのまま見るには `$GD attach <terminal>`（Ctrl+] で抜ける）
- 利用者には、起動したセッションの名前、ワークツリーのパス、ブランチ、送った指示の要点を報告する
- 作業が終わったあとの片付け（ワークツリーとセッションを消す）は、Skill `gasho:remove-gasho-worktree` を使う。`git worktree remove` で消すと、中のセッションが「リポジトリ外」に残る
