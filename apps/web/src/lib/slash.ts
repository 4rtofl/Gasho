// The "/" list of the chat box: while the text is "/" and the start of a name, the skills and custom commands of the
// session's Claude Code that the name could be, as Claude Code's own "/" menu offers them.

export interface SlashCommand {
  /** What follows the "/". */
  name: string;
  description?: string;
}

/** What follows the "/" while the text is still a command's name (nothing after it yet); undefined for other texts. */
export function slashQuery(text: string): string | undefined {
  return /^\/(\S*)$/.exec(text)?.[1];
}

/** A command the typed name could be, and where in its name the typed text is (to underline it). */
export interface SlashMatch<T extends SlashCommand> {
  command: T;
  at: number;
}

/**
 * The commands whose name starts with the typed text, then those with a part of their name that does (after ":", "-"
 * or "_": "review" finds "impl-review", "beer" finds "anthropic-skills:beer-style"). Case is ignored. Each group is in
 * the order of the names after their last ":", so that a plugin's or claude.ai's skills ("anthropic-skills:…") sit
 * among the others instead of before them.
 */
export function matchSlash<T extends SlashCommand>(commands: T[], query: string): SlashMatch<T>[] {
  const q = query.toLowerCase();
  const found = commands.flatMap((command) => {
    const name = command.name.toLowerCase();
    if (name.startsWith(q)) return [{ command, at: 0, rank: 0 }];
    for (const sep of name.matchAll(/[:_-]/g)) {
      const at = sep.index + 1;
      if (name.startsWith(q, at)) return [{ command, at, rank: 1 }];
    }
    return [];
  });
  const order = (c: T) => `${c.name.slice(c.name.lastIndexOf(":") + 1)}\0${c.name}`;
  found.sort((a, b) => a.rank - b.rank || (order(a.command) < order(b.command) ? -1 : order(a.command) > order(b.command) ? 1 : 0));
  return found.map(({ command, at }) => ({ command, at }));
}
