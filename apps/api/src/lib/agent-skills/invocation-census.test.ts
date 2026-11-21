import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Every module that reads the raw skill catalog must hand skills to a model
 * only through `offerSkillsToModel`, so a `manual` skill never reaches a
 * model the user did not invoke it for. The model-facing seams (skill tools,
 * requested skills, chat tools, MCP skill tools) take `ModelOfferedSkills`,
 * which only that function mints; this census covers the other side: a new
 * reader of the catalog is found here and must apply the rule.
 */
const API_SRC = path.join(import.meta.dir, "../..");

const readSource = (file: string) =>
  readFileSync(path.join(API_SRC, file), "utf-8");
const CATALOG_READER = "listAvailableChatSkillMetadata";
const OFFER = "offerSkillsToModel";

/** The catalog's own module, which defines the reader and offers nothing. */
const DEFINING_MODULE = "lib/agent-skills/skills.ts";

const catalogReaders = (): string[] => {
  const glob = new Bun.Glob("**/*.ts");
  return [...glob.scanSync({ cwd: API_SRC })]
    .filter((file) => !file.endsWith(".test.ts"))
    .filter((file) => file !== DEFINING_MODULE)
    .filter((file) => readSource(file).includes(CATALOG_READER))
    .toSorted();
};

const appliesInvocationRule = (source: string): boolean =>
  !source.includes(CATALOG_READER) || source.includes(OFFER);

describe("skill invocation census", () => {
  test("every reader of the skill catalog applies the invocation rule", () => {
    const readers = catalogReaders();
    // The enumeration must find the known readers, or it proves nothing.
    expect(readers).toEqual(
      expect.arrayContaining([
        "handlers/chat/chat-prompt.ts",
        "lib/docx/ai-skill-tools.ts",
        "mcp/gateway/skills.ts",
      ]),
    );
    const offenders = readers.filter(
      (file) => !appliesInvocationRule(readSource(file)),
    );
    expect(offenders).toEqual([]);
  });

  test("the rule check fails a reader that never offers", () => {
    expect(
      appliesInvocationRule(
        `const skills = await ${CATALOG_READER}(ctx); createSkillTools({ skills });`,
      ),
    ).toBe(false);
    expect(
      appliesInvocationRule(
        `const skills = ${OFFER}({ skills: await ${CATALOG_READER}(ctx) });`,
      ),
    ).toBe(true);
  });
});
