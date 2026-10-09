import { describe, expect, test } from "bun:test";

import { readCapabilityCatalog } from "./capability-catalog-data.js";
import { parseCapabilityCatalog } from "./capability-catalog-load.js";
import {
  CAPABILITY_NAMESPACE,
  capabilityDomainsOf,
  insertCapabilities,
} from "./generate-capability-tree.js";
import { generateRouteMap } from "./generate-route-map.js";
import { generateCliSkill, SKILL_NAME } from "./generate-skill.js";
import { generatedToolAnnotations as TOOL_ANNOTATIONS } from "./generated/tool-annotations.js";
import {
  buildCompactInputUnionHints,
  buildInputContractHelp,
} from "./input-contract-help.js";
import { validateAgainstSchema } from "./json-schema-validate.js";
import type { RegistryToolListing } from "./route-types.js";

const snapshotUrl = new URL(
  "generated/registry-snapshot.json",
  import.meta.url,
);
const listings: readonly RegistryToolListing[] =
  await Bun.file(snapshotUrl).json();

// The real committed catalog, merged onto the real curated tree exactly the
// way `codegen.ts` does. Worked capability examples in the generated skill
// (see generate-skill.ts) resolve a real leaf out of this tree, so the test
// input has to carry one instead of a hand-trimmed stand-in.
const catalog = parseCapabilityCatalog(readCapabilityCatalog());
if (catalog === null) {
  throw new TypeError("Invalid capability catalog");
}
const { tree: mergedTree, stats: capabilityStats } = insertCapabilities({
  tree: generateRouteMap(listings, TOOL_ANNOTATIONS),
  entries: catalog,
});

const CAPABILITY = {
  commandCount: capabilityStats.generated,
  domains: capabilityDomainsOf(mergedTree),
  tree: mergedTree,
};

describe("generateCliSkill (TanStack Intent)", () => {
  for (const keyword of ["oneOf", "anyOf"] as const) {
    for (const withFlags of [true, false]) {
      test(`describes ${keyword} input variants ${withFlags ? "with" : "without"} flags`, () => {
        const subject = {
          [keyword]: [
            {
              type: "object",
              required: ["kind", "identifier", "country"],
              properties: {
                kind: { const: "company" },
                identifier: { type: "string", minLength: 1 },
                country: { type: "string", enum: ["CZ", "SK"] },
              },
            },
            {
              type: "object",
              required: ["kind", "first_name", "last_name", "birth_date"],
              properties: {
                kind: { type: "string", enum: ["person"] },
                first_name: { type: "string" },
                last_name: { type: "string" },
                birth_date: {
                  type: "object",
                  required: ["year"],
                  properties: { year: { type: "integer" } },
                },
              },
            },
          ],
        };
        const skill = generateCliSkill(
          [
            {
              name: "inspect_subject",
              description: "Inspect a subject",
              inputSchema: {
                type: "object",
                required: ["subject"],
                properties: withFlags
                  ? { subject, query: { type: "string" } }
                  : { subject },
              },
            },
          ],
          TOOL_ANNOTATIONS,
          CAPABILITY,
        );
        expect(skill).toContain(
          'kind="company": identifier:string, country:"CZ" | "SK"',
        );
        expect(skill).toContain(
          'kind="person": first_name:string, last_name:string, birth_date:{year}',
        );
        const json = /Example: `--input '([^']+)'`/u.exec(skill)?.at(1);
        expect(json).toBeDefined();
        const input: unknown = JSON.parse(json ?? "null");
        expect(input).toEqual({
          subject: {
            kind: "company",
            identifier: expect.any(String),
            country: "CZ",
          },
        });
        expect(
          validateAgainstSchema(
            {
              type: "object",
              required: ["subject"],
              properties: { subject },
            },
            input,
          ).valid,
        ).toBe(true);
      });
    }
  }

  test("preserves the input-only hint for a plain object", () => {
    const skill = generateCliSkill(
      [
        {
          name: "inspect_subject",
          description: "Inspect a subject",
          inputSchema: {
            type: "object",
            properties: {
              subject: {
                type: "object",
                required: ["name"],
                properties: {
                  name: {
                    type: "object",
                    properties: { value: { type: "string" } },
                  },
                },
              },
            },
          },
        },
      ],
      {
        ...TOOL_ANNOTATIONS,
        inspect_subject: {
          command: ["inspect", "subject"],
          inputOnly: ["subject"],
        },
      },
      CAPABILITY,
    );
    expect(skill).toContain(
      "- `stella inspect subject` — no flags; pass `--input` with subject\n\n",
    );
    expect(skill).not.toContain("subject: variant");
    expect(skill).not.toContain("Example: `--input");
  });

  test("describes the real registry unions and skips free-form metadata", () => {
    const skill = generateCliSkill(listings, TOOL_ANNOTATIONS, CAPABILITY);
    expect(skill).toContain(
      'subject: type="company-id": company_id:string; type="tax-id": tax_id:string; type="person": first_name:string, last_name:string, date_of_birth?:{precision="year"|"month"|"day"}, nationality_codes?:string[]; type="organization": name:string',
    );
    expect(skill).toContain(
      'date_of_birth: precision="year": year:integer; precision="month": year:integer, month:integer; precision="day": year:integer, month:integer, day:integer',
    );
    expect(skill).not.toContain("  - metadata:");
    expect(skill).toContain(
      'positions[]: mode="extract": issue:string, sources?:string[], ask:{question}',
    );
    expect(skill).toContain('type="multi-select": value:string[]');
  });

  test("unwraps nullable unions and describes optional structures one level down", () => {
    const dates = {
      anyOf: ["year", "month", "day"].map((precision) => ({
        type: "object",
        required: ["precision", "year"],
        properties: {
          precision: { enum: [precision] },
          year: { type: "integer" },
        },
      })),
    };
    const subject = {
      anyOf: [
        {
          anyOf: [
            {
              type: "object",
              required: ["type", "name"],
              properties: {
                type: { const: "person" },
                name: { type: "string" },
                date_of_birth: dates,
                nationality_codes: { type: "array", items: { type: "string" } },
              },
            },
            {
              type: "object",
              required: ["type", "id"],
              properties: {
                type: { const: "company" },
                id: { type: "integer" },
              },
            },
          ],
        },
        { type: "null" },
      ],
    };
    const hints = buildCompactInputUnionHints({
      schema: { type: "object", properties: { subject } },
      inputOnly: ["subject"],
    });
    expect(hints.at(0)?.variants).toContain(
      'date_of_birth?:{precision="year"|"month"|"day"}',
    );
    expect(hints.at(0)?.variants).toContain("nationality_codes?:string[]");
    expect(hints.at(0)?.variants).not.toContain("variant ");
    expect(
      buildInputContractHelp({
        schema: { type: "object", properties: { subject } },
        inputOnly: ["subject"],
      })?.fields.join("\n"),
    ).toContain('precision = "year"');
  });

  test("skips undiscriminated unions", () => {
    expect(
      buildCompactInputUnionHints({
        schema: {
          properties: {
            value: { anyOf: [{ type: "string" }, { type: "integer" }] },
          },
        },
        inputOnly: ["value"],
      }),
    ).toEqual([]);
  });

  test("finds array item unions through allOf and wraps their examples at a nested path", () => {
    const field = {
      type: "array",
      items: {
        required: ["shared"],
        properties: { shared: { type: "boolean" } },
        allOf: [
          {
            anyOf: [
              {
                type: "object",
                required: ["kind", "value"],
                properties: {
                  kind: { const: "text" },
                  value: { type: "string" },
                },
              },
              {
                type: "object",
                required: ["kind", "value"],
                properties: {
                  kind: { const: "number" },
                  value: { type: "integer" },
                },
              },
            ],
          },
        ],
      },
    };
    const schema = {
      type: "object",
      properties: { body: { type: "object", properties: { entries: field } } },
    };
    const hint = buildCompactInputUnionHints({
      schema,
      inputOnly: ["body.entries"],
    }).at(0);
    expect(hint?.path).toBe("body.entries[]");
    expect(hint?.variants).toBe(
      'kind="text": shared:boolean, value:string; kind="number": shared:boolean, value:integer',
    );
    expect(hint?.example).toEqual({
      status: "complete",
      value: {
        body: {
          entries: [{ shared: false, kind: "text", value: expect.any(String) }],
        },
      },
    });
  });

  test("tries later examples and keeps hints when every example is unavailable", () => {
    const branch = (kind: string, pattern: string) => ({
      type: "object",
      required: ["kind", "value"],
      properties: { kind: { const: kind }, value: { type: "string", pattern } },
    });
    const hintFor = (secondPattern: string) =>
      buildCompactInputUnionHints({
        schema: {
          properties: {
            subject: {
              oneOf: [branch("first", "(?!)"), branch("second", secondPattern)],
            },
          },
        },
        inputOnly: ["subject"],
      }).at(0);
    expect(hintFor("^ok$")?.example).toEqual({
      status: "complete",
      value: { subject: { kind: "second", value: "ok" } },
    });
    expect(hintFor("(?!)")?.example).toEqual({ status: "unavailable" });
    expect(hintFor("(?!)")?.variants).toContain('kind="first": value:string');
  });

  test("is deterministic across calls and input clones", () => {
    const once = generateCliSkill(listings, TOOL_ANNOTATIONS, CAPABILITY);
    const twice = generateCliSkill(listings, TOOL_ANNOTATIONS, CAPABILITY);
    const cloned = generateCliSkill(
      structuredClone(listings),
      TOOL_ANNOTATIONS,
      CAPABILITY,
    );
    expect(twice).toBe(once);
    expect(cloned).toBe(once);
  });

  test("emits frontmatter whose name matches the skill directory", () => {
    const skill = generateCliSkill(listings, TOOL_ANNOTATIONS, CAPABILITY);
    expect(skill.startsWith("---\n")).toBe(true);
    expect(skill).toContain(`name: ${SKILL_NAME}`);
    // Intent-specific fields live under `metadata`, not at the top level.
    expect(skill).toContain("metadata:");
    expect(skill).toContain('library: "@stll/cli"');
  });

  test("documents the capability tree (count + discovery + dry-run)", () => {
    const skill = generateCliSkill(listings, TOOL_ANNOTATIONS, CAPABILITY);
    expect(skill).toContain("## Capability commands (full surface)");
    expect(skill).toContain(
      `generates ${CAPABILITY.commandCount}\ncapability commands`,
    );
    expect(skill).toContain("stella capability list");
    expect(skill).toContain("stella capability describe --capability <id>");
    expect(skill).toContain("stella capability read --capability <id>");
    expect(skill).toContain("stella capability write --capability <id>");
    expect(skill).toContain(`stella ${CAPABILITY_NAMESPACE} <domain> <action>`);
    expect(skill).not.toContain("a colliding capability drops under");
    expect(skill).toContain("--dry-run");
  });

  test("renders the exit-code table from the compiled EXIT_CODES", () => {
    const skill = generateCliSkill(listings, TOOL_ANNOTATIONS, CAPABILITY);
    expect(skill).toContain("| 0 | success |");
    expect(skill).toContain(
      "| 3 | authentication required or failed (run `stella auth login`) |",
    );
    expect(skill).toContain("| 5 | feature disabled for this organization |");
    expect(skill).toContain(
      "| 7 | confirmation aborted (a destructive op was declined) |",
    );
  });

  test("derives the command tree from the registry (sentinel command paths)", () => {
    const skill = generateCliSkill(listings, TOOL_ANNOTATIONS, CAPABILITY);
    // Annotated command path, its scope, and a windowed-text marker.
    expect(skill).toContain("`stella matter save`");
    expect(skill).toContain(
      "| document | `stella document content` | read | paginated; windowed text |",
    );
    // A discriminator subcommand marked destructive.
    expect(skill).toContain(
      "`stella organization remove-member` | admin_write | destructive (needs `--yes` off a TTY) |",
    );
    expect(skill).toContain(
      "`stella template save-filled new-document` | documents_write + templates |",
    );
    // Compat shims are excluded from the tree.
    expect(skill).not.toContain("`stella fetch`");
  });

  test("names the input-only fields of a command that also takes flags", () => {
    const skill = generateCliSkill(listings, TOOL_ANNOTATIONS, CAPABILITY);
    const block = skill.slice(
      skill.indexOf("- `stella contact check-counterparty`"),
      skill.indexOf("- `stella contact delete`"),
    );
    expect(block).toContain("`--check`");
    expect(block).toContain("  - via `--input` only: subject");
  });
});
