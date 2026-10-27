import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript6";

import { safeAutofixRuleArgs } from "./autofix-safe-rules";

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "..");
const temporaryDirectories: string[] = [];

setDefaultTimeout(20_000);

const PLUGINS = [
  "no-awaited-builder-union",
  "no-layout-motion-classes",
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

type RunOxlintOptions = {
  configPath: string;
  sourcePath: string;
  ruleArgs?: readonly string[];
};

const runOxlint = async ({
  configPath,
  sourcePath,
  ruleArgs = [],
}: RunOxlintOptions) => {
  const spawned = Bun.spawn(
    [
      process.execPath,
      "--bun",
      "oxlint",
      "-c",
      configPath,
      "--fix",
      ...ruleArgs,
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

  const firstRun = await runOxlint({ configPath, sourcePath });
  expect(firstRun.exitCode).toBe(0);
  for (const plugin of PLUGINS) {
    expect(firstRun.output).not.toContain(`${plugin}/${plugin}`);
  }
  expect(await Bun.file(sourcePath).text()).toBe(expected);

  const secondRun = await runOxlint({ configPath, sourcePath });
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

  test("rewrites the screen viewport utilities", async () => {
    await expectFixedPoint({
      fileName: "subject.tsx",
      source:
        'export const view = <div className="h-screen min-h-screen max-h-screen w-screen md:min-h-screen!" />;\nexport const composed = cn(`min-h-screen`);\n',
      expected:
        'export const view = <div className="h-dvh min-h-dvh max-h-dvh w-dvw md:min-h-dvh!" />;\nexport const composed = cn(`min-h-dvh`);\n',
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
      'const guidance = "Use right-click to open the menu";',
      `const arbitraryContent = <span className="before:content-['right-click']" />;`,
      `const quotedBracketContent = <span className="before:content-['a] right-click']" />;`,
      `const escapedBracketContent = <span className={"before:content-\\u005b'right-click'\\u005d"} />;`,
      "const interpolatedArbitrary = <span className={`content-[$" +
        "{prefix} right-click] mr-2`} />;",
      "",
    ].join("\n");
    await Bun.write(sourcePath, source);

    const result = await runOxlint({ configPath, sourcePath });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("no-awaited-builder-union");
    expect(result.output).toContain("no-physical-properties");
    expect(await Bun.file(sourcePath).text()).toBe(source);
  });
});

test("automatic source fixes preserve exported declaration types", async () => {
  const { configPath, directory } = await writeHarness();
  await Bun.write(
    configPath,
    'export default { plugins: ["typescript"], categories: { correctness: "off" } };\n',
  );
  const sourcePath = path.join(directory, "exports.ts");
  const source = [
    'export const mode: string = "default";',
    "export const attempts: number = 3;",
    "export const enabled: boolean = true;",
    'export let currentMode = "default";',
    'export class Configuration { readonly mode: string = "default"; }',
    "",
  ].join("\n");
  await Bun.write(sourcePath, source);
  const before = ts.transpileDeclaration(source, {
    fileName: sourcePath,
  }).outputText;
  expect(before).toContain("mode: string;");
  expect(before).toContain("attempts: number;");
  expect(before).toContain("enabled: boolean;");
  expect(before).toContain("currentMode: string;");

  const fixed = await runOxlint({
    configPath,
    sourcePath,
    ruleArgs: safeAutofixRuleArgs(),
  });
  expect(fixed.exitCode, fixed.output).toBe(0);
  expect(
    ts.transpileDeclaration(await Bun.file(sourcePath).text(), {
      fileName: sourcePath,
    }).outputText,
  ).toBe(before);
});
