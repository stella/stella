import { describe, expect, test } from "bun:test";

import { generatedRouteMap } from "./generated/route-map.js";
import type { RegistryDelta } from "./registry-cache.js";
import {
  formatRegistryDrift,
  preparseVerboseFlag,
  removedCommandError,
  shouldReportRegistryDrift,
} from "./registry-drift.js";

const delta = (over: Partial<RegistryDelta> = {}): RegistryDelta => ({
  added: [],
  removed: [],
  changed: [],
  ...over,
});

describe("shouldReportRegistryDrift", () => {
  test("a generated domain command hears about it", () => {
    expect(shouldReportRegistryDrift(["matter", "list"])).toBe(true);
    expect(shouldReportRegistryDrift(["reference", "list"])).toBe(true);
  });

  test("help, auth and compatibility do not", () => {
    expect(shouldReportRegistryDrift([])).toBe(false);
    expect(shouldReportRegistryDrift(["--help"])).toBe(false);
    expect(shouldReportRegistryDrift(["--version"])).toBe(false);
    expect(shouldReportRegistryDrift(["auth", "whoami"])).toBe(false);
    expect(shouldReportRegistryDrift(["compatibility", "check"])).toBe(false);
  });

  test("a subcommand's --help does not either: the caller is reading, not running", () => {
    expect(shouldReportRegistryDrift(["template", "create", "--help"])).toBe(
      false,
    );
    expect(shouldReportRegistryDrift(["matter", "list", "-h"])).toBe(false);
  });

  test("a `--help` after `--` is a positional argument, not a help request", () => {
    expect(shouldReportRegistryDrift(["matter", "list", "--", "--help"])).toBe(
      true,
    );
  });
});

describe("formatRegistryDrift", () => {
  test("the default is one line of counts plus how to see the names", () => {
    expect(
      formatRegistryDrift({
        delta: delta({
          removed: ["set_practice_jurisdictions", "save_clause"],
          changed: ["lookup_business_registry"],
        }),
        verbose: false,
      }),
    ).toBe(
      "server registry differs from this CLI build: 2 removed, 1 changed; re-run with --verbose to list the tools\n",
    );
  });

  test("an empty category is left out of the counts", () => {
    expect(
      formatRegistryDrift({ delta: delta({ added: ["x"] }), verbose: false }),
    ).toContain("1 added;");
  });

  test("--verbose names every tool, with no truncation", () => {
    const removed = Array.from({ length: 10 }, (_, i) => `list_gone_${i}`);
    const report = formatRegistryDrift({
      delta: delta({ removed, changed: ["list_matters"] }),
      verbose: true,
    });
    expect(report).toBe(
      [
        "server registry differs from this CLI build: 10 removed, 1 changed",
        `  removed: ${removed.join(", ")}`,
        "  changed: list_matters",
        "",
      ].join("\n"),
    );
    expect(report).not.toContain("more");
  });
});

describe("preparseVerboseFlag", () => {
  test("reads --verbose anywhere before `--`", () => {
    expect(preparseVerboseFlag(["matter", "list", "--verbose"])).toBe(true);
    expect(preparseVerboseFlag(["matter", "list"])).toBe(false);
    expect(preparseVerboseFlag(["matter", "list", "--", "--verbose"])).toBe(
      false,
    );
  });
});

describe("removedCommandError", () => {
  test("names the command and its missing tool", () => {
    const message = removedCommandError({
      argv: ["matter", "list", "--json"],
      baked: generatedRouteMap,
      delta: delta({ removed: ["list_matters"] }),
    });
    expect(message).toContain("stella matter list is not available");
    expect(message).toContain("list_matters");
    expect(message).toContain("stella tools list");
  });

  test("a capability leaf goes missing with invoke_capability", () => {
    const message = removedCommandError({
      argv: ["capability", "usage", "entitlement-get"],
      baked: generatedRouteMap,
      delta: delta({ removed: ["invoke_capability"] }),
    });
    expect(message).toContain("invoke_capability");
  });

  test("drift that does not touch this command stays silent", () => {
    expect(
      removedCommandError({
        argv: ["matter", "list"],
        baked: generatedRouteMap,
        delta: delta({ removed: ["save_clause"], changed: ["list_matters"] }),
      }),
    ).toBeUndefined();
    expect(
      removedCommandError({
        argv: ["matter"],
        baked: generatedRouteMap,
        delta: delta({ removed: ["list_matters"] }),
      }),
    ).toBeUndefined();
  });

  test("an unknown command path is stricli's to report, not this", () => {
    expect(
      removedCommandError({
        argv: ["nonsense", "list"],
        baked: generatedRouteMap,
        delta: delta({ removed: ["list_matters"] }),
      }),
    ).toBeUndefined();
  });
});
