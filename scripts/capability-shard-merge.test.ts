import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
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
  contract: "patch",
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

// A capability runs the definition its REST route serves, so each probe is
// mounted too. The two probes edit opposite ends of the route module, so
// their branches merge without touching each other's lines.
const ROUTES_PATH = "apps/api/src/handlers/billing-codes/routes.ts";
const ROUTE_TABLE_OPEN = "export const billingCodesRoute = routes(\n  {\n";
const ROUTE_TABLE_CLOSE = "    },\n  },\n  {\n    prefix:";
const probeBinding = (probe: string) =>
  probe.replaceAll(/-(\w)/gu, (_, letter: string) => letter.toUpperCase());
const probeImport = (probe: string) =>
  `import ${probeBinding(probe)} from "@/api/handlers/billing-codes/${probe}/list";\n`;
const probeEntry = (probe: string) =>
  `    "/${probe}": { GET: ${probeBinding(probe)} },\n`;

const replaceOnce = (source: string, anchor: string, replacement: string) => {
  if (source.split(anchor).length !== 2) {
    throw new TypeError(`Route module anchor is not unique: ${anchor}`);
  }
  return source.replace(anchor, () => replacement);
};

const mountProbe = (routes: string, probe: string) =>
  probe === PROBES[0]
    ? replaceOnce(
        probeImport(probe) + routes,
        ROUTE_TABLE_OPEN,
        ROUTE_TABLE_OPEN + probeEntry(probe),
      )
    : replaceOnce(
        replaceOnce(
          routes,
          "\nexport const billingCodesRoute",
          `${probeImport(probe)}\nexport const billingCodesRoute`,
        ),
        ROUTE_TABLE_CLOSE,
        `    },\n${probeEntry(probe)}  },\n  {\n    prefix:`,
      );

const unmountProbe = (routes: string, probe: string) =>
  replaceOnce(
    replaceOnce(routes, probeImport(probe), ""),
    probeEntry(probe),
    "",
  );

/** Compare complete directories, including their file census. */
const shardBytes = (
  checkout: string,
  directories = [CATALOG_DIRECTORY, DISPATCH_DIRECTORY],
) =>
  Object.fromEntries(
    directories.flatMap((directory) =>
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

// Reuses the actual handler graph and runs the formatter; local constrained machines
// leave this integration proof to CI. No installed dependencies are copied.
test.skipIf(!process.env["CI"])(
  "independent real capability exports merge cleanly and regenerate to identical bytes",
  async () => {
    const temporary = mkdtempSync(path.join(tmpdir(), "stella-shard-merge-"));
    const checkout = path.join(temporary, "checkout");
    const run = async (command: string[], cwd = checkout) => {
      const env = { ...process.env };
      delete env["CI_GENERATED_SOURCES_MANIFEST"];
      const started = performance.now();
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
      console.info(
        `[phase] ${command.join(" ")}: ${((performance.now() - started) / 1000).toFixed(3)} s`,
      );
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
    let stopExporter: (() => Promise<void>) | undefined;

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

      // Clone uses committed files. Include the entry point under test when
      // validating an uncommitted change to its public invocation options.
      writeFileSync(
        path.join(checkout, EXPORTER),
        readFileSync(path.join(REPO_ROOT, EXPORTER)),
      );
      let complete: ((exitCode: number) => void) | undefined;
      const env = { ...process.env };
      delete env["CI_GENERATED_SOURCES_MANIFEST"];
      // Keep the real module graph warm while discovery, formatting and drift
      // checks still run on every invocation. A loaded module keeps the source
      // it was loaded with, so the worker is restarted whenever the route
      // table that mounts the probes changes.
      let generation = 0;
      let stdoutPath = "";
      let stderrPath = "";
      const startWorker = () => {
        generation += 1;
        stdoutPath = path.join(
          temporary,
          `exporter-${String(generation)}.stdout`,
        );
        stderrPath = path.join(
          temporary,
          `exporter-${String(generation)}.stderr`,
        );
        writeFileSync(stdoutPath, "");
        writeFileSync(stderrPath, "");
        return Bun.spawn(
          [
            process.execPath,
            "--env-file=apps/api/.env.example",
            "-e",
            `import { createInterface } from "node:readline";
import { exportCapabilityCatalog } from ${JSON.stringify(path.join(checkout, EXPORTER))};
for await (const mode of createInterface({ input: process.stdin })) {
  if (mode !== "write" && mode !== "check") throw new TypeError("Invalid export mode");
  process.send(await exportCapabilityCatalog(mode));
}
process.exit(0);`,
          ],
          {
            cwd: checkout,
            env,
            stdin: "pipe",
            stdout: Bun.file(stdoutPath),
            stderr: Bun.file(stderrPath),
            ipc(message: unknown) {
              if (typeof message !== "number" || complete === undefined) {
                throw new TypeError("Unexpected exporter response");
              }
              complete(message);
              complete = undefined;
            },
          },
        );
      };
      let worker = startWorker();
      stopExporter = async () => {
        worker.kill();
        await worker.exited;
      };
      const restartExporter = async () => {
        await stopExporter?.();
        worker = startWorker();
      };
      const generate = async (check = false) => {
        const started = performance.now();
        const stdoutOffset = readFileSync(stdoutPath, "utf-8").length;
        const stderrOffset = readFileSync(stderrPath, "utf-8").length;
        const response = new Promise<number>((resolve) => {
          complete = resolve;
        });
        await worker.stdin.write(check ? "check\n" : "write\n");
        // A short piped write can stay buffered; the worker waits for a full line.
        await worker.stdin.flush();
        const exitCode = await Promise.race([
          response,
          worker.exited.then((code) => (code === 0 ? 1 : code)),
        ]);
        const stdout = readFileSync(stdoutPath, "utf-8").slice(stdoutOffset);
        const stderr = readFileSync(stderrPath, "utf-8").slice(stderrOffset);
        console.info(
          `[phase] exporter ${check ? "check" : "write"}: ${((performance.now() - started) / 1000).toFixed(3)} s`,
        );
        return { exitCode, stdout, stderr };
      };
      const regenerate = async () => {
        const result = await generate();
        expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      };

      const expectedDispatch = new Map<string, string>();
      for (const probe of PROBES) {
        await succeed(["git", "switch", "--quiet", "-c", probe, base]);
        const fixture = fixturePath(probe);
        mkdirSync(path.dirname(path.join(checkout, fixture)), {
          recursive: true,
        });
        writeFileSync(path.join(checkout, fixture), fixtureSource);
        const routesFile = path.join(checkout, ROUTES_PATH);
        writeFileSync(
          routesFile,
          mountProbe(readFileSync(routesFile, "utf-8"), probe),
        );
        await restartExporter();
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
        expectedDispatch.set(dispatch, generatedDispatch);
        await succeed(["git", "add", fixture, ROUTES_PATH, CATALOG_DIRECTORY]);
        const staged = await succeed([
          "git",
          "diff",
          "--cached",
          "--name-only",
        ]);
        expect(staged.split("\n").toSorted()).toEqual(
          [fixture, ROUTES_PATH, catalog].toSorted(),
        );
        await succeed([
          "git",
          "commit",
          "--quiet",
          "-m",
          "test: add merge probe",
        ]);
        // Coverage tables belong to a separate layout migration. This proof
        // isolates the catalog shards and their source handlers.
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
      await restartExporter();
      const mergedCatalogBytes = shardBytes(checkout, [CATALOG_DIRECTORY]);
      await regenerate();
      expect(shardBytes(checkout, [CATALOG_DIRECTORY])).toEqual(
        mergedCatalogBytes,
      );
      for (const [dispatch, source] of expectedDispatch) {
        expect(readFileSync(path.join(checkout, dispatch), "utf-8")).toBe(
          source,
        );
      }
      const mergedBytes = shardBytes(checkout);
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
      const routesFile = path.join(checkout, ROUTES_PATH);
      const mountedRoutes = readFileSync(routesFile, "utf-8");
      rmSync(removedFixture);
      writeFileSync(routesFile, unmountProbe(mountedRoutes, probe));
      await restartExporter();
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
      writeFileSync(routesFile, mountedRoutes);
      await restartExporter();
      await regenerate();
      expect(shardBytes(checkout)).toEqual(mergedBytes);
    } finally {
      await stopExporter?.();
      rmSync(temporary, { recursive: true, force: true });
    }
  },
  // This test exports and regenerates the real handler graph, cold once per
  // route table change; one run took 70 s on a loaded workstation.
  180_000,
);
