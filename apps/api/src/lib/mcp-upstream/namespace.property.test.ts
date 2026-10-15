import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  MCP_TOOL_NAME_MAX_LENGTH,
  MCP_TOOL_NAME_PATTERN,
} from "@stll/api-contract/mcp-tool-name";
import { propertyConfig } from "@stll/property-testing";
import { listSkillMetadata } from "@stll/skills";

import { SKILL_SLUG_MAX_LENGTH } from "@/api/handlers/skills/slug";
import { DEFAULT_SKILL_BODY_BY_SLUG } from "@/api/lib/agent-skills/default-skills";
import {
  collisionSafeToolName,
  namespaceMcpToolName,
  namespaceSkillToolName,
} from "@/api/lib/mcp-upstream/namespace";

import { validateFetchedToolsList } from "../../../../../packages/cli/src/registry-trust";

/**
 * Every dynamic tool name is derived here, and a client that meets one name
 * outside the contract rejects the whole listing. So the property is over
 * the whole input class: any slug the skill schema admits, any upstream
 * tool name, and any set of them exposed together.
 */

// The skill slug schema: lowercase words joined by hyphens, at most 64 chars.
const slugArbitrary = fc
  .array(fc.stringMatching(/^[a-z0-9]{1,12}$/u), { minLength: 1, maxLength: 8 })
  .map((words) =>
    words.join("-").slice(0, SKILL_SLUG_MAX_LENGTH).replace(/-+$/u, ""),
  )
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
      expect(name).toMatch(MCP_TOOL_NAME_PATTERN);
    }
    expect(validateFetchedToolsList(listingOf(names))).toMatchObject({
      ok: true,
    });
  });

  test("any skill slug yields a name the CLI accepts", () => {
    fc.assert(
      fc.property(slugArbitrary, (slug) => {
        const name = namespaceSkillToolName(slug);
        expect(name).toMatch(MCP_TOOL_NAME_PATTERN);
        expect(name.length).toBeLessThanOrEqual(MCP_TOOL_NAME_MAX_LENGTH);
        expect(validateFetchedToolsList(listingOf([name]))).toMatchObject({
          ok: true,
        });
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
          const name = namespaceMcpToolName({ connectorSlug, toolName });
          expect(name).toMatch(MCP_TOOL_NAME_PATTERN);
          expect(name.length).toBeLessThanOrEqual(MCP_TOOL_NAME_MAX_LENGTH);
          expect(validateFetchedToolsList(listingOf([name]))).toMatchObject({
            ok: true,
          });
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
      expect(name).toMatch(MCP_TOOL_NAME_PATTERN);
    }
  });

  test("long slugs sharing a prefix keep distinct names", () => {
    const prefix = "a".repeat(MCP_TOOL_NAME_MAX_LENGTH);
    const first = namespaceSkillToolName(`${prefix}-one`);
    const second = namespaceSkillToolName(`${prefix}-two`);
    expect(first).not.toBe(second);
    // Published CLI clients still bound emitted names to 64 characters.
    expect(first.length).toBe(64);
    expect(second.length).toBe(64);
  });

  test("a hyphenated default skill maps to underscores", () => {
    expect(namespaceSkillToolName("compare-default")).toBe(
      "skill__compare_default",
    );
  });
});
