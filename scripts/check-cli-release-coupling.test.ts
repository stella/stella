import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import path from "node:path";

import { propertyConfig } from "@stll/property-testing";

import {
  canonicalJson,
  changesetNamesCli,
  classifyCliRelease,
  CLI_CONTRACT_SURFACE,
  compareStableVersions,
  findSurfaceDrift,
  parseGeneratedConstants,
  verdictFromClassification,
  type CliContractSurface,
  type PublishedCli,
} from "./check-cli-release-coupling";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT = "scripts/check-cli-release-coupling.ts";

const published: PublishedCli = {
  latest: "0.10.1",
  versions: ["0.9.0", "0.10.0", "0.10.1"],
};

const classify = (
  cliVersion: string,
  pendingCliChangesets: readonly string[] = [],
  version = "0.9.5",
) =>
  classifyCliRelease({ version, cliVersion, pendingCliChangesets, published });

const stableVersion = fc
  .tuple(fc.nat({ max: 20 }), fc.nat({ max: 20 }), fc.nat({ max: 20 }))
  .map((parts) => parts.join("."));

describe("changesetNamesCli", () => {
  test("reads the package keys of the frontmatter only", () => {
    expect(
      changesetNamesCli('---\n"@stll/cli": major\n---\n\nSummary.\n'),
    ).toBe(true);
    expect(changesetNamesCli("---\n@stll/cli: patch\n---\n\nSummary.\n")).toBe(
      true,
    );
    expect(
      changesetNamesCli(
        '---\n"@stll/ui": minor\n"@stll/cli": minor\n---\n\nSummary.\n',
      ),
    ).toBe(true);
    expect(
      changesetNamesCli(
        '---\n"@stll/ssr-kit": minor\n---\n\nMentions @stll/cli.\n',
      ),
    ).toBe(false);
    expect(changesetNamesCli("---\n---\n\nEmpty changeset.\n")).toBe(false);
    expect(changesetNamesCli("No frontmatter at all.\n")).toBe(false);
  });
});

describe("compareStableVersions", () => {
  test("orders numerically per segment", () => {
    expect(compareStableVersions("0.10.1", "0.9.9")).toBeGreaterThan(0);
    expect(compareStableVersions("1.0.0", "0.10.1")).toBeGreaterThan(0);
    expect(compareStableVersions("0.10.1", "0.10.1")).toBe(0);
    expect(compareStableVersions("0.10.0", "0.10.1")).toBeLessThan(0);
  });

  test("refuses anything but major.minor.patch", () => {
    expect(() => compareStableVersions("1.0.0-rc.1", "1.0.0")).toThrow(
      "not a plain major.minor.patch version",
    );
    expect(() => compareStableVersions("1.0", "1.0.0")).toThrow(
      "not a plain major.minor.patch version",
    );
  });

  test("is antisymmetric and consistent with segment-wise numeric order", () => {
    fc.assert(
      fc.property(stableVersion, stableVersion, (a, b) => {
        const forward = Math.sign(compareStableVersions(a, b));
        const backward = Math.sign(compareStableVersions(b, a));
        // Summed, not negated: `toBe` is `Object.is`, and -0 !== 0 for equal inputs.
        expect(forward + backward).toBe(0);
        const left = a.split(".").map(Number);
        const right = b.split(".").map(Number);
        let expected = 0;
        for (const [index, part] of left.entries()) {
          expected = Math.sign(part - (right[index] ?? 0));
          if (expected !== 0) {
            break;
          }
        }
        expect(forward).toBe(expected);
      }),
      propertyConfig({ numRuns: 200 }),
    );
  });
});

describe("classifyCliRelease", () => {
  test("a prerelease never gates the CLI", () => {
    expect(classify("0.10.1", ["a.md"], "0.9.5-rc.1")).toEqual({
      status: "prerelease",
    });
  });

  test("a pending CLI changeset blocks before anything else is considered", () => {
    expect(classify("1.0.0", [".changeset/matters.md"])).toEqual({
      status: "pending-changesets",
      changesets: [".changeset/matters.md"],
    });
  });

  test("the published version rides unchanged", () => {
    expect(classify("0.10.1")).toEqual({
      status: "published",
      cliVersion: "0.10.1",
    });
  });

  test("an unpublished newer version is a coupled release", () => {
    expect(classify("1.0.0")).toEqual({
      status: "coupled",
      cliVersion: "1.0.0",
      latest: "0.10.1",
    });
  });

  test("a version npm already has, or one behind latest, is refused", () => {
    expect(classify("0.10.0")).toEqual({
      status: "behind-npm",
      cliVersion: "0.10.0",
      latest: "0.10.1",
    });
    expect(classify("0.9.5")).toEqual({
      status: "behind-npm",
      cliVersion: "0.9.5",
      latest: "0.10.1",
    });
  });

  test("a pending changeset dominates every version relation", () => {
    fc.assert(
      fc.property(
        stableVersion,
        fc.array(fc.string({ minLength: 1 }), { minLength: 1 }),
        (cliVersion, changesets) => {
          expect(classify(cliVersion, changesets).status).toBe(
            "pending-changesets",
          );
        },
      ),
      propertyConfig({ numRuns: 100 }),
    );
  });

  test("without pending changesets, coupled means strictly newer than npm", () => {
    fc.assert(
      fc.property(stableVersion, (cliVersion) => {
        const status = classify(cliVersion).status;
        const order = compareStableVersions(cliVersion, published.latest);
        if (order > 0) {
          expect(status).toBe("coupled");
        } else if (order === 0) {
          expect(status).toBe("published");
        } else {
          expect(status).toBe("behind-npm");
        }
      }),
      propertyConfig({ numRuns: 200 }),
    );
  });
});

describe("verdictFromClassification", () => {
  test("blocked verdicts carry the remedy", () => {
    const verdict = verdictFromClassification({
      status: "pending-changesets",
      changesets: [".changeset/matters.md"],
    });
    expect(verdict.status).toBe("blocked");
    if (verdict.status !== "blocked") {
      throw new TypeError("expected a blocked verdict");
    }
    expect(verdict.message).toContain("Version Packages");
    expect(verdict.message).toContain(".changeset/matters.md");
  });

  test("the two accepted shapes pass through", () => {
    expect(
      verdictFromClassification({ status: "published", cliVersion: "0.10.1" }),
    ).toEqual({ status: "unchanged", cliVersion: "0.10.1" });
    expect(
      verdictFromClassification({
        status: "coupled",
        cliVersion: "1.0.0",
        latest: "0.10.1",
      }),
    ).toEqual({ status: "coupled", cliVersion: "1.0.0", latest: "0.10.1" });
  });
});

describe("parseGeneratedConstants", () => {
  test("reads the TypeScript source the generator writes", () => {
    expect(
      parseGeneratedConstants(
        [
          "// GENERATED by `bun run codegen`. Do not edit by hand.",
          "",
          "export const CLI_SUPPORTED_API_PROTOCOLS = [2] as const;",
          "export const CLI_MINIMUM_SERVER_REVISION = 2;",
          "export const CLI_REQUIRED_CAPABILITIES = {",
          '  "document-version-upload": 1,',
          '  "mcp-v2-transport": 1,',
          "} as const;",
          'export const MCP_DISCOVERY_PATH =\n  "/.well-known/oauth-protected-resource/mcp" as const;',
          "export type McpErrorCode = (typeof MCP_ERROR_CODES)[number];",
        ].join("\n"),
      ),
    ).toEqual({
      CLI_SUPPORTED_API_PROTOCOLS: [2],
      CLI_MINIMUM_SERVER_REVISION: 2,
      CLI_REQUIRED_CAPABILITIES: {
        "document-version-upload": 1,
        "mcp-v2-transport": 1,
      },
      MCP_DISCOVERY_PATH: "/.well-known/oauth-protected-resource/mcp",
    });
  });

  test("reads the compiled JavaScript the tarball ships, bare keys included", () => {
    expect(
      parseGeneratedConstants(
        [
          'export const MCP_HTTP_PATH = "/mcp";',
          "export const CLI_SUPPORTED_API_PROTOCOLS = [1];",
          "export const MCP_DEPRECATED_INPUT_ALIASES = {",
          '    matter_id: "workspace_id",',
          "};",
          "//# sourceMappingURL=mcp-contract.js.map",
        ].join("\n"),
      ),
    ).toEqual({
      MCP_HTTP_PATH: "/mcp",
      CLI_SUPPORTED_API_PROTOCOLS: [1],
      MCP_DEPRECATED_INPUT_ALIASES: { matter_id: "workspace_id" },
    });
  });

  test("refuses a literal it cannot read as data", () => {
    expect(() =>
      parseGeneratedConstants("export const X = computeSomething();"),
    ).toThrow("generated constant X is not a plain literal");
  });

  test("reads the committed generated modules of this checkout", () => {
    for (const [part, source] of Object.entries(CLI_CONTRACT_SURFACE)) {
      if (source.kind !== "constants") {
        continue;
      }
      const constants = parseGeneratedConstants(
        readFileSync(path.join(REPO_ROOT, "packages/cli", part), "utf-8"),
      );
      expect(Object.keys(constants).length).toBeGreaterThan(0);
    }
  });
});

describe("canonicalJson", () => {
  test("sorts object keys at every level and keeps array order", () => {
    expect(canonicalJson({ b: [{ z: 1, a: 2 }, 3], a: "x" })).toBe(
      '{"a":"x","b":[{"a":2,"z":1},3]}',
    );
  });

  test("is invariant under key reordering", () => {
    const record = fc.dictionary(
      fc.string({ minLength: 1, maxLength: 6 }),
      fc.oneof(fc.integer(), fc.string(), fc.array(fc.integer())),
      { maxKeys: 6 },
    );
    fc.assert(
      fc.property(record, (value) => {
        const reversed = Object.fromEntries(Object.entries(value).toReversed());
        expect(canonicalJson(reversed)).toBe(canonicalJson(value));
      }),
      propertyConfig({ numRuns: 200 }),
    );
  });
});

describe("findSurfaceDrift", () => {
  const surface: CliContractSurface = {
    "capability-catalog.json": '[{"id":"matters.list","inputSchema":{}}]',
    "src/generated/registry-snapshot.json":
      '{"tools":[{"name":"list_matters"}]}',
    "src/generated/api-contract.ts": [
      "export const CLI_SUPPORTED_API_PROTOCOLS = [2] as const;",
      "export const CLI_MINIMUM_SERVER_REVISION = 2;",
      'export const CLI_REQUIRED_CAPABILITIES = {\n  "mcp-v2-transport": 1,\n  "document-version-upload": 1,\n} as const;',
    ].join("\n"),
    "src/generated/mcp-contract.ts":
      'export const MCP_HTTP_PATH = "/mcp" as const;\nexport const CLI_KNOWN_SCOPES = ["openid", "stella:read"] as const;',
  };

  test("formatting, key order and compilation do not count as drift", () => {
    expect(
      findSurfaceDrift({
        head: surface,
        published: {
          "capability-catalog.json":
            '[\n  {\n    "inputSchema": {},\n    "id": "matters.list"\n  }\n]\n',
          "src/generated/registry-snapshot.json":
            '{ "tools": [ { "name": "list_matters" } ] }',
          "src/generated/api-contract.ts": [
            "export const CLI_SUPPORTED_API_PROTOCOLS = [2];",
            "export const CLI_MINIMUM_SERVER_REVISION = 2;",
            'export const CLI_REQUIRED_CAPABILITIES = {\n    "document-version-upload": 1,\n    "mcp-v2-transport": 1,\n};',
          ].join("\n"),
          "src/generated/mcp-contract.ts":
            'export const MCP_HTTP_PATH = "/mcp";\nexport const CLI_KNOWN_SCOPES = [\n    "openid",\n    "stella:read",\n];',
        },
      }),
    ).toEqual([]);
  });

  test("each drifted part is named", () => {
    expect(
      findSurfaceDrift({
        head: surface,
        published: {
          "capability-catalog.json":
            '[{"id":"workspaces.list","inputSchema":{}}]',
          "src/generated/registry-snapshot.json":
            '{"tools":[{"name":"list_workspaces"}]}',
          "src/generated/api-contract.ts":
            "export const CLI_SUPPORTED_API_PROTOCOLS = [1];\nexport const CLI_MINIMUM_SERVER_REVISION = 1;\nexport const CLI_REQUIRED_CAPABILITIES = {};",
          "src/generated/mcp-contract.ts":
            'export const MCP_HTTP_PATH = "/mcp";\nexport const CLI_KNOWN_SCOPES = ["openid"];\nexport const MCP_DEPRECATED_INPUT_ALIASES = { matter_id: "workspace_id" };',
        },
      }),
    ).toEqual([
      "capability-catalog.json",
      "src/generated/registry-snapshot.json",
      "src/generated/api-contract.ts",
      "src/generated/mcp-contract.ts",
    ]);
  });
});

describe("release workflows run the gate", () => {
  const read = (file: string) =>
    readFileSync(path.join(REPO_ROOT, file), "utf-8");

  test("the tag workflow refuses a stable tag before pushing it", () => {
    const workflow = read(".github/workflows/tag-on-version-bump.yml");
    const gate = workflow.indexOf(SCRIPT);
    const push = workflow.indexOf("- name: Push tag");
    expect(gate).toBeGreaterThan(0);
    expect(push).toBeGreaterThan(gate);
  });

  test("a release pull request sees the same verdict before merging", () => {
    expect(read(".github/workflows/ci.yml")).toContain(
      `bun ${SCRIPT} --base "origin/$BASE_REF"`,
    );
  });
});
