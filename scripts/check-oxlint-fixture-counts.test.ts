import { describe, expect, test } from "bun:test";

import { rewriteFixture } from "./check-oxlint-fixture-counts.ts";

const FILE = ".oxlint-plugins/__fixtures__/example.fixture.ts";
const RULE = "no-bare-error/no-bare-error";

describe("rewriteFixture", () => {
  test("expects one hit on the line after a next-line directive", () => {
    const { source, expected } = rewriteFixture(
      FILE,
      `// oxlint-disable-next-line ${RULE}\nthrow new Error("x");`,
    );
    expect(expected).toEqual(new Map([[`${FILE}:2:${RULE}`, 1]]));
    expect(source).not.toContain("oxlint-disable");
    expect(source.split("\n")).toHaveLength(2);
  });

  test("reads an xN count from the rationale", () => {
    const { expected } = rewriteFixture(
      FILE,
      `// oxlint-disable-next-line ${RULE} -- x3: three forms\nf();`,
    );
    expect(expected.get(`${FILE}:2:${RULE}`)).toBe(3);
  });

  test("expects the hit on the directive's own line for disable-line", () => {
    const { expected } = rewriteFixture(
      FILE,
      `\nthrow Error("x"); // oxlint-disable-line ${RULE}`,
    );
    expect(expected).toEqual(new Map([[`${FILE}:2:${RULE}`, 1]]));
  });

  test("reads the eslint spelling of a directive", () => {
    const { expected } = rewriteFixture(
      FILE,
      `// eslint-disable-next-line ${RULE}\nf();`,
    );
    expect(expected).toEqual(new Map([[`${FILE}:2:${RULE}`, 1]]));
  });

  test("keeps suppressions of rules outside the local plugins", () => {
    const { source, expected } = rewriteFixture(
      FILE,
      `// oxlint-disable-next-line ${RULE}, no-console -- reason\nf();`,
    );
    expect(expected.size).toBe(1);
    expect(source).toContain(
      "// oxlint-disable-next-line no-console -- reason",
    );
    expect(source).not.toContain(RULE);
  });

  test("rejects a clean marker that does not precede code", () => {
    const { problems } = rewriteFixture(
      FILE,
      `// expect-clean: ${RULE}\n\nf();`,
    );
    expect(problems).toEqual([`${FILE}:1: expect-clean must precede code`]);
  });
});
