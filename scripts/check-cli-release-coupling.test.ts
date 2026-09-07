import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import path from "node:path";

import { propertyConfig } from "@stll/property-testing";

import {
  changesetNamesCli,
  classifyCliRelease,
  compareStableVersions,
  findSurfaceDrift,
  verdictFromClassification,
  type ApiContractSnapshot,
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
        expect(forward).toBe(-backward);
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

describe("findSurfaceDrift", () => {
  const contract: ApiContractSnapshot = {
    protocols: [1],
    minimumServerRevision: 2,
    requiredCapabilities: {
      "mcp-v2-transport": 1,
      "document-version-upload": 1,
    },
  };
  const surface: CliContractSurface = {
    apiContract: contract,
    capabilityCatalog: '[{"id":"matters.list","inputSchema":{}}]',
    registrySnapshot: '{"tools":[{"name":"list_matters"}]}',
  };

  test("formatting and key order do not count as drift", () => {
    expect(
      findSurfaceDrift({
        head: surface,
        published: {
          apiContract: {
            protocols: [1],
            minimumServerRevision: 2,
            requiredCapabilities: {
              "document-version-upload": 1,
              "mcp-v2-transport": 1,
            },
          },
          capabilityCatalog:
            '[\n  {\n    "id": "matters.list",\n    "inputSchema": {}\n  }\n]\n',
          registrySnapshot: '{ "tools": [ { "name": "list_matters" } ] }',
        },
      }),
    ).toEqual([]);
  });

  test("each drifted part is named", () => {
    expect(
      findSurfaceDrift({
        head: surface,
        published: {
          apiContract: { ...contract, minimumServerRevision: 1 },
          capabilityCatalog: '[{"id":"workspaces.list","inputSchema":{}}]',
          registrySnapshot: '{"tools":[{"name":"list_workspaces"}]}',
        },
      }),
    ).toEqual([
      "src/generated/api-contract.ts",
      "capability-catalog.json",
      "src/generated/registry-snapshot.json",
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
