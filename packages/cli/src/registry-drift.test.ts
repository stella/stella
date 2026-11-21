import { describe, expect, test } from "bun:test";

import { generatedRouteMap } from "./generated/route-map.js";
import type { RegistryDelta } from "./registry-cache.js";
import {
  formatRegistryDrift,
  preparseVerboseFlag,
  removedCommandError,
  shouldReportRegistryDrift,
} from "./registry-drift.js";
import { commandUnavailableMessage } from "./unavailable-command.js";

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
    expect(message).toBe(
      `${commandUnavailableMessage({ type: "unknown-to-server", command: "matter list" })}\n`,
    );
  });

  test("a capability leaf goes missing with read_capability", () => {
    const message = removedCommandError({
      argv: ["capability", "usage", "entitlement-get"],
      baked: generatedRouteMap,
      delta: delta({ removed: ["read_capability"] }),
    });
    expect(message).toContain("unknown");
  });

  for (const access of ["read", "write"] as const) {
    test(`a ${access} capability depends only on its executor`, () => {
      const leaf = {
        kind: "capability-leaf",
        spec: {
          commandPath: ["operation"],
          capabilityId: "a.operation",
          access,
          flags: [],
          inputOnly: [],
          paginated: false,
          destructive: false,
          inputSchema: { type: "object" },
        },
      } as const;
      const baked = { kind: "route", children: { operation: leaf } } as const;
      const removed = `${access}_capability`;
      expect(
        removedCommandError({
          argv: ["operation"],
          baked,
          delta: delta({ removed: [removed] }),
        }),
      ).toContain("unknown");
      expect(
        removedCommandError({
          argv: ["operation"],
          baked,
          delta: delta({
            removed: [
              access === "read" ? "write_capability" : "read_capability",
            ],
          }),
        }),
      ).toBeUndefined();
    });
  }

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

  test("a validated live schema change does not imply protocol incompatibility", () => {
    expect(
      removedCommandError({
        argv: ["matter", "list"],
        baked: generatedRouteMap,
        delta: delta({ changed: ["list_matters"] }),
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

test("inherited object properties never resolve as retired command bindings", () => {
  for (const name of ["constructor", "toString", "__proto__"]) {
    expect(
      removedCommandError({
        argv: [name],
        baked: generatedRouteMap,
        delta: { added: [], changed: [], removed: ["list_matters"] },
      }),
    ).toBeUndefined();
  }
});
