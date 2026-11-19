import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { parseSkillFile } from "@stll/skills/frontmatter";

import { renderSkillFile, skillFileName } from "./skill-file";
import type { StoredSkillFile } from "./skill-file";

const stored = (overrides: Partial<StoredSkillFile> = {}): StoredSkillFile => ({
  body: "# Review\n\nRead `references/checklist.md`.",
  compatibility: null,
  description: "Reviews a contract.",
  invocation: "auto",
  license: null,
  metadata: {},
  name: "contract-review",
  version: null,
  ...overrides,
});

describe("renderSkillFile", () => {
  test("writes a SKILL.md every Agent Skills host reads", () => {
    expect(renderSkillFile(stored())).toBe(
      [
        "---",
        'name: "contract-review"',
        'description: "Reviews a contract."',
        "---",
        "",
        "# Review",
        "",
        "Read `references/checklist.md`.",
        "",
      ].join("\n"),
    );
  });

  test("writes a manual skill the way other hosts spell it", () => {
    const parsed = parseSkillFile(
      renderSkillFile(stored({ invocation: "manual" })),
    );
    expect(parsed.isOk() && parsed.value.metadata.invocation).toBe("manual");
    expect(renderSkillFile(stored({ invocation: "manual" }))).toContain(
      "disable-model-invocation: true",
    );
  });

  test("names a display-named skill by its slugified name", () => {
    expect(skillFileName("Contract review (CZ)")).toBe("contract-review-cz");
    expect(skillFileName("contract-review")).toBe("contract-review");
  });

  test("reads back to the columns it was written from", () => {
    const text = fc.string({ maxLength: 40 });
    const nonBlank = text.filter((value) => value.trim().length > 0);
    assertProperty(
      "reads back to the columns it was written from",
      fc.property(
        fc.record({
          body: text.map((value) => value.trim()),
          compatibility: fc.option(text, { nil: null }),
          description: nonBlank,
          invocation: fc.constantFrom("auto", "manual"),
          license: fc.option(text, { nil: null }),
          // The invocation has its own column, and a `license` or `version`
          // metadata entry is read as the column when the frontmatter has none.
          metadata: fc.dictionary(
            nonBlank.filter(
              (key) =>
                !["license", "stella-invocation", "version"].includes(key),
            ),
            text,
            { maxKeys: 4 },
          ),
          version: fc.option(text, { nil: null }),
        }),
        (columns) => {
          const parsed = parseSkillFile(
            renderSkillFile({ ...columns, name: "contract-review" }),
          );
          expect(parsed.isOk()).toBe(true);
          if (parsed.isErr()) {
            return;
          }
          expect(parsed.value.body).toBe(columns.body);
          expect(parsed.value.metadata).toEqual({
            compatibility: columns.compatibility,
            description: columns.description,
            invocation: columns.invocation,
            license: columns.license,
            metadata: columns.metadata,
            name: "contract-review",
            version: columns.version,
          });
        },
      ),
    );
  });
});
