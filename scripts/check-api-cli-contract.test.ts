import { describe, expect, test } from "bun:test";

import {
  MCP_DEFAULT_RESOURCE_SCOPES,
  MCP_OAUTH_SCOPES,
  STELLA_CLI_LATEST_VERSION,
  STELLA_CLI_MAXIMUM_VERSION,
  STELLA_CLI_MINIMUM_VERSION,
  STELLA_MCP_API_CONTRACT_VERSION,
} from "../apps/api/src/mcp/constants";
import cliPackage from "../packages/cli/package.json" with { type: "json" };
import {
  CLI_DEFAULT_SCOPES,
  CLI_KNOWN_SCOPES,
  CLI_REQUIRED_RESOURCE_SCOPES,
  CLI_REQUIRED_SCOPES,
} from "../packages/cli/src/auth/constants";
import { CLI_SUPPORTED_API_CONTRACT_VERSION } from "../packages/cli/src/compatibility";

const SHARED_NPM_PACKAGES = [
  "business-registries",
  "country-codes",
  "conditions",
  "template-conditions",
  "docx-utils",
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const expectSubset = (
  subset: readonly string[],
  superset: readonly string[],
) => {
  const available = new Set(superset);
  expect(subset.filter((value) => !available.has(value))).toEqual([]);
};

describe("API and CLI release contract", () => {
  test("the server advertises the contract version implemented by the CLI", () => {
    expect(STELLA_MCP_API_CONTRACT_VERSION).toBe(
      CLI_SUPPORTED_API_CONTRACT_VERSION,
    );
  });

  test("a CLI version bump cannot merge without server support", () => {
    expect(STELLA_CLI_MAXIMUM_VERSION).toBe(cliPackage.version);
    expect(
      Bun.semver.satisfies(
        cliPackage.version,
        `>=${STELLA_CLI_MINIMUM_VERSION} <=${STELLA_CLI_MAXIMUM_VERSION}`,
      ),
    ).toBe(true);
    expect(
      Bun.semver.satisfies(
        STELLA_CLI_LATEST_VERSION,
        `>=${STELLA_CLI_MINIMUM_VERSION} <=${STELLA_CLI_MAXIMUM_VERSION}`,
      ),
    ).toBe(true);
  });

  test("every packaged CLI scope is supported by the same API source", () => {
    expectSubset(CLI_KNOWN_SCOPES, MCP_OAUTH_SCOPES);
    expectSubset(CLI_REQUIRED_RESOURCE_SCOPES, MCP_DEFAULT_RESOURCE_SCOPES);
    expectSubset(CLI_DEFAULT_SCOPES, CLI_KNOWN_SCOPES);
    expectSubset(CLI_REQUIRED_SCOPES, CLI_DEFAULT_SCOPES);
  });

  test("manual releases preserve their resolved tag for CLI publication", async () => {
    const [releaseWorkflow, publishWorkflow] = await Promise.all([
      Bun.file(
        new URL("../.github/workflows/release.yml", import.meta.url),
      ).text(),
      Bun.file(
        new URL("../.github/workflows/publish-npm.yml", import.meta.url),
      ).text(),
    ]);

    expect(releaseWorkflow).toContain("name: release-source-receipt");
    expect(publishWorkflow).toContain('gh run download "$UPSTREAM_RUN_ID"');
    expect(publishWorkflow).toContain(
      `UPSTREAM_RELEASE_REF: \${{ needs.release-trigger.outputs.release_ref }}`,
    );
    expect(publishWorkflow).not.toContain(
      "github.event.workflow_run.head_branch",
    );
  });

  test("shared package publishing uses Changesets release signals", async () => {
    const [changesetConfig, ciWorkflow, publishWorkflow] = await Promise.all([
      Bun.file(new URL("../.changeset/config.json", import.meta.url)).text(),
      Bun.file(new URL("../.github/workflows/ci.yml", import.meta.url)).text(),
      Bun.file(
        new URL("../.github/workflows/publish-npm.yml", import.meta.url),
      ).text(),
    ]);
    const pushTrigger = publishWorkflow.slice(
      0,
      publishWorkflow.indexOf("  workflow_run:"),
    );
    const manifests = new Map(
      await Promise.all(
        SHARED_NPM_PACKAGES.map(async (packageName) => {
          const manifest: unknown = await Bun.file(
            new URL(`../packages/${packageName}/package.json`, import.meta.url),
          ).json();
          return [packageName, manifest] as const;
        }),
      ),
    );

    for (const packageName of SHARED_NPM_PACKAGES) {
      expect(pushTrigger).toContain(`packages/${packageName}/CHANGELOG.md`);
      expect(pushTrigger).not.toContain(`packages/${packageName}/package.json`);
      expect(ciWorkflow).toContain(`packages/${packageName}/src/**`);
      expect(ciWorkflow).toContain(`packages/${packageName}/CHANGELOG.md`);
      expect(ciWorkflow).toContain(`packages/${packageName}/package.json`);
      expect(publishWorkflow).toContain(`- ${packageName}`);
      expect(publishWorkflow).toContain(`npm-tarball-${packageName}`);
      expect(changesetConfig).not.toContain(`"@stll/${packageName}"`);

      const manifest: unknown = manifests.get(packageName);
      expect(isRecord(manifest)).toBe(true);
      if (!isRecord(manifest)) {
        throw new TypeError(`${packageName} package manifest is not an object`);
      }
      const packageExports = manifest["exports"];
      expect(isRecord(packageExports)).toBe(true);
      if (!isRecord(packageExports)) {
        throw new TypeError(`${packageName} exports is not an object`);
      }
      for (const target of Object.values(packageExports)) {
        expect(typeof target).toBe("string");
        if (typeof target !== "string") {
          throw new TypeError(`${packageName} has a non-string export target`);
        }
        expect(target).toMatch(/^\.\/src\/.*\.ts$/u);
      }
    }
  });
});
