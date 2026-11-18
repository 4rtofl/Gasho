---
name: remove-gasho-worktree
description: 作業を終えたワークツリーを、中の Gasho のセッション（gasho-daemon が起動・管理する Claude Code）ごと片付ける。「ワークツリーを消して」「マージしたワークツリーを片付けて」「完了した PR のワークツリーとセッションを消して」「レビューが終わったワークツリーを掃除して」「リポジトリ外のセッションを消して」などと頼まれたときに使う。消すのは `git worktree remove` ではなく `gasho-daemon worktree remove` と `gasho-daemon session remove` に任せる。
---

# ワークツリーをセッションごと片付ける

作業を終えたワークツリーを、`gasho-daemon worktree remove` で中のセッションごと消す。最後に、作業フォルダーが無くなったセッションを `gasho-daemon session remove` で片付ける。

`git worktree remove` で直接消してはいけない。中のセッション（Claude Code のプロセス）は消えたフォルダーの中で動き続け、Gasho の画面に「リポジトリ外」のセッションとして残る。`gasho-daemon worktree remove` は、Gasho の画面からの削除と同じく、中のセッションを終わらせてから消す。

## 1. gasho-daemon の呼び方を決める

`gasho-daemon` が PATH にあればそれを使う。`service install` で入れた daemon（managed install）は PATH に無いので、`current` の cli.js を node で直接呼ぶ。Bash の呼び出しをまたいでシェルの変数は残らないので、毎回同じ書き方で始める。

```sh
GD="node ${GASHO_DAEMON_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/gasho/daemon}/current/node_modules/@4rtofl/gasho-daemon/lib/cli.js"
command -v gasho-daemon >/dev/null && GD=gasho-daemon
$GD session list
```

- `gasho-daemon is not running` と出たら、daemon が止まっているか、古い版が動いている。自分で起動・更新はせず、利用者に伝える（更新は Gasho の画面から行う）。
- `usage:` が出て `worktree remove` や `session remove` が載っていないときも、daemon が古い。同じく利用者に伝え、`git worktree remove` で代わりに消すことはしない。
- 別の state フォルダーで動かしている daemon に頼むときは、同じ `GASHO_DAEMON_CONFIG` を付けて呼ぶ。

## 2. 消す候補を決める

利用者がワークツリーを指定していればそれを使う。「マージしたものを」のように指定が無ければ、一覧から候補を作る。

```sh
git -C /home/rg/repos/<Repo> fetch origin --prune
git -C /home/rg/repos/<Repo> worktree list
```

リポジトリのフォルダーそのもの（main のワークツリー）は消さない。

## 3. 消してよいかを確かめる

候補ごとに、次の両方を確かめる。

- **PR がマージ済みか、閉じている**: ブランチ名で探す。

  ```sh
  gh pr list --repo <owner>/<Repo> --head <branch> --state all --json number,state,url
  ```

  `MERGED` か `CLOSED` なら消してよい。`OPEN` のもの、PR が見つからないものは消さずに残し、報告に書く（利用者がはっきり消すよう頼んだものは除く）。
- **変更が残っていない**: `git -C <worktree> status --short` が空で、push していないコミットが無いこと。`gasho-daemon worktree remove` も同じことを確かめ、残っていれば消さずに理由を返すので、ここでは目安でよい。

どれを消すかに迷うときは、消す前に利用者に一覧を見せて確かめる。

## 4. 消す

```sh
$GD worktree remove /home/rg/repos/<Repo>-worktrees/<issue>-<slug>
```

- 中のセッションを終わらせてから、ワークツリーのフォルダーを消す。ブランチは消さない
- 結果は JSON で出る。`ended` は終わらせたセッション

```json
{ "path": "/home/rg/repos/Gasho-worktrees/79-session-launch", "branch": "feat/79-session-launch", "ended": [{ "sessionId": "…", "name": "79-session-launch" }] }
```

- 未コミットの変更や push していないコミットがあると、消さずにその件数をエラーで返す。そのワークツリーは残し、理由を報告する。`--force`（変更を捨てて消す）は、利用者がそのワークツリーについてはっきり頼んだときだけ使う
- セッションが終わらないときも、消さずに理由を返す。そのまま報告する
- 自分が今いるワークツリーは消さない（このセッション自身が終わってしまう）

## 5. フォルダーの無いセッションを片付ける

先に `git worktree remove` などで消されたワークツリーのセッションは、`worktree remove` では見つからない。`session list` で、作業フォルダーが無いもの（表示では行末の `(folder missing)`、`--json` では `"cwdMissing": true`）を探して消す。

```sh
$GD session list --json
$GD session remove <ID>
```

- 名前ではなく作業フォルダー（`cwd`）で探す。名前は最初のメッセージのあとで変わることがあり、同じ名前のセッションがほかにあることもあるため。消すときは ID を渡す
- 消すのは、作業フォルダーが無く、今回の片付けに関係するもの（消したワークツリーのリポジトリの `<Repo>-worktrees/` の下など）だけ。ほかのセッションは、フォルダーが無くても消さずに報告に書く
- `session remove` は Claude Code を終わらせ、Gasho から外す。会話は残るので、`claude --resume` で開き直せる
- 消せるのは Gasho が起動したセッションだけ。`session list` に出ないものは扱えない

## 6. 報告する

利用者に次のことを伝える。

- 消したワークツリー（パスとブランチ）と、一緒に終わらせたセッション
- 片付けた、フォルダーの無いセッション
- 残したワークツリーとセッション、残した理由（PR が開いている、変更が残っている、など）
- ブランチは残っていること（消すかどうかは利用者が決める）
