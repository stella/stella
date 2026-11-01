import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { borrowDependencies } from "./borrowed-dependencies";
import { changesetNamesCli } from "./check-cli-release-coupling";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const DOMAIN = "notifications";
const PROBE = "zz-contract-probe";
const HANDLER = `apps/api/src/handlers/${DOMAIN}/${PROBE}/list.ts`;
const ROUTES = `apps/api/src/handlers/${DOMAIN}/routes.ts`;

const handlerSource = (
  query: string,
) => `import { Result } from "better-result";
import * as v from "valibot";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";

export default createSafeRootHandler({
  contract: "patch",
  description: "List synthetic contract probes.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  query: ${query},
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "notification_inbox",
    consumesServices: false,
  },
}, async function* () {
  return Result.ok({ items: [] });
});
`;

const run = (command: readonly string[], cwd: string) => {
  const env = { ...process.env };
  delete env["CI_GENERATED_SOURCES_MANIFEST"];
  const result = Bun.spawnSync([...command], {
    cwd,
    env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    output: `${result.stdout.toString()}\n${result.stderr.toString()}`,
  };
};

const succeed = (command: readonly string[], cwd: string) => {
  const result = run(command, cwd);
  expect(result.exitCode, `${command.join(" ")}\n${result.output}`).toBe(0);
};

// Derives the real catalog of two revisions from their own handler graphs, so
// it belongs to CI runners rather than constrained workstations.
// timeout: two private revision exports each build the MCP Apps and import the
// whole handler graph before the guard compares their catalogs.
test.skipIf(!process.env["CI"])(
  "a handler input-schema change without a CLI changeset fails the contract guard",
  () => {
    const temporary = mkdtempSync(path.join(tmpdir(), "stella-contract-"));
    const checkout = path.join(temporary, "checkout");
    try {
      succeed(
        ["git", "clone", "--shared", "--quiet", REPO_ROOT, checkout],
        temporary,
      );
      borrowDependencies(REPO_ROOT, checkout);
      for (const [key, value] of [
        ["commit.gpgsign", "false"],
        ["user.name", "Contract guard test"],
        ["user.email", "contract-guard-test@example.invalid"],
      ] as const) {
        succeed(["git", "config", key, value], checkout);
      }

      // The base carries the probe and no pending CLI release metadata.
      for (const entry of readdirSync(path.join(checkout, ".changeset"))) {
        const file = `.changeset/${entry}`;
        if (
          entry.endsWith(".md") &&
          entry !== "README.md" &&
          changesetNamesCli(readFileSync(path.join(checkout, file), "utf-8"))
        ) {
          succeed(["git", "rm", "--quiet", file], checkout);
        }
      }
      mkdirSync(path.dirname(path.join(checkout, HANDLER)), {
        recursive: true,
      });
      writeFileSync(
        path.join(checkout, HANDLER),
        handlerSource("v.object({})"),
      );
      const routes = readFileSync(path.join(checkout, ROUTES), "utf-8");
      const anchor = `export const ${DOMAIN}Route = routes(\n  {`;
      expect(routes).toContain(anchor);
      writeFileSync(
        path.join(checkout, ROUTES),
        `import contractProbe from "@/api/handlers/${DOMAIN}/${PROBE}/list";\n${routes.replace(
          anchor,
          () => `${anchor}\n    "/${PROBE}": { GET: contractProbe },`,
        )}`,
      );
      succeed(["git", "add", HANDLER, ROUTES], checkout);
      succeed(["git", "commit", "--quiet", "-m", "test: base"], checkout);

      writeFileSync(
        path.join(checkout, HANDLER),
        handlerSource("v.object({ limit: v.optional(v.number()) })"),
      );
      succeed(["git", "commit", "--quiet", "-am", "test: schema"], checkout);

      const guard = run(
        [
          process.execPath,
          "scripts/check-cli-contract-changeset.ts",
          "--base",
          "HEAD~1",
        ],
        checkout,
      );
      expect(guard.exitCode, guard.output).toBe(1);
      expect(guard.output).toContain("capability-catalog.json");
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  },
  300_000,
);
