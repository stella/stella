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
// Known findings carry a reason in
// scripts/oxlint-effective-config-baseline.json, which may only shrink: an
// entry that no longer matches a finding fails too.
//
// Usage: bun scripts/check-oxlint-effective-config.ts

import { panic } from "better-result";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import config from "../oxlint.config.ts";
import { BASELINE_PATHS } from "./baseline-paths.ts";
import { isRecord, repoRoot } from "./oxlint-config-scopes.ts";
import {
  checkBaseline,
  compareSeverities,
  declaredBaseRules,
  effectiveBaseRules,
  flattenLayers,
  severityOf,
  shadowedDeclarations,
} from "./oxlint-effective-config.ts";
import type { BaselineEntry, Finding } from "./oxlint-effective-config.ts";
import { builtinRules, ruleCanonicalizer } from "./oxlint-rule-ids.ts";

const CONFIG_FILE = "oxlint.config.ts";
const BASELINE_PATH = BASELINE_PATHS.oxlintEffectiveConfig;
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

const readSection = (
  parsed: Record<string, unknown>,
  section: Section,
): Record<string, BaselineEntry> => {
  const entries = parsed[section];
  if (!isRecord(entries)) {
    return panic(`${BASELINE_PATH}: "${section}" must be an object`);
  }
  return Object.fromEntries(
    Object.entries(entries).map(([rule, entry]): [string, BaselineEntry] => {
      const from = isRecord(entry) ? severityOf(entry["from"]) : undefined;
      const to = isRecord(entry) ? severityOf(entry["to"]) : undefined;
      const reason = isRecord(entry) ? entry["reason"] : undefined;
      if (
        from === undefined ||
        to === undefined ||
        typeof reason !== "string" ||
        reason.trim().length === 0
      ) {
        return panic(
          `${BASELINE_PATH}: ${section}.${rule} needs "from", "to" and a "reason"`,
        );
      }
      return [rule, { from, to, reason }];
    }),
  );
};

const baselineJson: unknown = JSON.parse(
  readFileSync(path.join(repoRoot, BASELINE_PATH), "utf-8"),
);
const parsedBaseline = isRecord(baselineJson)
  ? baselineJson
  : panic(`${BASELINE_PATH} must be an object`);

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
  ...SECTIONS.flatMap((section) => {
    const { unexpected, stale } = checkBaseline(
      findings[section],
      readSection(parsedBaseline, section),
    );
    return unexpected
      .map(
        ({ rule, from, to, detail }) =>
          `${section}: ${rule} ${from} -> ${to} (${detail})`,
      )
      .concat(
        stale.map(
          (rule) =>
            `${section}: baseline entry no longer matches, delete it: ${rule}`,
        ),
      );
  }),
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
      .join(
        "\n",
      )}\nFix the config, or record the finding with a reason in ${BASELINE_PATH}.\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `check-oxlint-effective-config: ${String(declared.rules.size)} base rules match oxlint; ${String(findings.effective.length + findings.shadowed.length)} known findings in ${BASELINE_PATH}\n`,
);
