import { describe, expect, test } from "bun:test";

import { TOOL_ANNOTATIONS } from "./annotations.js";
import { generateCliSkill, SKILL_NAME } from "./generate-skill.js";
import type { RegistryToolListing } from "./route-types.js";

const snapshotUrl = new URL(
  "generated/registry-snapshot.json",
  import.meta.url,
);
const listings: readonly RegistryToolListing[] =
  await Bun.file(snapshotUrl).json();

describe("generateCliSkill (TanStack Intent)", () => {
  test("is deterministic across calls and input clones", () => {
    const once = generateCliSkill(listings, TOOL_ANNOTATIONS);
    const twice = generateCliSkill(listings, TOOL_ANNOTATIONS);
    const cloned = generateCliSkill(
      structuredClone(listings),
      TOOL_ANNOTATIONS,
    );
    expect(twice).toBe(once);
    expect(cloned).toBe(once);
  });

  test("emits frontmatter whose name matches the skill directory", () => {
    const skill = generateCliSkill(listings, TOOL_ANNOTATIONS);
    expect(skill.startsWith("---\n")).toBe(true);
    expect(skill).toContain(`name: ${SKILL_NAME}`);
    // Intent-specific fields live under `metadata`, not at the top level.
    expect(skill).toContain("metadata:");
    expect(skill).toContain('library: "@stll/cli"');
  });

  test("renders the exit-code table from the compiled EXIT_CODES", () => {
    const skill = generateCliSkill(listings, TOOL_ANNOTATIONS);
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
    const skill = generateCliSkill(listings, TOOL_ANNOTATIONS);
    // Annotated command path, its scope, and a windowed-text marker.
    expect(skill).toContain("`stella matter save`");
    expect(skill).toContain(
      "| case-law | `stella case-law read` | read | paginated; windowed text |",
    );
    // A discriminator subcommand marked destructive.
    expect(skill).toContain(
      "`stella organization remove-member` | admin_write | destructive (needs `--yes` off a TTY) |",
    );
    // Compat shims are excluded from the tree.
    expect(skill).not.toContain("`stella fetch`");
  });
});
