import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import config from "../../oxlint.config.ts";
import { childExitStatus } from "../../packages/scripts/src/child-exit-status.ts";
import { canonicalDisableRuleIds } from "../../scripts/oxlint-disable-rule-ids.ts";
import {
  builtinRules,
  ruleCanonicalizer,
} from "../../scripts/oxlint-rule-ids.ts";
import { lintSingleRule, runSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(60_000);

const aliases = canonicalDisableRuleIds(config);
const options = {
  plugin: "suppression-hygiene",
  settings: { "stella/canonical-disable-rule-ids": aliases },
};
const RULE = "canonical-rule-id";

describe.serial("suppression IDs follow their configured spelling", () => {
  test("every derived alias fixes to a canonical fixed point and preserves the reason", async () => {
    const entries = Object.entries(aliases).filter(
      ([alias, canonical]) => alias !== canonical,
    );
    expect(entries.length).toBeGreaterThan(0);
    const reason = " --  keep spacing, punctuation: -- unchanged; café";
    // oxlint's JSON report for one file is cut short on Linux once it outgrows
    // a pipe buffer, so every alias is checked in batches of a bounded size.
    const BATCH = 40;
    for (let start = 0; start < entries.length; start += BATCH) {
      const batch = entries.slice(start, start + BATCH);
      const source = batch
        .map(
          ([alias]) => `// oxlint-disable-next-line ${alias}${reason}\nvoid 0;`,
        )
        .join("\n");
      const expected = batch
        .map(
          ([, canonical]) =>
            `// oxlint-disable-next-line ${canonical}${reason}\nvoid 0;`,
        )
        .join("\n");
      expect(await lintSingleRule(RULE, source, options)).toHaveLength(
        batch.length,
      );
      const fixed = await runSingleRule(RULE, source, {
        ...options,
        fix: true,
      });
      expect(fixed.source).toBe(expected);
      expect(fixed.lines).toEqual([]);
      expect(await lintSingleRule(RULE, fixed.source, options)).toEqual([]);
    }
  });

  test("all directive forms and comma lists retain their exact layout", async () => {
    const lines = [
      "// oxlint-disable-next-line eslint/no-console, typescript-eslint/no-unsafe-type-assertion --  exact reason",
      "void 0; // oxlint-disable-line eslint/no-bitwise -- inline",
      "/* oxlint-disable eslint/arrow-body-style, @typescript-eslint/no-deprecated -- block */",
      "/* oxlint-enable eslint/arrow-body-style, typescript-eslint/no-deprecated */",
      "// eslint-disable-next-line react-hooks/rules-of-hooks -- honored directive",
      "void 0;",
      "// Prose mentions oxlint-disable eslint/no-console without being a directive.",
    ];
    const source = lines.join("\n");
    expect(await lintSingleRule(RULE, source, options)).toEqual([
      1, 1, 2, 3, 3, 4, 4, 5,
    ]);
    const fixed = await runSingleRule(RULE, source, { ...options, fix: true });
    expect(fixed.source).toBe(
      source
        .replaceAll("eslint/no-console,", "no-console,")
        .replaceAll(
          "typescript-eslint/no-unsafe-type-assertion",
          "typescript/no-unsafe-type-assertion",
        )
        .replaceAll("eslint/no-bitwise", "no-bitwise")
        .replaceAll("eslint/arrow-body-style", "arrow-body-style")
        .replaceAll(
          "@typescript-eslint/no-deprecated",
          "typescript/no-deprecated",
        )
        .replaceAll(
          "typescript-eslint/no-deprecated",
          "typescript/no-deprecated",
        )
        .replaceAll("react-hooks/rules-of-hooks", "react/rules-of-hooks"),
    );
    expect(fixed.lines).toEqual([]);
  });

  test("unregistered IDs produce errors without a guessed fix", async () => {
    const source =
      "// oxlint-disable-next-line unregistered/example -- explicit reason\nvoid 0;";
    expect(await lintSingleRule(RULE, source, options)).toEqual([1]);
    const fixed = await runSingleRule(RULE, source, { ...options, fix: true });
    expect(fixed.lines).toEqual([1]);
    expect(fixed.source).toBe(source);
  });

  test("every installed built-in identity has one canonical directive spelling", () => {
    const builtins = builtinRules();
    const identity = ruleCanonicalizer(builtins);
    const installed = new Set(
      builtins.map((rule) => `${rule.scope}/${rule.value}`),
    );
    const spellings = new Map<string, Set<string>>();
    for (const [alias, canonical] of Object.entries(aliases)) {
      const id = identity(alias);
      if (!installed.has(id)) {
        continue;
      }
      expect(identity(canonical)).toBe(id);
      const names = spellings.get(id) ?? new Set<string>();
      names.add(canonical);
      spellings.set(id, names);
    }
    expect(spellings.size).toBeGreaterThan(0);
    for (const names of spellings.values()) {
      expect(names.size).toBe(1);
    }
  });

  test("the installed rule catalog resolves identically under Node and Bun", async () => {
    const output = path.join(
      import.meta.dirname,
      "../../scripts/.oxlint-rule-ids-node.mjs",
    );
    const build = await Bun.build({
      entrypoints: [
        path.join(import.meta.dirname, "../../scripts/oxlint-rule-ids.ts"),
      ],
      target: "node",
    });
    expect(build.success).toBe(true);
    const artifact = build.outputs.at(0);
    if (artifact === undefined) {
      throw new Error("Node build did not produce an artifact");
    }
    await Bun.write(output, artifact);
    const result = Bun.spawnSync([
      "node",
      "--input-type=module",
      "-e",
      `import { builtinRules } from ${JSON.stringify(pathToFileURL(output).href)}; process.stdout.write(JSON.stringify(builtinRules()));`,
    ]);
    rmSync(output, { force: true });
    expect(childExitStatus(result)).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual(builtinRules());
  });

  test("new config rules and overrides enter the lookup automatically", () => {
    const derived = canonicalDisableRuleIds({
      extends: [{ rules: { "eslint/no-console": "error" } }],
      rules: { "no-console": "error", "owner/new-rule": "error" },
      overrides: [
        {
          files: ["*.ts"],
          rules: { "typescript/no-unsafe-type-assertion": "error" },
        },
      ],
    });
    expect(derived["eslint/no-console"]).toBe("no-console");
    expect(derived["new-rule"]).toBe("owner/new-rule");
    expect(derived["typescript-eslint/no-unsafe-type-assertion"]).toBe(
      "typescript/no-unsafe-type-assertion",
    );
  });
});
