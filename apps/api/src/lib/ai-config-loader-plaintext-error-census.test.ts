import { describe, expect, test } from "bun:test";

const caughtErrorCauseAttachments = (source: string) => {
  const attachments: string[] = [];
  const catchBindings = source.matchAll(
    /(?:catch\s*\(\s*|catch\s*:\s*\(\s*)([$A-Z_a-z][$\w]*)/gu,
  );
  for (const match of catchBindings) {
    const binding = match[1];
    if (!binding) {
      continue;
    }
    const followingClause = source.slice(match.index, match.index + 800);
    const causeAttachment = new RegExp(`cause\\s*:\\s*${binding}\\b`, "u");
    if (causeAttachment.test(followingClause)) {
      attachments.push(binding);
    }
  }
  return attachments;
};

describe("decrypted AI configuration error census", () => {
  test("rejects a fixture that retains a parser error as its cause", () => {
    const unsafeFixture = `
      Result.try({
        try: () => JSON.parse(plaintext),
        catch: (parserError) => new ConfigError({
          message: "invalid configuration",
          cause: parserError,
        }),
      });
    `;

    expect(caughtErrorCauseAttachments(unsafeFixture)).toEqual(["parserError"]);
  });

  test("AI configuration boundaries do not retain caught plaintext errors", async () => {
    const directory = new URL(".", import.meta.url);
    const files = Array.from(
      new Bun.Glob("ai-config-*.ts").scanSync({ cwd: directory.pathname }),
    ).filter((file) => !file.endsWith(".test.ts"));
    const violations: string[] = [];

    for (const file of files) {
      const source = await Bun.file(new URL(file, directory)).text();
      for (const binding of caughtErrorCauseAttachments(source)) {
        violations.push(`${file}: cause: ${binding}`);
      }
    }

    expect(violations).toEqual([]);
  });
});
