import { describe, expect, test } from "bun:test";

import {
  buildThreadTitlePrompt,
  cleanGeneratedTitle,
  TITLE_CONTEXT_MAX_LENGTH,
  TITLE_MAX_LENGTH,
} from "@/api/handlers/chat/thread-title-prompt";
import type { TitleContextMessage } from "@/api/handlers/chat/thread-title-prompt";

const textMessage = (
  role: TitleContextMessage["role"],
  content: string,
): TitleContextMessage => ({ role, parts: [{ type: "text", content }] });

describe("buildThreadTitlePrompt", () => {
  // The background generator produced exactly this prompt before the shared
  // extraction; pinning it keeps the two titling paths from drifting.
  test("renders the legacy two-message prompt byte-for-byte", () => {
    const prompt = buildThreadTitlePrompt([
      textMessage("user", "Draft an NDA for Acme"),
      textMessage("assistant", "Here is a draft NDA…"),
    ]);
    expect(prompt).toBe(
      `Given this conversation, reply with a short thread title (max 6 words). Reply with the title only, nothing else.

User: Draft an NDA for Acme
Assistant: Here is a draft NDA…`,
    );
  });

  test("collapses whitespace and caps each message's context", () => {
    const prompt = buildThreadTitlePrompt([
      textMessage("user", `  a\n\t b   c ${"x".repeat(2000)}`),
    ]);
    const line = prompt.split("\n").at(-1);
    expect(line?.startsWith("User: a b c x")).toBe(true);
    expect(line?.length).toBeLessThanOrEqual(
      "User: ".length + TITLE_CONTEXT_MAX_LENGTH,
    );
  });
});

describe("cleanGeneratedTitle", () => {
  // Invariants over the class of model-shaped outputs: a clean base title
  // wrapped in any combination of quotes, a "title:" prefix, and whitespace.
  // The bases deliberately contain no quote characters, so any quote at the
  // edges of the result could only have been retained wrapping.
  const bases = [
    "NDA review",
    "Employment contract questions",
    "K", // single char
    "Data processing agreement obligations under GDPR article twenty-eight", // > 60 chars
    "Título com acentuação e ç", // non-ASCII
  ];
  const decorators: ((base: string) => string)[] = [
    (b) => b,
    (b) => `"${b}"`,
    (b) => `'${b}'`,
    (b) => `""${b}""`,
    (b) => `'"${b}"'`,
    (b) => `Title: ${b}`,
    (b) => `title:${b}`,
    (b) => `TITLE:  ${b}`,
    (b) => `"Title: ${b}"`,
    (b) => `  "${b}"  `,
    (b) => `\n'Title: ${b}'\n`,
  ];

  for (const base of bases) {
    for (const [index, decorate] of decorators.entries()) {
      test(`strips wrapper ${String(index)} around ${JSON.stringify(base.slice(0, 20))}`, () => {
        const cleaned = cleanGeneratedTitle(decorate(base));
        expect(cleaned.length).toBeLessThanOrEqual(TITLE_MAX_LENGTH);
        expect(cleaned).not.toMatch(/^["']|["']$/u);
        expect(cleaned).not.toMatch(/^title:/iu);
        expect(cleaned).toBe(base.slice(0, TITLE_MAX_LENGTH));
      });
    }
  }

  test("returns empty for quote- or prefix-only output", () => {
    expect(cleanGeneratedTitle('""')).toBe("");
    expect(cleanGeneratedTitle("Title:")).toBe("");
    expect(cleanGeneratedTitle("  ")).toBe("");
  });
});
