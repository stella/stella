import { describe, expect, test } from "bun:test";

import {
  cleanCaseFailures,
  rewriteFixture,
  ruleCoverageFailures,
} from "./check-oxlint-fixture-counts.ts";

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

  test("records clean cases only when the marker starts the line", () => {
    const { clean } = rewriteFixture(
      FILE,
      `// expect-clean: ${RULE}\nf();\nvalue ? // expect-clean: ${RULE}\ng() : h();`,
    );
    expect(clean).toEqual(new Set([`${FILE}:2:${RULE}`]));
  });
});

describe("ruleCoverageFailures", () => {
  const cleanKey = `${FILE}:4:${RULE}`;

  test("passes a rule that reports and has a clean case", () => {
    expect(
      ruleCoverageFailures({
        clean: new Set([cleanKey]),
        registeredRuleIds: new Set([RULE]),
        reportedRules: new Set([RULE]),
      }),
    ).toEqual([]);
  });

  test("fails a registered rule with no executed diagnostic", () => {
    expect(
      ruleCoverageFailures({
        clean: new Set([cleanKey]),
        registeredRuleIds: new Set([RULE]),
        reportedRules: new Set(),
      }),
    ).toEqual([`${RULE}: no diagnostic in executed fixture lint`]);
  });

  test("fails a registered rule with no clean case", () => {
    expect(
      ruleCoverageFailures({
        clean: new Set(),
        registeredRuleIds: new Set([RULE]),
        reportedRules: new Set([RULE]),
      }),
    ).toEqual([`${RULE}: no expect-clean case verified by fixture lint`]);
  });
});

describe("cleanCaseFailures", () => {
  const cleanKey = `${FILE}:4:${RULE}`;

  test("fails a clean line that draws a diagnostic", () => {
    expect(
      cleanCaseFailures({
        actual: new Map([[cleanKey, 1]]),
        clean: new Set([cleanKey]),
      }),
    ).toEqual([`${cleanKey}: expected clean, got 1 hit(s)`]);
  });

  test("passes a clean line with no diagnostic", () => {
    expect(
      cleanCaseFailures({ actual: new Map(), clean: new Set([cleanKey]) }),
    ).toEqual([]);
  });
});
