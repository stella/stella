import { describe, expect, test } from "bun:test";

import apiPackage from "../apps/api/package.json" with { type: "json" };
import {
  STELLA_API_CONTRACT,
  STELLA_MCP_API_CONTRACT_VERSION,
} from "../apps/api/src/mcp/constants";
import cliPackage from "../packages/cli/package.json" with { type: "json" };
import {
  CLI_DEFAULT_SCOPES,
  CLI_KNOWN_SCOPES,
  CLI_REQUIRED_SCOPES,
} from "../packages/cli/src/auth/constants";
import {
  CLI_MINIMUM_SERVER_REVISION,
  CLI_REQUIRED_CAPABILITIES,
  CLI_SUPPORTED_API_PROTOCOLS,
} from "../packages/cli/src/generated/api-contract";
import { loadChangesetPolicy } from "./changeset-guard";

const SHARED_NPM_PACKAGES = [
  "auth-model",
  "ai-catalog",
  "anonymize-chat",
  "business-registries",
  "chat",
  "calculations",
  "country-codes",
  "conditions",
  "docx-utils",
  "money",
  "template-conditions",
  "workspace-model",
  "workspace-ui",
] as const;

/**
 * The release gate's pathspecs live in scripts/changeset-policy.json, and the
 * workflow reads them from there rather than repeating them, so these
 * assertions read the same file the gate does. `changeset-guard.test.ts` holds
 * the other half of the contract: that the workflow consumes the policy and
 * inlines no pathspecs of its own.
 */
const policy = loadChangesetPolicy();

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
  test("private workspaces stay outside Changesets releases", async () => {
    const config: unknown = await Bun.file(
      new URL("../.changeset/config.json", import.meta.url),
    ).json();

    expect(isRecord(config)).toBe(true);
    if (!isRecord(config)) {
      throw new TypeError("Changesets config is not an object");
    }

    const privatePackages = config["privatePackages"];
    expect(isRecord(privatePackages)).toBe(true);
    if (!isRecord(privatePackages)) {
      throw new TypeError("Changesets private package config is not an object");
    }

    expect(privatePackages["version"]).toBe(false);
  });

  test("the server satisfies the generated CLI protocol contract", () => {
    expect(CLI_SUPPORTED_API_PROTOCOLS).toContain(
      STELLA_MCP_API_CONTRACT_VERSION,
    );
    expect(STELLA_API_CONTRACT.revision).toBeGreaterThanOrEqual(
      CLI_MINIMUM_SERVER_REVISION,
    );
    const serverCapabilities: Readonly<Record<string, number>> =
      STELLA_API_CONTRACT.capabilities;
    for (const [name, requiredVersion] of Object.entries(
      CLI_REQUIRED_CAPABILITIES,
    )) {
      expect(serverCapabilities).toHaveProperty(name);
      expect(serverCapabilities[name]).toBeGreaterThanOrEqual(requiredVersion);
    }
  });

  test("the API and CLI use matching MCP package versions", () => {
    const serverVersion =
      apiPackage.dependencies["@modelcontextprotocol/server"];
    expect(apiPackage.devDependencies["@modelcontextprotocol/client"]).toBe(
      serverVersion,
    );
    expect(cliPackage.dependencies["@modelcontextprotocol/client"]).toBe(
      serverVersion,
    );
  });

  test("automated versioning regenerates the baked CLI package version", async () => {
    const rootPackage: unknown = await Bun.file(
      new URL("../package.json", import.meta.url),
    ).json();
    if (!isRecord(rootPackage)) {
      throw new TypeError("root package manifest is not an object");
    }
    const scripts = rootPackage["scripts"];
    if (!isRecord(scripts)) {
      throw new TypeError("root package scripts are not an object");
    }

    const versionScript = scripts["changeset:version"];
    if (typeof versionScript !== "string") {
      throw new TypeError("changeset:version script is not a string");
    }
    const changesetVersionIndex = versionScript.indexOf("changeset version");
    const cliVersionCodegenIndex = versionScript.indexOf(
      "bun --cwd packages/cli codegen:version",
    );
    expect(changesetVersionIndex).toBeGreaterThanOrEqual(0);
    expect(cliVersionCodegenIndex).toBeGreaterThan(changesetVersionIndex);
    expect(cliPackage.scripts["codegen:version"]).toBe(
      "bun run src/codegen-version.ts",
    );
    expect(cliPackage.scripts.codegen).toContain(
      "bun run src/codegen-version.ts",
    );

    // The baked version is written by `changeset version`, so a release that
    // did not carry it would ship a CLI reporting the previous version.
    expect(policy.generatedPaths).toContain(
      "packages/cli/src/generated/cli-version.ts",
    );
  });

  test("the CLI's local scope policies use generated server scopes", () => {
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

  test("release and pull-request smoke tests reject synthetic migration history", async () => {
    const workflows = await Promise.all([
      Bun.file(
        new URL("../.github/workflows/release.yml", import.meta.url),
      ).text(),
      Bun.file(
        new URL("../.github/workflows/db-migrations.yml", import.meta.url),
      ).text(),
    ]);

    for (const workflow of workflows) {
      expect(workflow).toContain(
        "CREATE TABLE drizzle.__migration_history_smoke_backup AS SELECT id, hash",
      );
      expect(workflow).toContain(
        "SET hash = backup.hash FROM drizzle.__migration_history_smoke_backup AS backup",
      );
      expect(workflow).toContain(
        "DROP TABLE drizzle.__migration_history_smoke_backup",
      );
      expect(workflow).not.toContain(":'original_hash'");
    }
  });

  test("release and migration smoke tests wait for scheduler initialization", async () => {
    const workflows = await Promise.all([
      Bun.file(
        new URL("../.github/workflows/release.yml", import.meta.url),
      ).text(),
      Bun.file(
        new URL("../.github/workflows/db-migrations.yml", import.meta.url),
      ).text(),
    ]);

    for (const workflow of workflows) {
      expect(workflow).toContain("curl -fsS http://127.0.0.1:3001/live");
      expect(workflow).toContain(`grep -q '"message":"scheduler.started"'`);
    }
  });

  test("shared package publishing uses Changesets release signals", async () => {
    const [changesetConfig, publishWorkflow] = await Promise.all([
      Bun.file(new URL("../.changeset/config.json", import.meta.url)).text(),
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
      // A released package missing from the gate is the failure this guards:
      // its source would merge with no changeset, and its version bump would
      // not be recognised as release metadata.
      expect(policy.releasePaths).toContain(`packages/${packageName}/src/**`);
      expect(policy.generatedPaths).toContain(
        `packages/${packageName}/CHANGELOG.md`,
      );
      expect(policy.generatedPaths).toContain(
        `packages/${packageName}/package.json`,
      );
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
        expect(target).toMatch(/^\.\/src\/.*\.tsx?$/u);
      }
    }
  });
});
