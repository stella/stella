import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CATALOG_DIRECTORY = "packages/cli/capabilities";
const DISPATCH_DIRECTORY = "apps/api/src/mcp/generated/capability-dispatch";
const EXPORTER = "apps/api/scripts/export-capability-catalog.ts";
const PROBES = ["zz-probe-a", "zz-probe-b"] as const;

const fixtureSource = `import { Result } from "better-result";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";

const config = {
  description: "List synthetic billing-code merge probes.",
  permissions: { workspace: ["read"] },
  featureAccess: { type: "required", featureId: "time-billing" },
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "billing_admin",
    consumesServices: false,
  },
  access: "read",
} satisfies WorkspaceHandlerConfig;

export default createSafeHandler(config, async function* () {
  return Result.ok([]);
});
`;

const fixturePath = (probe: string) =>
  `apps/api/src/handlers/billing-codes/${probe}/list.ts`;
const capabilityId = (probe: string) => `billing-codes.${probe}.list`;

/** Compare bytes of the complete two directories, including their file census. */
const shardBytes = (checkout: string) =>
  Object.fromEntries(
    [CATALOG_DIRECTORY, DISPATCH_DIRECTORY].flatMap((directory) =>
      readdirSync(path.join(checkout, directory))
        .toSorted()
        .map((filename) => {
          const relative = `${directory}/${filename}`;
          return [
            relative,
            readFileSync(path.join(checkout, relative), "utf-8"),
          ];
        }),
    ),
  );

// Imports the actual handler graph and formatter; local constrained machines
// leave this integration proof to CI. No installed dependencies are copied.
test.skipIf(!process.env["CI"])(
  "independent real capability exports merge cleanly and regenerate to identical bytes",
  async () => {
    const temporary = mkdtempSync(path.join(tmpdir(), "stella-shard-merge-"));
    const checkout = path.join(temporary, "checkout");
    const run = async (command: string[], cwd = checkout) => {
      const env = { ...process.env };
      delete env["CI_GENERATED_SOURCES_MANIFEST"];
      const child = Bun.spawn(command, {
        cwd,
        env: {
          ...env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exitCode, stdout, stderr };
    };
    const succeed = async (command: string[], cwd = checkout) => {
      const result = await run(command, cwd);
      expect(
        result.exitCode,
        `${command.join(" ")}\n${result.stdout}\n${result.stderr}`,
      ).toBe(0);
      return result.stdout.trim();
    };
    const generate = async (check = false) =>
      run([
        process.execPath,
        "--env-file=apps/api/.env.example",
        EXPORTER,
        ...(check ? ["--check"] : []),
      ]);
    const regenerate = async () => {
      const result = await generate();
      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    };

    try {
      await succeed(
        ["git", "clone", "--shared", "--quiet", REPO_ROOT, checkout],
        temporary,
      );
      const base = await succeed(["git", "rev-parse", "HEAD"]);
      await succeed(["git", "config", "commit.gpgsign", "false"]);
      await succeed(["git", "config", "user.name", "Capability merge test"]);
      await succeed([
        "git",
        "config",
        "user.email",
        "capability-merge-test@example.invalid",
      ]);
      symlinkSync(
        path.join(REPO_ROOT, "node_modules"),
        path.join(checkout, "node_modules"),
        "dir",
      );

      for (const probe of PROBES) {
        await succeed(["git", "switch", "--quiet", "-c", probe, base]);
        const fixture = fixturePath(probe);
        mkdirSync(path.dirname(path.join(checkout, fixture)), {
          recursive: true,
        });
        writeFileSync(path.join(checkout, fixture), fixtureSource);
        await regenerate();
        const catalog = `${CATALOG_DIRECTORY}/${capabilityId(probe)}.json`;
        const dispatch = `${DISPATCH_DIRECTORY}/${capabilityId(probe)}.ts`;
        expect(existsSync(path.join(checkout, catalog))).toBe(true);
        expect(existsSync(path.join(checkout, dispatch))).toBe(true);
        expect(
          JSON.parse(readFileSync(path.join(checkout, catalog), "utf-8")),
        ).toMatchObject({
          featureId: "time-billing",
          featureAccess: "required",
        });
        const generatedDispatch = readFileSync(
          path.join(checkout, dispatch),
          "utf-8",
        );
        expect(generatedDispatch).toContain('featureId: "time-billing"');
        expect(generatedDispatch).toContain('featureAccess: "required"');
        await succeed([
          "git",
          "add",
          fixture,
          CATALOG_DIRECTORY,
          DISPATCH_DIRECTORY,
        ]);
        const staged = await succeed([
          "git",
          "diff",
          "--cached",
          "--name-only",
        ]);
        expect(staged.split("\n").toSorted()).toEqual(
          [fixture, catalog, dispatch].toSorted(),
        );
        await succeed([
          "git",
          "commit",
          "--quiet",
          "-m",
          "test: add merge probe",
        ]);
        // Coverage tables belong to a separate layout migration. This proof
        // isolates the catalog and dispatch artifacts that this PR shards.
        await succeed(["git", "restore", "docs/capability-coverage.md"]);
      }

      const merged = await run([
        "git",
        "merge-tree",
        "--write-tree",
        "--name-only",
        ...PROBES,
      ]);
      expect(merged.exitCode, `${merged.stdout}\n${merged.stderr}`).toBe(0);
      const tree = merged.stdout.trim().split("\n").at(0);
      expect(tree).toMatch(/^[a-f0-9]{40,64}$/u);
      if (tree === undefined) {
        throw new TypeError("Missing merged tree");
      }
      await succeed(["git", "read-tree", "--reset", "-u", tree]);
      const mergedBytes = shardBytes(checkout);
      await regenerate();
      expect(shardBytes(checkout)).toEqual(mergedBytes);
      await regenerate();
      expect(shardBytes(checkout)).toEqual(mergedBytes);
      const clean = await generate(true);
      expect(clean.exitCode, `${clean.stdout}\n${clean.stderr}`).toBe(0);

      const probe = PROBES[0];
      const shard = path.join(
        checkout,
        CATALOG_DIRECTORY,
        `${capabilityId(probe)}.json`,
      );
      const original = readFileSync(shard, "utf-8");
      writeFileSync(shard, `${original}\n`);
      const mutated = await generate(true);
      expect(mutated.exitCode).not.toBe(0);
      expect(mutated.stderr).toContain(
        `Capability shard drift: ${capabilityId(probe)}.json`,
      );
      writeFileSync(shard, original);

      const removedFixture = path.join(checkout, fixturePath(probe));
      rmSync(removedFixture);
      const stale = await generate(true);
      expect(stale.exitCode).not.toBe(0);
      expect(stale.stderr).toContain(
        `Capability shard drift: ${capabilityId(probe)}.json`,
      );
      expect(existsSync(shard)).toBe(true);
      await regenerate();
      expect(existsSync(shard)).toBe(false);
      expect(
        existsSync(
          path.join(checkout, DISPATCH_DIRECTORY, `${capabilityId(probe)}.ts`),
        ),
      ).toBe(false);
      writeFileSync(removedFixture, fixtureSource);
      await regenerate();
      expect(shardBytes(checkout)).toEqual(mergedBytes);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  },
  600_000,
);
