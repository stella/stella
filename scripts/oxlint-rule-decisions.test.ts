// Guard: preset rules this repository keeps off on purpose stay off, and the
// rules it narrows still catch what they exist for, however the presets and
// oxlint.config.ts combine.

import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import config from "../oxlint.config.ts";
import {
  SEVERITY,
  declaredBaseRules,
  flattenLayers,
} from "./oxlint-effective-config.ts";
import { builtinRules, ruleCanonicalizer } from "./oxlint-rule-ids.ts";

const repositoryRoot = path.resolve(import.meta.dir, "..");

test("keeps oxc/no-map-spread off: object spread is the one record-copy form", () => {
  const builtins = builtinRules();
  const { rules } = declaredBaseRules({
    layers: flattenLayers(config, "oxlint.config.ts"),
    builtins,
    canonical: ruleCanonicalizer(builtins),
  });

  expect(rules.get("oxc/no-map-spread")?.severity ?? SEVERITY.off).toBe(
    SEVERITY.off,
  );
});

const USE_BEFORE_DEFINE = "eslint/no-use-before-define";
const UseBeforeDefineReport = v.object({
  diagnostics: v.array(v.object({ code: v.string(), message: v.string() })),
});

/** The repository's no-use-before-define findings for one source file. */
const useBeforeDefineFindings = async (
  fileName: string,
  lines: readonly string[],
): Promise<string[]> => {
  const directory = await mkdtemp(path.join(tmpdir(), "stella-oxlint-tdz-"));
  try {
    const configPath = path.join(directory, "oxlint.config.ts");
    const input = path.join(directory, fileName);
    await Bun.write(
      configPath,
      `export default ${JSON.stringify({
        categories: { correctness: "off" },
        rules: { [USE_BEFORE_DEFINE]: config.rules[USE_BEFORE_DEFINE] },
      })};`,
    );
    await Bun.write(input, lines.join("\n"));
    const lint = Bun.spawn(
      ["bun", "--bun", "oxlint", "-c", configPath, "--format", "json", input],
      { cwd: repositoryRoot, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout] = await Promise.all([
      new Response(lint.stdout).text(),
      lint.exited,
    ]);
    return v
      .parse(UseBeforeDefineReport, JSON.parse(stdout))
      .diagnostics.map(({ code, message }) => `${code}: ${message}`)
      .toSorted();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

test("no-use-before-define reports temporal dead zone reads, not hoisted function calls", async () => {
  const findings = await useBeforeDefineFindings("input.ts", [
    "export const early = late;",
    "const late = 1;",
    "export const made = new Widget();",
    "class Widget {}",
    "export const run = () => helper();",
    "function helper() {",
    "  return 1;",
    "}",
  ]);

  expect(findings).toEqual([
    "eslint(no-use-before-define): 'Widget' was used before it was defined.",
    "eslint(no-use-before-define): 'late' was used before it was defined.",
  ]);
});

// The React convention (.ai/shared/modules/react.md) puts the root component
// first: helpers below it pass, whether function declarations (hoisted) or
// `const` arrows read only when the component renders.
test("a helper below the root component passes as a function declaration or a const arrow", async () => {
  const findings = await useBeforeDefineFindings("card.tsx", [
    "export const Card = ({ title }: { title: string }) => (",
    "  <section>",
    "    <Heading text={title} />",
    "    {formatCount(2)}",
    "  </section>",
    ");",
    "function Heading({ text }: { text: string }) {",
    "  return <h2>{text}</h2>;",
    "}",
    "const formatCount = (count: number) => String(count);",
  ]);

  expect(findings).toEqual([]);
});
