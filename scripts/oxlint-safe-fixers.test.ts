import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "..");
const temporaryDirectories: string[] = [];

setDefaultTimeout(20_000);

const PLUGINS = [
  "no-awaited-builder-union",
  "no-coerced-optional-union-enum",
  "no-physical-properties",
] as const;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(
        async (directory) =>
          await rm(directory, { force: true, recursive: true }),
      ),
  );
});

type FixCase = {
  expected: string;
  fileName?: string;
  source: string;
};

const runOxlint = async (configPath: string, sourcePath: string) => {
  const spawned = Bun.spawn(
    [
      process.execPath,
      "--bun",
      "oxlint",
      "-c",
      configPath,
      "--fix",
      sourcePath,
    ],
    {
      cwd: REPOSITORY_ROOT,
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  const [exitCode, stderr, stdout] = await Promise.all([
    spawned.exited,
    new Response(spawned.stderr).text(),
    new Response(spawned.stdout).text(),
  ]);
  return { exitCode, output: `${stdout}\n${stderr}` };
};

const writeHarness = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "stella-oxlint-fixers-"));
  temporaryDirectories.push(directory);
  const configPath = path.join(directory, "oxlint.config.ts");
  const jsPlugins = PLUGINS.map((plugin) =>
    path.join(REPOSITORY_ROOT, ".oxlint-plugins", `${plugin}.ts`),
  );
  const rules = Object.fromEntries(
    PLUGINS.map((plugin) => [`${plugin}/${plugin}`, "error"]),
  );
  await Bun.write(
    configPath,
    `export default ${JSON.stringify({ jsPlugins, rules })};\n`,
  );
  return { configPath, directory };
};

const expectFixedPoint = async ({ expected, fileName, source }: FixCase) => {
  const { configPath, directory } = await writeHarness();
  const sourcePath = path.join(directory, fileName ?? "subject.ts");
  await Bun.write(sourcePath, source);

  const firstRun = await runOxlint(configPath, sourcePath);
  expect(firstRun.exitCode).toBe(0);
  for (const plugin of PLUGINS) {
    expect(firstRun.output).not.toContain(`${plugin}/${plugin}`);
  }
  expect(await Bun.file(sourcePath).text()).toBe(expected);

  const secondRun = await runOxlint(configPath, sourcePath);
  expect(secondRun.exitCode).toBe(0);
  for (const plugin of PLUGINS) {
    expect(secondRun.output).not.toContain(`${plugin}/${plugin}`);
  }
  expect(await Bun.file(sourcePath).text()).toBe(expected);
};

describe.serial("custom oxlint safe fixers", () => {
  test("rewrites every supported physical Tailwind direction", async () => {
    await expectFixedPoint({
      fileName: "subject.tsx",
      source:
        'export const view = <div className="ml-2 mr-3 pl-4 pr-5 -left-1 right-[2px] text-left text-right border-l border-r-2 rounded-l rounded-r-xl rounded-tl-md rounded-tr rounded-bl-lg rounded-br scroll-ml-2 scroll-mr-2 scroll-pl-3 hover:scroll-pr-3" />;\nexport const template = <div className={`hover:pr-4 md:rounded-l-lg`} />;\n',
      expected:
        'export const view = <div className="ms-2 me-3 ps-4 pe-5 -start-1 end-[2px] text-start text-end border-s border-e-2 rounded-s rounded-e-xl rounded-ss-md rounded-se rounded-es-lg rounded-ee scroll-ms-2 scroll-me-2 scroll-ps-3 hover:scroll-pe-3" />;\nexport const template = <div className={`hover:pe-4 md:rounded-s-lg`} />;\n',
    });
  });

  test("moves await into direct builder-union branches", async () => {
    await expectFixedPoint({
      source:
        "async function load() { return await\n  (lock ? query : paged ? query.limit(1) : query.offset(2)); }\n",
      expected:
        "async function load() { return (lock ? await query : paged ? await query.limit(1) : await query.offset(2)); }\n",
    });
  });

  test("expands a static namespaced optional UnionEnum", async () => {
    await expectFixedPoint({
      source:
        'const schema = t.Optional(t.UnionEnum(["person", /* keep */ "organization"]));\n',
      expected:
        'const schema = t.Optional(t.Union([t.Literal("person"), /* keep */ t.Literal("organization")]));\n',
    });
  });

  test("leaves context-dependent violations for the agent", async () => {
    const { configPath, directory } = await writeHarness();
    const sourcePath = path.join(directory, "subject.tsx");
    const source = [
      "async function load() {",
      "  return await ((lock ? query.for('update') : query) satisfies Builder);",
      "}",
      "async function loadWithRationale() {",
      "  return await // preserve rationale",
      "    (lock ? query : query.limit(1));",
      "}",
      "async function loadWithBranchWrappers() {",
      "  return await (lock ? (query as Builder) : (query.limit(1) satisfies Builder));",
      "}",
      "async function loadWithNestedBranchWrapper() {",
      "  return await (lock ? ((paged ? query : query.limit(1)) satisfies Builder) : query.offset(2));",
      "}",
      "const schema = t.Optional(t.UnionEnum(VALUES));",
      'const guidance = "Use right-click to open the menu";',
      `const arbitraryContent = <span className="before:content-['right-click']" />;`,
      "",
    ].join("\n");
    await Bun.write(sourcePath, source);

    const result = await runOxlint(configPath, sourcePath);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("no-awaited-builder-union");
    expect(result.output).toContain("no-coerced-optional-union-enum");
    expect(result.output).toContain("no-physical-properties");
    expect(await Bun.file(sourcePath).text()).toBe(source);
  });
});
