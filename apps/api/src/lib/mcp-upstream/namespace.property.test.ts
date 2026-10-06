import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { validateFetchedToolsList } from "@stll/cli/registry-trust";
import { propertyConfig } from "@stll/property-testing";
import { listSkillMetadata } from "@stll/skills";

import { DEFAULT_SKILL_BODY_BY_SLUG } from "@/api/lib/agent-skills/default-skills";
import {
  collisionSafeToolName,
  namespaceMcpToolName,
  namespaceSkillToolName,
  TOOL_NAME_MAX_LENGTH,
  TOOL_NAME_PATTERN,
} from "@/api/lib/mcp-upstream/namespace";

/**
 * Every dynamic tool name is derived here, and a client that meets one name
 * outside the contract rejects the whole listing. So the property is over
 * the whole input class: any slug the skill schema admits, any upstream
 * tool name, and any set of them exposed together.
 */

// The skill slug schema: lowercase words joined by hyphens, at most 64 chars.
const slugArbitrary = fc
  .array(fc.stringMatching(/^[a-z0-9]{1,12}$/u), { minLength: 1, maxLength: 8 })
  .map((words) => words.join("-").slice(0, 64).replace(/-+$/u, ""))
  .filter((slug) => slug.length > 0);

// Upstream MCP servers name tools freely; the gateway bounds only length.
const upstreamNameArbitrary = fc.string({ minLength: 1, maxLength: 128 });

/** A `tools/list` body the CLI's own trust check reads. */
const listingOf = (names: readonly string[]) =>
  JSON.stringify({
    tools: names.map((name) => ({
      name,
      description: "",
      inputSchema: { type: "object", properties: {} },
    })),
  });

const exposeAll = (
  sources: readonly { baseName: string; rawName: string }[],
): string[] => {
  const seen = new Set<string>();
  return sources.map(({ baseName, rawName }) =>
    collisionSafeToolName({ baseName, rawName, seen }),
  );
};

describe("exposed tool names", () => {
  test("every seeded and shipped skill is exposed inside the contract", () => {
    const slugs = [
      ...DEFAULT_SKILL_BODY_BY_SLUG.keys(),
      ...listSkillMetadata().map(({ name }) => name),
    ];
    expect(slugs.length).toBeGreaterThan(0);
    const names = exposeAll(
      slugs.map((slug) => ({
        baseName: namespaceSkillToolName(slug),
        rawName: slug,
      })),
    );

    for (const name of names) {
      expect(name).toMatch(TOOL_NAME_PATTERN);
    }
    expect(validateFetchedToolsList(listingOf(names))).toMatchObject({
      ok: true,
    });
  });

  test("any skill slug yields a name the CLI accepts", () => {
    fc.assert(
      fc.property(slugArbitrary, (slug) => {
        const name = namespaceSkillToolName(slug);
        expect(name).toMatch(TOOL_NAME_PATTERN);
        expect(name.length).toBeLessThanOrEqual(TOOL_NAME_MAX_LENGTH);
      }),
      propertyConfig(),
    );
  });

  test("any upstream tool yields a name the CLI accepts", () => {
    fc.assert(
      fc.property(
        upstreamNameArbitrary,
        upstreamNameArbitrary,
        (connectorSlug, toolName) => {
          expect(namespaceMcpToolName({ connectorSlug, toolName })).toMatch(
            TOOL_NAME_PATTERN,
          );
        },
      ),
      propertyConfig(),
    );
  });

  test("names exposed together stay unique and inside the contract", () => {
    fc.assert(
      fc.property(
        fc.array(slugArbitrary, { minLength: 1, maxLength: 40 }),
        fc.boolean(),
        (slugs, hashFirst) => {
          const seen = new Set<string>();
          const names = slugs.map((slug) =>
            collisionSafeToolName({
              baseName: namespaceSkillToolName(slug),
              hashFirst,
              rawName: slug,
              seen,
            }),
          );
          expect(new Set(names).size).toBe(names.length);
          expect(validateFetchedToolsList(listingOf(names))).toMatchObject({
            ok: true,
          });
        },
      ),
      propertyConfig(),
    );
  });

  test("repeated collisions on one long name stay unique and inside the contract", () => {
    const baseName = namespaceSkillToolName(`${"b".repeat(70)}-report`);
    const seen = new Set<string>();
    const names = Array.from({ length: 5 }, () =>
      collisionSafeToolName({ baseName, rawName: "report", seen }),
    );
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(TOOL_NAME_PATTERN);
    }
  });

  test("long slugs sharing a prefix keep distinct names", () => {
    const prefix = "a".repeat(60);
    const first = namespaceSkillToolName(`${prefix}-one`);
    const second = namespaceSkillToolName(`${prefix}-two`);
    expect(first).not.toBe(second);
    expect(first.length).toBe(TOOL_NAME_MAX_LENGTH);
    expect(second.length).toBe(TOOL_NAME_MAX_LENGTH);
  });

  test("a hyphenated default skill maps to underscores", () => {
    expect(namespaceSkillToolName("compare-default")).toBe(
      "skill__compare_default",
    );
  });
});
