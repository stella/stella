/**
 * The one owner of text the server sends to GitHub on behalf of someone else.
 *
 * The server writes to GitHub under a maintainer token, so any text a user
 * wrote must reach GitHub inert: it must not mention an account, reference or
 * cross-link an issue or pull request, or change the structure of the
 * surrounding markdown (headings, HTML comments, `<details>`, links, entities).
 * The one GitHub write helper (`github-write.ts`) accepts only the branded
 * values below, so a plain string does not type-check, and
 * `outbound-text.guard.test.ts` fails any other module that writes to GitHub.
 *
 * Markdown bodies wrap user text in code, not in escapes. GitHub resolves
 * mentions and references on the rendered text, after HTML entities are
 * decoded, so `&#64;name` is a mention just like `@name`; an escaping scheme
 * has to anticipate every such spelling, while code is inert by construction:
 * no entity decoding, no HTML, no autolinks, no mentions, no references. It is
 * total and the reader sees the exact text the user wrote.
 *
 *   - `toGithubUserText`: multi-line text as a fenced code block whose fence is
 *     one backtick longer than the longest backtick run inside, so no line of
 *     the text can close it.
 *   - `toGithubUserInline`: one-line text as a code span, line breaks folded
 *     into spaces, delimited the same way and padded so the padding is the only
 *     thing CommonMark strips.
 *   - `toGithubUserTitle`: issue titles are plain text, where code would show
 *     its backticks, so a zero-width space follows each sigil that could start
 *     a mention (`@`), a reference (`#`, `GH-`) or an entity (`&`); the result
 *     is then held to GitHub's title length limit.
 *
 * Markdown the code itself authors is built with the `githubMarkdown` tag, so
 * every literal part comes from source code and every interpolation is already
 * one of the safe values above.
 */

const GITHUB_SAFE_TEXT: unique symbol = Symbol("githubSafeText");
const GITHUB_SAFE_TITLE: unique symbol = Symbol("githubSafeTitle");

/** A markdown fragment that is safe to send in a GitHub body. */
export type GithubSafeText = {
  readonly [GITHUB_SAFE_TEXT]: true;
  readonly markdown: string;
};

/** A plain-text issue or pull request title that is safe to send to GitHub. */
export type GithubSafeTitle = {
  readonly [GITHUB_SAFE_TITLE]: true;
  readonly text: string;
};

const safeText = (markdown: string): GithubSafeText => ({
  [GITHUB_SAFE_TEXT]: true,
  markdown,
});

const ZERO_WIDTH_SPACE = "\u200B";
const LINE_BREAK = /\r\n|\r|\n/gu;
const BACKTICK_RUN = /`+/gu;
const MIN_FENCE_LENGTH = 3;

const longestBacktickRun = (text: string): number =>
  Math.max(
    0,
    ...Array.from(text.matchAll(BACKTICK_RUN), ([run]) => run.length),
  );

/**
 * User text as a fenced code block; any text, any length, renders verbatim.
 * Line endings become `\n` first: a trailing `\r` would otherwise pair with
 * the line break before the closing fence and drop the text's last line.
 */
export const toGithubUserText = (text: string): GithubSafeText => {
  const lines = text.replaceAll(LINE_BREAK, "\n");
  const fence = "`".repeat(
    Math.max(MIN_FENCE_LENGTH, longestBacktickRun(lines) + 1),
  );
  return safeText(`${fence}text\n${lines}\n${fence}`);
};

/** One-line user text as a code span; line breaks become spaces. */
export const toGithubUserInline = (text: string): GithubSafeText => {
  const line = text.replaceAll(LINE_BREAK, " ");
  const delimiter = "`".repeat(longestBacktickRun(line) + 1);
  return safeText(`${delimiter} ${line} ${delimiter}`);
};

/** GitHub refuses an issue or pull request title longer than this. */
export const GITHUB_TITLE_MAX_LENGTH = 256;
const TITLE_ELLIPSIS = "\u2026";

/** Folds line breaks and breaks every live sigil with a zero-width space. */
const neutralizeTitle = (text: string): string =>
  text
    .replaceAll(LINE_BREAK, " ")
    .replaceAll(
      /[@#](?=[^\s\u200B])/gu,
      (sigil) => `${sigil}${ZERO_WIDTH_SPACE}`,
    )
    .replaceAll(/&(?=[#A-Za-z0-9])/gu, (sigil) => `${sigil}${ZERO_WIDTH_SPACE}`)
    .replaceAll(
      /(gh)(?=-[0-9])/giu,
      (prefix) => `${prefix}${ZERO_WIDTH_SPACE}`,
    );

/**
 * The longest prefix of `text`, cut between code points and followed by an
 * ellipsis, whose neutralized form fits the limit. The prefix is cut before
 * neutralizing, so a sigil and its zero-width space are never separated and a
 * sigil the cut leaves before the ellipsis is broken like any other. The
 * neutralized length only grows with the prefix, so a binary search finds it.
 */
const truncateTitle = (text: string): string => {
  const codePoints = Array.from(text);
  const fits = (count: number): boolean =>
    neutralizeTitle(`${codePoints.slice(0, count).join("")}${TITLE_ELLIPSIS}`)
      .length <= GITHUB_TITLE_MAX_LENGTH;
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return neutralizeTitle(
    `${codePoints.slice(0, low).join("")}${TITLE_ELLIPSIS}`,
  );
};

/**
 * A title with every live sigil broken by a zero-width space, at most
 * `GITHUB_TITLE_MAX_LENGTH` UTF-16 code units long (never more code points
 * than that either). The limit applies after the zero-width spaces are added;
 * a longer title is cut between code points and ends with an ellipsis.
 * Idempotent; when nothing is cut, removing the zero-width spaces gives back
 * the text (line breaks folded).
 */
export const toGithubUserTitle = (text: string): GithubSafeTitle => {
  const neutral = neutralizeTitle(text);
  return {
    [GITHUB_SAFE_TITLE]: true,
    text:
      neutral.length <= GITHUB_TITLE_MAX_LENGTH ? neutral : truncateTitle(text),
  };
};

/**
 * Markdown authored by the code: the literal parts come from source, and each
 * interpolation must already be safe. Use only as a template tag.
 */
export const githubMarkdown = (
  literals: TemplateStringsArray,
  ...values: readonly GithubSafeText[]
): GithubSafeText => {
  let markdown = literals[0] ?? "";
  for (const [index, value] of values.entries()) {
    markdown += `${value.markdown}${literals[index + 1] ?? ""}`;
  }
  return safeText(markdown);
};

/** Safe fragments as consecutive lines. */
export const joinGithubMarkdownLines = (
  lines: readonly GithubSafeText[],
): GithubSafeText => safeText(lines.map((line) => line.markdown).join("\n"));
