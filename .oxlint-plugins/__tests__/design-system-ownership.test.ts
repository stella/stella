import { panic, Result } from "better-result";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "../..");
const SEARCH_INPUT_RULE = "no-decorated-search-input";
const DIALOG_FOOTER_RULE = "dialog-footer-owns-actions";
const temporaryDirectories: string[] = [];

setDefaultTimeout(20_000);

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isUnknownArray = (value: unknown): value is readonly unknown[] =>
  Array.isArray(value);

/**
 * The rule name a diagnostic reports, or null when the report shape is not the
 * one oxlint documents. Narrowed rather than asserted: the report is another
 * process's output, so its shape is a claim to check.
 */
const reportedRule = (diagnostic: unknown): string | null => {
  if (!isRecord(diagnostic) || typeof diagnostic.code !== "string") {
    return null;
  }
  const openingParenthesis = diagnostic.code.indexOf("(");
  return openingParenthesis === -1
    ? diagnostic.code
    : diagnostic.code.slice(0, openingParenthesis);
};

/**
 * The rules that fired over `source`, in report order.
 *
 * Read out of oxlint's JSON report rather than its rendered output: the
 * rendering varies with terminal and environment, and a test that parses it
 * reads as a rule regression when it drifts.
 */
const lint = async (rule: string, source: string): Promise<string[]> => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "stella-oxlint-design-system-"),
  );
  temporaryDirectories.push(directory);
  const configPath = path.join(directory, "oxlint.config.ts");
  await Bun.write(
    configPath,
    `export default ${JSON.stringify({
      categories: { correctness: "off" },
      jsPlugins: [path.join(REPOSITORY_ROOT, ".oxlint-plugins", `${rule}.ts`)],
      rules: { [`${rule}/${rule}`]: "error" },
    })};\n`,
  );
  const sourcePath = path.join(directory, "surface.tsx");
  await Bun.write(sourcePath, source);

  const spawned = Bun.spawn(
    [
      process.execPath,
      "--bun",
      "oxlint",
      "-c",
      configPath,
      "-f",
      "json",
      sourcePath,
    ],
    { cwd: REPOSITORY_ROOT, stderr: "pipe", stdout: "pipe" },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(spawned.stdout).text(),
    new Response(spawned.stderr).text(),
    spawned.exited,
  ]);
  const output = `stdout:\n${stdout}\nstderr:\n${stderr}`;
  const report = Result.try((): unknown => JSON.parse(stdout));
  if (Result.isError(report)) {
    return panic(`oxlint did not produce valid JSON:\n${output}`);
  }
  const diagnostics = isRecord(report.value)
    ? report.value.diagnostics
    : undefined;
  if (!isUnknownArray(diagnostics)) {
    return panic(`oxlint reported no diagnostics array:\n${output}`);
  }
  return diagnostics
    .map(reportedRule)
    .filter((name): name is string => name !== null);
};

const UI_IMPORTS = [
  'import { SearchIcon, SlidersHorizontalIcon } from "lucide-react";',
  'import { Input } from "@stll/ui/input";',
  'import { InputGroupAddon, InputGroupInput } from "@stll/ui/input-group";',
].join("\n");

const searchSource = (body: string): string =>
  `${UI_IMPORTS}\nexport const Surface = () => (\n${body}\n);\n`;

describe.serial(SEARCH_INPUT_RULE, () => {
  test.each([
    ['<Input className="ps-9" type="search" />'],
    ['<InputGroupInput className="h-7 pl-8" type="search" />'],
    ['<Input className="sm:ps-10" type="search" />'],
    ['<div className="relative"><SearchIcon /><Input type="search" /></div>'],
    [
      '<div><InputGroupAddon><SearchIcon /></InputGroupAddon><InputGroupInput type="search" /></div>',
    ],
    // The addon paints whichever edge its `align` names, so a trailing addon
    // duplicates the icon just as an inline-start one does.
    [
      '<div><InputGroupInput type="search" /><InputGroupAddon align="inline-end"><SearchIcon /></InputGroupAddon></div>',
    ],
  ])("reports the decoration the primitive already owns: %s", async (body) => {
    expect(await lint(SEARCH_INPUT_RULE, searchSource(body))).toEqual([
      SEARCH_INPUT_RULE,
    ]);
  });

  test.each([
    ['<Input type="search" />'],
    ['<Input className="h-7 pe-8" type="search" />'],
    ['<Input className="ps-8" type="text" />'],
    ['<div><SearchIcon /><Input type="text" /></div>'],
    [
      '<div><InputGroupAddon><SlidersHorizontalIcon /></InputGroupAddon><InputGroupInput type="search" /></div>',
    ],
    // A trailing icon is a clear or submit affordance, not the leading glyph
    // the primitive draws.
    ['<div><Input type="search" /><SearchIcon /></div>'],
  ])("accepts an undecorated search field: %s", async (body) => {
    expect(await lint(SEARCH_INPUT_RULE, searchSource(body))).toEqual([]);
  });

  test("ignores a local component that shares the primitive's name", async () => {
    const source = [
      'import { SearchIcon } from "lucide-react";',
      "const Input = (props: { className?: string; type?: string }) => <input {...props} />;",
      'export const Surface = () => (<div><SearchIcon /><Input className="ps-9" type="search" /></div>);',
      "",
    ].join("\n");

    expect(await lint(SEARCH_INPUT_RULE, source)).toEqual([]);
  });
});

const DIALOG_IMPORTS = [
  'import { Button } from "@stll/ui/button";',
  'import { DialogContent, DialogFooter } from "@stll/ui/dialog";',
  'import { Field } from "@stll/ui/field";',
  'import { SheetClose } from "@stll/ui/sheet";',
].join("\n");

const dialogSource = (body: string): string =>
  `${DIALOG_IMPORTS}\nconst items: string[] = [];\nexport const Surface = () => (\n<DialogContent>${body}</DialogContent>\n);\n`;

/** The same popup with its body extracted into a component of its own. */
const dialogBodySource = (body: string, popupExtras = ""): string =>
  `${DIALOG_IMPORTS}\nconst items: string[] = [];\nexport const Surface = () => (\n<DialogContent><Body />${popupExtras}</DialogContent>\n);\nconst Body = () => (\n${body}\n);\n`;

describe.serial(DIALOG_FOOTER_RULE, () => {
  test.each([
    ['<div className="flex gap-2"><Button /><Button /></div>'],
    ["<footer><Button /><Button /></footer>"],
    ["<section><Button /><Button /></section>"],
    // A close wrapper's `render` button is still one of the row's actions.
    ["<div><SheetClose render={<Button />} /><Button /></div>"],
    ["<div>{items.length > 0 && <Button />}<Button /></div>"],
  ])("reports a hand-rolled action row: %s", async (body) => {
    expect(await lint(DIALOG_FOOTER_RULE, dialogSource(body))).toEqual([
      DIALOG_FOOTER_RULE,
    ]);
  });

  test("reports only the innermost row, not every wrapper above it", async () => {
    const body =
      '<div className="p-6"><div className="flex gap-2"><Button /><Button /></div></div>';

    expect(await lint(DIALOG_FOOTER_RULE, dialogSource(body))).toEqual([
      DIALOG_FOOTER_RULE,
    ]);
  });

  test.each([
    ["<DialogFooter><Button /><Button /></DialogFooter>"],
    ["<DialogFooter><div><Button /><Button /></div></DialogFooter>"],
    ["<Field><div><Button /><Button /></div></Field>"],
    ["<div><Button /></div>"],
    // Per-item buttons in a list are not a single action row.
    ["<div>{items.map((item) => <Button key={item} />)}</div>"],
    // Nor are per-item hover actions rendered from the same callback.
    [
      "<div>{items.map((item) => <div key={item}><Button /><Button /></div>)}</div>",
    ],
    // A popup whose footer already owns the action row: the loose pair is a
    // segmented body control.
    [
      '<div className="flex gap-2"><Button /><Button /></div><DialogFooter><Button /></DialogFooter>',
    ],
  ])("accepts an owned or non-action row: %s", async (body) => {
    expect(await lint(DIALOG_FOOTER_RULE, dialogSource(body))).toEqual([]);
  });

  test("reports a hand-rolled row in the popup's body component", async () => {
    const body =
      '<><p>copy</p><div className="flex gap-2"><Button /><Button /></div></>';

    expect(await lint(DIALOG_FOOTER_RULE, dialogBodySource(body))).toEqual([
      DIALOG_FOOTER_RULE,
    ]);
  });

  test.each([
    // The body component mounts the footer itself.
    ["<DialogFooter><Button /><Button /></DialogFooter>", ""],
    // The popup mounts it, so the body's pair is a segmented body control.
    [
      '<div className="flex gap-2"><Button /><Button /></div>',
      "<DialogFooter><Button /></DialogFooter>",
    ],
    // A view's root container holds content beside its actions.
    [
      '<div className="flex flex-col gap-4"><h3>x</h3><Button /><Button /></div>',
      "",
    ],
  ])(
    "accepts an owned or non-action row in a body component: %s",
    async (body, popupExtras) => {
      expect(
        await lint(DIALOG_FOOTER_RULE, dialogBodySource(body, popupExtras)),
      ).toEqual([]);
    },
  );

  test("ignores a container that holds content beside its actions", async () => {
    const body =
      '<div className="flex flex-col gap-4"><h3>x</h3><Button /><Button /></div>';

    expect(await lint(DIALOG_FOOTER_RULE, dialogSource(body))).toEqual([]);
  });

  test("ignores a card nested in the popup's own body layout", async () => {
    const source = [
      DIALOG_IMPORTS,
      "export const Surface = () => (",
      '<DialogContent><div className="p-4"><Card /></div></DialogContent>',
      ");",
      "const Card = () => (",
      '<div className="rounded-md border p-3"><div className="flex gap-2"><Button /><Button /></div></div>',
      ");",
      "",
    ].join("\n");

    expect(await lint(DIALOG_FOOTER_RULE, source)).toEqual([]);
  });

  test("ignores the same row outside a dialog popup", async () => {
    const source = [
      'import { Button } from "@stll/ui/button";',
      'export const Surface = () => (<div className="flex gap-2"><Button /><Button /></div>);',
      "",
    ].join("\n");

    expect(await lint(DIALOG_FOOTER_RULE, source)).toEqual([]);
  });
});
