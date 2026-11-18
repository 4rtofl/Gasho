// The HTML in the bodies of GitHub's issues, pull requests and comments, shown as GitHub shows it: images pasted on
// GitHub (<img width=… src="https://github.com/user-attachments/…">), <details>, <br> and the like. rehype-raw turns
// the HTML into elements, so that Markdown inside a <details> is still Markdown; rehype-sanitize then keeps only the
// elements and attributes of GitHub's allowlist (its default schema), so scripts, event attributes and style go.
import type { Options } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";

const schema = {
  ...defaultSchema,
  // Other elements outside the list leave their text behind, as on GitHub; these hold code or styles, not words to read.
  strip: [...(defaultSchema.strip ?? []), "style", "iframe", "noscript", "noembed", "noframes", "xmp", "plaintext", "svg", "math"],
  // A <source srcset> in a <picture> would load images without webImageSrc; the <img> in it is shown instead.
  tagNames: defaultSchema.tagNames?.filter((name) => name !== "source"),
};

export const GITHUB_HTML: NonNullable<Options["rehypePlugins"]> = [rehypeRaw, [rehypeSanitize, schema]];

/**
 * The address of an image to show, when it is on the web (http or https). A relative one would load from Gasho's own
 * server, and other schemes are not images to load.
 */
export function webImageSrc(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.username || url.password) return undefined;
  return url.href;
}
