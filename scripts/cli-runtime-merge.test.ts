import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CAPABILITIES = "packages/cli/capabilities";
const SNAPSHOT = "packages/cli/src/generated/registry-snapshot.json";
const CODEGEN = "packages/cli/src/codegen.ts";
const CHECKER = "scripts/check-cli-runtime-generation.ts";
const OUTPUTS = [
  "packages/cli/src/generated/route-map.ts",
  "packages/cli/src/generated/tool-annotations.ts",
] as const;
const PROBES = [
  { name: "zz-probe-a", capabilityId: "zz-capability-a.list", position: 1 },
  { name: "zz-probe-b", capabilityId: "zz-capability-b.list", position: 50 },
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

// Each capability is its own committed shard, so a probe adds one new file.
const capabilityShard = ({ capabilityId }: (typeof PROBES)[number]) =>
  `${CAPABILITIES}/${capabilityId}.json`;

const addCapability = (checkout: string, probe: (typeof PROBES)[number]) => {
  const { capabilityId } = probe;
  const shard = path.join(checkout, capabilityShard(probe));
  expect(existsSync(shard)).toBe(false);
  const capability = {
    id: capabilityId,
    description: "List synthetic capability merge probes.",
    handlerKind: "root",
    access: "read",
    destructive: false,
    consumesServices: false,
    scope: "stella:read",
    transport: { type: "json" },
    permissions: {},
    inputSchema: { query: { type: "object", properties: {} } },
    mcp: { type: "capability", reason: "billing_admin" },
  };
  writeFileSync(shard, `${JSON.stringify(capability)}\n`);
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
    const linkDependencies = (cwd: string) =>
      symlinkSync(
        path.join(REPO_ROOT, "node_modules"),
        path.join(cwd, "node_modules"),
        "dir",
      );

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
        const shard = capabilityShard(probe);
        await generate(checkout);
        const bytes = runtimeBytes(checkout);
        expect(bytes[OUTPUTS[0]]).toContain(probe.name);
        expect(bytes[OUTPUTS[1]]).toContain(probe.name);
        expect(bytes[OUTPUTS[0]]).toContain(probe.capabilityId);
        await succeed(["git", "add", SNAPSHOT, shard], checkout);
        const staged = await succeed(
          ["git", "diff", "--cached", "--name-only"],
          checkout,
        );
        expect(staged.split("\n").toSorted()).toEqual(
          [SNAPSHOT, shard].toSorted(),
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
