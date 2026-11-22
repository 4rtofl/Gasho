# working server のコマンド

working server の上では、Gasho の画面を通さずに、`gasho-daemon session` でセッションを起動し、入力し、消せる。`gasho-daemon worktree remove` で、ワークツリーを中のセッションごと消せる。`gasho-daemon worktree name` で、ワークツリーにサイドバーで出す名前を付けられる。Claude Code のセッションから別のセッションを立ち上げて作業させるときや、終わった作業を片付けるときに使う（リポジトリの Skill `.claude/skills/launch-gasho-session` が、ワークツリーを作るところから起動を、`.claude/skills/remove-gasho-worktree` が片付けを、これで行う）。

```bash
gasho-daemon session launch --cwd <フォルダー> --name <名前> [--agent claude|codex] [--trust] [--prompt <文> | --prompt-file <ファイル> | --prompt -]
gasho-daemon session send <名前か ID> (--text <文> | --file <ファイル> | -)
gasho-daemon session list [--json]
gasho-daemon session remove <名前か ID>
gasho-daemon worktree remove <フォルダー> [--force]
gasho-daemon worktree name <フォルダー> (<名前> | --clear)
```

`service install` で入れたときは PATH に `gasho-daemon` が無いので、`node ~/.local/share/gasho/daemon/current/node_modules/@4rtofl/gasho-daemon/lib/cli.js session …` で呼ぶ。

## 仕組み

- 動いている gasho-daemon に、その置き場（`~/.config/gasho/`、`GASHO_DAEMON_CONFIG` で変わる）の Unix ソケット `control.sock` で頼む。ソケットは本人だけが使える（0600）。Gasho サーバーを通らないので、ペアリングも要らず、Gasho サーバーが止まっていても使える
- 中身は Gasho の画面からの起動・入力・名前の変更と同じ。起動したセッションは Gasho の画面にも出て、入力は作業中なら終わるまで待つ
- 失敗したときは、gasho-daemon が返した理由をエラーとして出す（終了コード 1）
- gasho-daemon が動いていないとき（ソケットが無い古い版のときも）は、そう伝えて起動の仕方を示す

## session launch

- 起動を待ち、プロンプトがあれば入力欄に送ってから、`{sessionId, name, cwd, terminal}` を JSON で出す
- `name` は `claude agents`（Claude Code のセッション一覧）に出る名前で、ほかのセッションから SendMessage するときの宛先になる。Claude Code は新しいセッションを `--remote-control` の名前ではなくフォルダー名で並べるので、`--name` を付けたときは、まず `/rename` でその名前に変え、一覧に出るまで待ってからプロンプトを送る。`--name` が無いと、最初の発言のあとで Gasho が発言から名前を付け直すので、出した名前は変わる
- `--trust` は、Claude Code の「このフォルダーを信頼するか」に Yes と答える（Gasho の画面の「信頼して起動する」と同じ）
- `--agent codex` は、Claude Code の代わりに Codex のセッションを起動する。指定がなければ Claude Code。Codex のセッションには端末がないので、JSON には `terminal` の代わりに `"agent": "codex"` が入る

## session send・list・remove

- `send` と `remove` は、`/clear` の前の ID でもセッションを見つける。出す JSON の `sessionId` は今の ID になる
- `list` は、セッションの ID の次にエージェント（`claude` か `codex`）を出す。作業フォルダーが無くなったセッションには、行末に `(folder missing)`（`--json` では `"cwdMissing": true`）を付ける。`--json` は、`/clear` の前の ID を `previousSessionIds` に出す
- `remove` は、Gasho の画面のセッションの削除と同じ。Claude Code を終わらせて Gasho から外し、`{sessionId, name, cwd}` を JSON で出す。会話は残る。フォルダーが先に消えたセッションも消せる

## worktree remove

Gasho の画面のワークツリーの削除と同じ。中のセッションを終わらせてからフォルダーを消し（`git worktree remove`）、`{path, branch, ended}` を JSON で出す。`ended` は終わらせたセッション（`{sessionId, name}`）。

- 未コミットの変更や、どのリモートにも無いコミットがあれば、何もせずにその件数を理由として返す。`--force` はそれでも消す
- ブランチは消さない
- `git worktree remove` で直接消すと、中のセッションは消えたフォルダーで動き続け、サイドバーの「リポジトリ外」に残る。このコマンドで消す

## worktree name

Gasho の画面の「名前を変更…」と同じ。指定したフォルダーのワークツリー（ワークツリーの中のフォルダーを指定しても、そのワークツリー）に名前を付け、`{path, name}` を JSON で出す。`path` はワークツリーの最上位のフォルダー。

- `--clear` で名前を消し、ブランチ名に戻す
- 名前に空白や `#` が入るときは、`"#254 accordion"` のように引用符で囲む（囲まないと、シェルが `#` から後ろを読まない）
- 名前は Gasho サーバーに保存するので、gasho-daemon が Gasho サーバーにつながっていないときは、そう伝えて失敗する。名前を保存できない古い Gasho サーバーは答えないので、10 秒待って失敗する
