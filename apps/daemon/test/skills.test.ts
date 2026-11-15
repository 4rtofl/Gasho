// What a session's Claude Code takes after "/": read from the places Claude Code reads, with its names and
// precedence, and without what it leaves out of its "/" menu.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { frontmatter, listSkills } from "../src/skills.ts";

async function write(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}

const skill = (description: string, extra = "") => `---\ndescription: ${description}\n${extra}---\n\n# Body\n`;

test("the person's, the folder's (up to the top of its worktree), the plugins' and the synced skills, by name", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-skills-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const claude = path.join(root, "home", ".claude");
  const repo = path.join(root, "repo");
  const wt = path.join(root, "repo-wt");
  const cwd = path.join(wt, "apps", "web");

  // The person's: a skill whose frontmatter names it, one hidden from "/", and command files.
  await write(path.join(claude, "skills", "review-dir", "SKILL.md"), skill("個人のレビュー", "name: review\n"));
  await write(path.join(claude, "skills", "quiet", "SKILL.md"), skill("Claude だけが使う", "user-invocable: false\n"));
  await write(path.join(claude, "skills", "deploy", "SKILL.md"), skill("個人の deploy"));
  await write(path.join(claude, "commands", "frontend", "component.md"), "部品を作る\n");
  await write(path.join(claude, "commands", "deploy.md"), "---\ndescription: 隠れるコマンド\n---\n");
  // The folder's and those above it, up to the worktree's top (the repository's main checkout has its own).
  await write(path.join(cwd, ".claude", "skills", "near", "SKILL.md"), skill("フォルダーのスキル"));
  await write(path.join(wt, ".claude", "skills", "deploy", "SKILL.md"), skill("プロジェクトの deploy"));
  await write(path.join(wt, ".claude", "skills", "top", "SKILL.md"), skill("worktree の上のスキル"));
  await write(path.join(wt, ".claude", "commands", "off-one.md"), "設定で消す\n");
  await write(path.join(cwd, ".claude", "settings.local.json"), JSON.stringify({ skillOverrides: { "off-one": "off" } }));
  await write(path.join(root, ".claude", "skills", "above", "SKILL.md"), skill("リポジトリの外"));
  await write(path.join(repo, ".claude", "skills", "main-only", "SKILL.md"), skill("main checkout のスキル"));
  // Plugins: one for everyone, one disabled, one installed for another project.
  const plugin = path.join(root, "plugins", "tools");
  await write(path.join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "tools", skills: ["./extra"] }));
  await write(path.join(plugin, "skills", "lint", "SKILL.md"), skill("プラグインの lint"));
  await write(path.join(plugin, "extra", "fmt", "SKILL.md"), skill("manifest が足す fmt"));
  await write(path.join(plugin, "commands", "status.md"), "状態を出す\n");
  await write(path.join(root, "plugins", "off", "skills", "nope", "SKILL.md"), skill("無効"));
  await write(path.join(root, "plugins", "elsewhere", "skills", "there", "SKILL.md"), skill("ほかのプロジェクト"));
  await write(
    path.join(claude, "plugins", "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        "tools@market": [{ scope: "user", installPath: plugin }],
        "off@market": [{ scope: "user", installPath: path.join(root, "plugins", "off") }],
        "elsewhere@market": [{ scope: "project", projectPath: path.join(root, "other"), installPath: path.join(root, "plugins", "elsewhere") }],
      },
    }),
  );
  await write(path.join(claude, "settings.json"), JSON.stringify({ enabledPlugins: { "off@market": false } }));
  // Synced from claude.ai: only the account Claude Code is signed in with.
  await write(path.join(claude, "skills", "synced", "org_acct", "pdf", "SKILL.md"), skill("PDF を扱う"));
  await write(path.join(claude, "skills", "synced", "org_other", "old", "SKILL.md"), skill("別のアカウント"));
  const claudeJson = path.join(root, "home", ".claude.json");
  await write(claudeJson, JSON.stringify({ oauthAccount: { organizationUuid: "org", accountUuid: "acct" } }));

  const list = await listSkills({ claudeDir: claude, claudeJson, cwd, worktree: { path: wt, repo } });
  assert.deepEqual(list, [
    { name: "anthropic-skills:pdf", description: "PDF を扱う" },
    { name: "deploy", description: "個人の deploy" },
    { name: "frontend:component", description: "部品を作る" },
    { name: "near", description: "フォルダーのスキル" },
    { name: "review", description: "個人のレビュー" },
    { name: "tools:fmt", description: "manifest が足す fmt" },
    { name: "tools:lint", description: "プラグインの lint" },
    { name: "tools:status", description: "状態を出す" },
    { name: "top", description: "worktree の上のスキル" },
  ]);

  // A linked worktree without skills at its top gets those of the main checkout.
  await fs.rm(path.join(wt, ".claude", "skills"), { recursive: true });
  const names = (await listSkills({ claudeDir: claude, claudeJson, cwd: wt, worktree: { path: wt, repo } })).map((s) => s.name);
  assert.ok(names.includes("main-only"));
  assert.ok(!names.includes("near") && !names.includes("above"));
});

test("a frontmatter's values come as one line: block scalars, quoted strings, plain values over several lines", () => {
  const { fields, body } = frontmatter(
    [
      "---",
      "name: impl-review",
      "description: |",
      "  実装報告書を読み直し、",
      "  PR を出してよいか判定する。",
      'argument-hint: "[issue \\"番号\\"]"',
      "when_to_use: 'it''s for reviews'",
      "effort: high",
      "metadata:",
      "  owner: me",
      "long: one",
      "  two",
      "---",
      "# 本文",
    ].join("\n"),
  );
  assert.equal(fields.get("name"), "impl-review");
  assert.equal(fields.get("description"), "実装報告書を読み直し、 PR を出してよいか判定する。");
  assert.equal(fields.get("argument-hint"), '[issue "番号"]');
  assert.equal(fields.get("when_to_use"), "it's for reviews");
  assert.equal(fields.get("long"), "one two");
  assert.equal(body, "# 本文");
  // Not frontmatter unless the file starts with it.
  assert.equal(frontmatter("text\n---\nname: x\n---\n").fields.size, 0);
});
