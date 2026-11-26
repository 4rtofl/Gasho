# working server のコマンド

working server の上では、Gasho の画面を通さずに、`gasho-daemon session` でセッションを起動し、入力し、消せる。`gasho-daemon worktree remove` で、ワークツリーを中のセッションごと消せる。`gasho-daemon worktree name` で、ワークツリーにサイドバーで出す名前を付けられる。Claude Code のセッションから別のセッションを立ち上げて作業させるときや、終わった作業を片付けるときに使う（gasho-daemon が起動したセッションに読ませるプラグインのスキル `gasho:launch-gasho-session` が、ワークツリーを作るところから起動を、`gasho:remove-gasho-worktree` が片付けを、`gasho:verify-in-chrome` が Chrome での検証を、これで行う。[spec.md の「worktree での作業」](spec.md#worktree-での作業)）。

```bash
gasho-daemon session launch --cwd <フォルダー> --name <名前> [--agent claude|codex] [--trust] [--chrome] [--prompt <文> | --prompt-file <ファイル> | --prompt -]
gasho-daemon session fork <名前か ID> [--name <名前>] [--chrome] [--prompt <文> | --prompt-file <ファイル> | --prompt -]
gasho-daemon session send <名前か ID> (--text <文> | --file <ファイル> | -)
gasho-daemon session list [--json]
gasho-daemon session remove <名前か ID>
gasho-daemon worktree remove <フォルダー> [--force]
gasho-daemon worktree name <フォルダー> (<名前> | --clear)
```

`service install` で入れたときは PATH に `gasho-daemon` が無いので、`node ~/.local/share/gasho/daemon/current/node_modules/@4rtofl/gasho-daemon/lib/cli.js session …` で呼ぶ。

## 仕組み

- 動いている gasho-daemon に、その置き場（`~/.config/gasho/`、`GASHO_DAEMON_CONFIG` で変わる）の Unix ソケット `control.sock` で頼む。ソケットは本人だけが使える（0600）。Gasho サーバーを通らないので、ペアリングも要らず、Gasho サーバーが止まっていても使える
- 中身は Gasho の画面からの起動・入力・名前の変更と同じ。起動したセッションは Gasho の画面にも出て、作業中の入力は Gasho の画面から送ったときと同じく扱う
- 失敗したときは、gasho-daemon が返した理由をエラーとして出す（終了コード 1）
- gasho-daemon が動いていないとき（ソケットが無い古い版のときも）は、そう伝えて起動の仕方を示す

## session launch

- 起動を待ち、プロンプトがあれば入力欄に送ってから、`{sessionId, name, cwd, terminal}` を JSON で出す
- Claude Code のセッションの中（Bash ツールなど）で呼ぶと、そのセッション（環境変数 `CLAUDE_CODE_SESSION_ID`）を、起動したセッションの親として覚える。JSON には親の ID を `launchedBy` で出す。gasho-daemon が知らないセッションなら覚えず、`launchedBy` も出ない。Gasho の画面には `SessionInfo.launchedBy` で渡る
- Gasho のセッションの Agent が worktree で作業するときは、Agent ツールの `isolation: "worktree"` や `EnterWorktree` ではなく、これで worktree にセッションを立てる（gasho-daemon の hook がそれらを止める）
- `name` は `claude agents`（Claude Code のセッション一覧）に出る名前で、ほかのセッションから SendMessage するときの宛先になる。Claude Code は新しいセッションを `--remote-control` の名前ではなくフォルダー名で並べるので、`--name` を付けたときは、まず `/rename` でその名前に変え、一覧に出るまで待ってからプロンプトを送る。`--name` が無いと、最初の発言のあとで Gasho が発言から名前を付け直すので、出した名前は変わる
- `--trust` は、Claude Code の「このフォルダーを信頼するか」に Yes と答える（Gasho の画面の「信頼して起動する」と同じ）
- `--agent codex` は、Claude Code の代わりに Codex のセッションを起動する。指定がなければ Claude Code。Codex のセッションには端末がないので、JSON には `terminal` の代わりに `"agent": "codex"` が入る
- `--chrome` は、Claude in Chrome つき（`claude --chrome`）で起動する。セッションは、利用者の Chrome を、そのプロファイルのログイン状態のまま操作できる。Chrome は working server に無くてもよく、同じ claude.ai アカウントでサインインした Claude の拡張機能があれば、別のコンピューターの Chrome にもつながる。セッションごとに、自分のタブグループを使う。休止から再開しても、`--chrome` のまま戻る。初回に Claude Code が出す Claude in Chrome の説明は、Enter で閉じる。Anthropic のプランでの `/login` と、Chrome の Claude の拡張機能（同じアカウントでサインイン）が要る。`doctor` の「Claude in Chrome」は、working server の Chrome がつながるかを示す。検証には、普段使いでない Chrome のプロファイルを勧める

## session fork

Gasho の画面のフォークと同じ。Gasho が起動したセッションを、ここまでの会話ごと、同じフォルダーの新しいセッションに写して起動を待ち、プロンプトがあれば送ってから、`{sessionId, name, cwd, terminal, forkOf}` を JSON で出す。`--chrome` を付けると、写しは Claude in Chrome つきで起動する（元のセッションが Chrome つきなら、付けなくても Chrome つき）。セッションが自分を写して、ブラウザーでの検証を任せるのに使う（Skill `gasho:verify-in-chrome`）。

## session send・list・remove

- `send` と `remove` は、`/clear` の前の ID でもセッションを見つける。出す JSON の `sessionId` は今の ID になる
- `list` は、セッションの ID の次にエージェント（`claude` か `codex`）を出す。`--json` は、Chrome つきのセッションに `"chrome": true` を出す。作業フォルダーが無くなったセッションには、行末に `(folder missing)`（`--json` では `"cwdMissing": true`）を付ける。`--json` は、`/clear` の前の ID を `previousSessionIds` に、`session launch` で親として覚えたセッションの今の ID を `launchedBy` に出す
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
