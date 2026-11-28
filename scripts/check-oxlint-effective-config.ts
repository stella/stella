// Fails when the oxlint severities this repository declares are not the ones
// it gets, in two ways:
//
// - effective: a base rule's severity, merged from oxlint.config.ts and its
//   presets as scripts/oxlint-effective-config.ts documents, differs from the
//   severity `oxlint --print-config` resolves. A plugin missing from
//   `plugins`, a spelling oxlint reads as another rule, or a precedence the
//   config's readers assume but oxlint does not apply would otherwise leave a
//   rule silently off (or on).
// - shadowed: a vendored preset states a severity that another preset, or a
//   spread in oxlint.config.ts, replaces without oxlint.config.ts naming the
//   rule. The preset file then reads "off" for a rule that is on, or "error"
//   for one that is off.
//
// Usage: bun scripts/check-oxlint-effective-config.ts

import { panic } from "better-result";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import config from "../oxlint.config.ts";
import { repoRoot } from "./oxlint-config-scopes.ts";
import {
  compareSeverities,
  declaredBaseRules,
  effectiveBaseRules,
  flattenLayers,
  shadowedDeclarations,
} from "./oxlint-effective-config.ts";
import type { Finding } from "./oxlint-effective-config.ts";
import { builtinRules, ruleCanonicalizer } from "./oxlint-rule-ids.ts";

const CONFIG_FILE = "oxlint.config.ts";
const SECTIONS = ["effective", "shadowed"] as const;
type Section = (typeof SECTIONS)[number];

const printConfig = (): unknown => {
  // The output goes to a file: a piped stdout from the Node shim can be cut
  // short when the process exits before the pipe drains.
  const directory = mkdtempSync(path.join(tmpdir(), "oxlint-print-config-"));
  const output = path.join(directory, "config.json");
  const result = Bun.spawnSync(
    ["bun", "--bun", "oxlint", "-c", CONFIG_FILE, "--print-config"],
    { cwd: repoRoot, stdout: Bun.file(output), stderr: "inherit" },
  );
  const text = result.success ? readFileSync(output, "utf-8") : undefined;
  rmSync(directory, { recursive: true, force: true });
  if (text === undefined) {
    return panic("oxlint --print-config failed");
  }
  return JSON.parse(text);
};

// Keys written literally in the top-level `rules` block, the same block
// check-oxlint-rule-decisions reads; spread entries have no line of their own.
const LITERAL_RULE_KEY = /^ {4}(?:"([^"]+)"|([\w-]+)): /u;
const literalRootKeys = (): string[] => {
  const lines = readFileSync(path.join(repoRoot, CONFIG_FILE), "utf-8").split(
    "\n",
  );
  const start = lines.indexOf("  rules: {");
  const end = lines.indexOf("  },", start);
  if (start === -1 || end === -1) {
    return panic(`${CONFIG_FILE} has no top-level \`rules: {\` block`);
  }
  return lines.slice(start + 1, end).flatMap((line) => {
    const match = LITERAL_RULE_KEY.exec(line);
    return match ? [match[1] ?? match[2] ?? ""] : [];
  });
};

const builtins = builtinRules();
const canonical = ruleCanonicalizer(builtins);
const declared = declaredBaseRules({
  layers: flattenLayers(config, CONFIG_FILE),
  builtins,
  canonical,
});
const effective =
  effectiveBaseRules(printConfig(), canonical) ??
  panic("oxlint --print-config printed no readable `rules` object");

const findings: Record<Section, Finding[]> = {
  effective: compareSeverities({
    declared: declared.rules,
    effective,
    skip: new Set(declared.aliasConflicts.map(({ rule }) => rule)),
  }),
  shadowed: shadowedDeclarations({
    declared,
    visibleLayer: CONFIG_FILE,
    visibleRules: new Set(literalRootKeys().map(canonical)),
  }),
};

const failures = [
  ...SECTIONS.flatMap((section) =>
    findings[section].map(
      ({ rule, from, to, detail }) =>
        `${section}: ${rule} ${from} -> ${to} (${detail})`,
    ),
  ),
  ...declared.aliasConflicts.map(
    ({ rule, layer, keys }) =>
      `${layer} names ${rule} as ${keys.join(" and ")} with different values; oxlint keeps one by key order`,
  ),
  ...declared.invalidKeys.map(
    ({ key, layer, reason }) => `${layer}: ${key} ${reason}`,
  ),
];

if (failures.length > 0) {
  process.stderr.write(
    `check-oxlint-effective-config: ${String(failures.length)} problem(s)\n${failures
      .map((failure) => `  ${failure}`)
      .join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `check-oxlint-effective-config: ${String(declared.rules.size)} base rules match oxlint.\n`,
);
