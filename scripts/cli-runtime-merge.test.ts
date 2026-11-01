import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { borrowDependencies } from "./borrowed-dependencies";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const HANDLERS = "apps/api/src/handlers";
const SNAPSHOT = "packages/cli/src/generated/registry-snapshot.json";
const CODEGEN = "packages/cli/scripts/codegen.ts";
const CHECKER = "scripts/check-cli-runtime-generation.ts";
const OUTPUTS = [
  "packages/cli/src/generated/route-map.ts",
  "packages/cli/src/generated/tool-annotations.ts",
] as const;
const PROBES = [
  {
    name: "zz-probe-a",
    capabilityId: "notifications.zz-probe-a.list",
    domain: "notifications",
    position: 1,
  },
  {
    name: "zz-probe-b",
    capabilityId: "contacts.zz-probe-b.list",
    domain: "contacts",
    position: 50,
  },
] as const;

// Insert one complete listing without rewriting any existing listing. Separate
// source anchors ensure the test isolates conflicts caused by derived outputs.
const addProbe = (
  snapshot: string,
  { name, position }: (typeof PROBES)[number],
) => {
  const entries: unknown = JSON.parse(snapshot);
  if (!Array.isArray(entries)) {
    throw new TypeError("Registry snapshot is not an array");
  }
  const lines = snapshot.split("\n");
  const starts = lines.flatMap((line, index) =>
    line === "  {" ? [index] : [],
  );
  expect(starts.length).toBe(entries.length);
  const insertion = starts.at(position);
  if (insertion === undefined) {
    throw new TypeError("Missing probe insertion anchor");
  }
  const listing = {
    cli: { command: [name, "list"], scope: "read" },
    name,
    description: "List synthetic CLI merge probes.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  };
  const block = `${JSON.stringify(listing, null, 2)
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n")},`;
  lines.splice(insertion, 0, block);
  return lines.join("\n");
};

const capabilityHandler = ({ domain, name }: (typeof PROBES)[number]) =>
  `${HANDLERS}/${domain}/${name}/list.ts`;

const capabilityRoutes = ({ domain }: (typeof PROBES)[number]) =>
  `${HANDLERS}/${domain}/routes.ts`;

const addCapability = (checkout: string, probe: (typeof PROBES)[number]) => {
  const { domain, name } = probe;
  const handler = path.join(checkout, capabilityHandler(probe));
  expect(existsSync(handler)).toBe(false);
  mkdirSync(path.dirname(handler), { recursive: true });
  writeFileSync(
    handler,
    `import { Result } from "better-result";
import * as v from "valibot";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";

export default createSafeRootHandler({
  contract: "patch",
  description: "List synthetic capability merge probes.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  query: v.object({}),
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "notification_inbox",
    consumesServices: false,
  },
}, async function* () {
  return Result.ok({ items: [] });
});
`,
  );
  const routes = path.join(checkout, capabilityRoutes(probe));
  const source = readFileSync(routes, "utf-8");
  const anchor = `export const ${domain}Route = routes(\n  {`;
  expect(source).toContain(anchor);
  writeFileSync(
    routes,
    `import mergeProbe from "@/api/handlers/${domain}/${name}/list";\n${source.replace(
      anchor,
      () => `${anchor}\n    "/${name}": { GET: mergeProbe },`,
    )}`,
  );
};

const runtimeBytes = (checkout: string) =>
  Object.fromEntries(
    OUTPUTS.map((file) => [
      file,
      readFileSync(path.join(checkout, file), "utf-8"),
    ]),
  );

// This runs real generation in disposable repositories; it belongs in CI on
// machines that can run the generator without local load gates.
test.skipIf(!process.env["CI"])(
  "independent registry additions merge without derived runtime files and regenerate deterministically",
  async () => {
    const temporary = mkdtempSync(
      path.join(tmpdir(), "stella-cli-runtime-merge-"),
    );
    const checkout = path.join(temporary, "branches");
    const mergedCheckout = path.join(temporary, "merged");
    const run = async (command: string[], cwd: string) => {
      const env = { ...process.env };
      delete env["CI_GENERATED_SOURCES_MANIFEST"];
      const child = Bun.spawn(command, {
        cwd,
        env,
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
    const succeed = async (command: string[], cwd: string) => {
      const result = await run(command, cwd);
      expect(
        result.exitCode,
        `${command.join(" ")}\n${result.stdout}\n${result.stderr}`,
      ).toBe(0);
      return result.stdout.trim();
    };
    const generate = async (cwd: string) =>
      succeed(
        [process.execPath, "--cwd=packages/cli", "run", "codegen:runtime"],
        cwd,
      );
    // Runtime preparation builds the MCP Apps from the clone's own workspace
    // packages, so dependencies are borrowed without redirecting those.
    const linkDependencies = (cwd: string) =>
      borrowDependencies(REPO_ROOT, cwd);

    try {
      await succeed(
        ["git", "clone", "--shared", "--quiet", REPO_ROOT, checkout],
        temporary,
      );
      linkDependencies(checkout);
      const base = await succeed(["git", "rev-parse", "HEAD"], checkout);
      await succeed(["git", "config", "commit.gpgsign", "false"], checkout);
      await succeed(
        ["git", "config", "user.name", "CLI runtime merge test"],
        checkout,
      );
      await succeed(
        [
          "git",
          "config",
          "user.email",
          "cli-runtime-merge-test@example.invalid",
        ],
        checkout,
      );
      for (const probe of PROBES) {
        await succeed(
          ["git", "switch", "--quiet", "-c", probe.name, base],
          checkout,
        );
        const source = path.join(checkout, SNAPSHOT);
        writeFileSync(source, addProbe(readFileSync(source, "utf-8"), probe));
        addCapability(checkout, probe);
        const handler = capabilityHandler(probe);
        const routes = capabilityRoutes(probe);
        await generate(checkout);
        const bytes = runtimeBytes(checkout);
        expect(bytes[OUTPUTS[0]]).toContain(probe.name);
        expect(bytes[OUTPUTS[1]]).toContain(probe.name);
        expect(bytes[OUTPUTS[0]]).toContain(probe.capabilityId);
        await succeed(["git", "add", SNAPSHOT, handler, routes], checkout);
        const staged = await succeed(
          ["git", "diff", "--cached", "--name-only"],
          checkout,
        );
        expect(staged.split("\n").toSorted()).toEqual(
          [SNAPSHOT, handler, routes].toSorted(),
        );
        await succeed(
          ["git", "commit", "--quiet", "-m", "test: add runtime merge probe"],
          checkout,
        );
        const tracked = await succeed(
          ["git", "ls-tree", "-r", "--name-only", "HEAD", "--", ...OUTPUTS],
          checkout,
        );
        expect(tracked).toBe("");
      }

      const merged = await run(
        [
          "git",
          "merge-tree",
          "--write-tree",
          "--name-only",
          ...PROBES.map(({ name }) => name),
        ],
        checkout,
      );
      expect(merged.exitCode, `${merged.stdout}\n${merged.stderr}`).toBe(0);
      const tree = merged.stdout.trim().split("\n").at(0);
      expect(tree).toMatch(/^[a-f0-9]{40,64}$/u);
      if (tree === undefined) {
        throw new TypeError("Missing merged tree");
      }
      await succeed(
        [
          "git",
          "clone",
          "--shared",
          "--quiet",
          "--no-checkout",
          checkout,
          mergedCheckout,
        ],
        temporary,
      );
      await succeed(
        ["git", "read-tree", "--reset", "-u", tree],
        mergedCheckout,
      );
      linkDependencies(mergedCheckout);
      for (const output of OUTPUTS) {
        expect(existsSync(path.join(mergedCheckout, output))).toBe(false);
      }
      await generate(mergedCheckout);
      const expected = runtimeBytes(mergedCheckout);
      for (const { name, capabilityId } of PROBES) {
        expect(expected[OUTPUTS[0]]).toContain(name);
        expect(expected[OUTPUTS[1]]).toContain(name);
        expect(expected[OUTPUTS[0]]).toContain(capabilityId);
      }
      await generate(mergedCheckout);
      expect(runtimeBytes(mergedCheckout)).toEqual(expected);
      await succeed([process.execPath, CHECKER], mergedCheckout);

      const turboCommand = [
        path.join(mergedCheckout, "node_modules/.bin/turbo"),
        "run",
        "codegen:runtime",
        "--filter=@stll/cli",
        `--cache-dir=${path.join(temporary, "turbo-cache")}`,
        "--cache=local:rw",
        "--output-logs=full",
      ];
      const uncached = await run(turboCommand, mergedCheckout);
      expect(uncached.exitCode, `${uncached.stdout}\n${uncached.stderr}`).toBe(
        0,
      );
      expect(`${uncached.stdout}\n${uncached.stderr}`).toContain("cache miss");
      const cachedBytes = runtimeBytes(mergedCheckout);
      expect(cachedBytes).toEqual(expected);
      for (const output of OUTPUTS) {
        rmSync(path.join(mergedCheckout, output));
        expect(existsSync(path.join(mergedCheckout, output))).toBe(false);
      }
      const restored = await run(turboCommand, mergedCheckout);
      expect(restored.exitCode, `${restored.stdout}\n${restored.stderr}`).toBe(
        0,
      );
      expect(`${restored.stdout}\n${restored.stderr}`).toContain("cache hit");
      expect(runtimeBytes(mergedCheckout)).toEqual(cachedBytes);

      const codegenPath = path.join(mergedCheckout, CODEGEN);
      const codegen = readFileSync(codegenPath, "utf-8");
      const headerAnchor = "const annotationHeader = `";
      expect(codegen).toContain(headerAnchor);
      const mutated = codegen.replace(
        headerAnchor,
        () => `${headerAnchor}// \${Math.random()}\n`,
      );
      expect(mutated).not.toBe(codegen);
      writeFileSync(codegenPath, mutated);
      const mutation = await run([process.execPath, CHECKER], mergedCheckout);
      expect(mutation.exitCode).not.toBe(0);
      expect(`${mutation.stdout}\n${mutation.stderr}`).toContain(
        "CLI runtime generation is not deterministic",
      );
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  },
  300_000,
);
