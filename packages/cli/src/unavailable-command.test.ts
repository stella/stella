import { panic } from "better-result";
import { expect, test } from "bun:test";

import { resolveEffectiveGrants } from "./auth/command-scopes.js";
import { loadBakedCapabilityCatalog } from "./capability-catalog-load.js";
import { projectFeatureCommands } from "./feature-command-projection.js";
import { buildCliRouteTree } from "./generate-capability-tree.js";
import { generatedRouteMap } from "./generated/route-map.js";
import {
  commandUnavailableMessage,
  resolveCommandUnavailableCause,
} from "./unavailable-command.js";
import type { CommandUnavailableCause } from "./unavailable-command.js";

const unknownGrants = resolveEffectiveGrants({});

const featureEvidence = {
  featureOmittedTools: ["list_time_entries", "list_invoices", "resolve_rate"],
  featureOmittedCapabilities: ["lists.verifications.get"],
};

test("known omitted commands name organization availability and the owning feature", () => {
  const entries = loadBakedCapabilityCatalog();
  if (entries === null) {
    panic("Expected baked capability catalogue");
  }
  const baked = buildCliRouteTree({
    listings: [],
    entries,
    annotations: {},
  }).tree;
  const current = projectFeatureCommands({
    tree: baked,
    featureAccess: undefined,
  });
  const argv = ["capability", "lists", "verifications-get", "--help"];
  expect(
    resolveCommandUnavailableCause({
      effectiveGrants: unknownGrants,
      argv,
      baked,
      current,
      evidence: featureEvidence,
    }),
  ).toEqual({
    type: "feature-disabled",
    command: "capability lists verifications-get",
    feature: "list-verification",
  });
  for (const serverArgs of [
    ["--server", "https://example.invalid"],
    ["--server=https://example.invalid"],
  ]) {
    expect(
      resolveCommandUnavailableCause({
        effectiveGrants: unknownGrants,
        argv: [...serverArgs, ...argv],
        baked,
        current,
        evidence: featureEvidence,
      }),
    ).toEqual(
      resolveCommandUnavailableCause({
        effectiveGrants: unknownGrants,
        argv,
        baked,
        current,
        evidence: featureEvidence,
      }),
    );
  }
  expect(
    resolveCommandUnavailableCause({
      effectiveGrants: unknownGrants,
      argv,
      baked,
      current: baked,
    }),
  ).toBeUndefined();
  expect(
    resolveCommandUnavailableCause({
      effectiveGrants: unknownGrants,
      argv: ["capability", "lists", "verifications-gte"],
      baked,
      current,
    }),
  ).toBeUndefined();
  expect(
    resolveCommandUnavailableCause({
      effectiveGrants: unknownGrants,
      argv: ["capability", "lists", "--help"],
      baked,
      current,
    }),
  ).toBeUndefined();
});

test("time, invoice, and rate omissions explain that the organization has not enabled them", () => {
  const current = projectFeatureCommands({
    tree: generatedRouteMap,
    featureAccess: undefined,
  });
  for (const argv of [
    ["time-entry", "list"],
    ["invoice", "list"],
    ["rate", "resolve"],
  ]) {
    const message = resolveCommandUnavailableCause({
      effectiveGrants: unknownGrants,
      argv,
      baked: generatedRouteMap,
      current,
      evidence: featureEvidence,
    });
    expect(message?.type).toBe("feature-disabled");
    if (message !== undefined) {
      expect(commandUnavailableMessage(message)).toContain(
        "not enabled for this organization",
      );
      expect(commandUnavailableMessage(message)).toContain("feature:");
      expect(commandUnavailableMessage(message)).not.toContain("Unknown tool");
      expect(commandUnavailableMessage(message)).not.toContain("too old");
    }
  }
});

test("unknown paths including inherited object names remain ordinary unknown commands", () => {
  for (const name of ["constructor", "toString", "__proto__"]) {
    expect(
      resolveCommandUnavailableCause({
        effectiveGrants: unknownGrants,
        argv: [name],
        baked: generatedRouteMap,
        current: generatedRouteMap,
      }),
    ).toBeUndefined();
    expect(
      resolveCommandUnavailableCause({
        effectiveGrants: unknownGrants,
        argv: ["matter", name],
        baked: generatedRouteMap,
        current: generatedRouteMap,
      }),
    ).toBeUndefined();
  }
});

test("unavailable messages preserve four distinct causes", () => {
  const cases = [
    {
      cause: {
        type: "missing-scope",
        scope: "stella:read",
        loginCommand: "stella auth login --scopes stella:read",
      },
      expected:
        "Missing scope stella:read. Re-run 'stella auth login --scopes stella:read' to grant the complete scope set.",
    },
    {
      cause: {
        type: "feature-disabled",
        command: "time-entry list",
        feature: "time-billing",
      },
      expected:
        "Command 'time-entry list' is not enabled for this organization (feature: time-billing).",
    },
    {
      cause: {
        type: "protocol-incompatible",
        message: "The server requires CLI 99.0.0.",
      },
      expected:
        "Server protocol is incompatible. The server requires CLI 99.0.0.",
    },
    {
      cause: { type: "unknown-to-server", command: "matter list" },
      expected: "Command 'matter list' is unknown to this server.",
    },
  ] as const satisfies readonly {
    cause: CommandUnavailableCause;
    expected: string;
  }[];
  for (const { cause, expected } of cases) {
    expect(commandUnavailableMessage(cause)).toBe(expected);
  }
});

test("opaque callers use server grants while missing evidence never implies a disabled feature", () => {
  const current = { kind: "route", children: {} } as const;
  const options = {
    argv: ["matter", "list"],
    baked: generatedRouteMap,
    current,
    effectiveGrants: unknownGrants,
    serverUrl: "https://example.invalid",
  };
  const missing = resolveCommandUnavailableCause({
    ...options,
    effectiveGrants: resolveEffectiveGrants({
      registry: { grantedScopes: ["openid", "stella:search"] },
    }),
    evidence: {},
  });
  expect(missing).toEqual({
    type: "missing-scope",
    scope: "stella:read",
    loginCommand:
      "stella auth login --scopes stella:search,stella:read --server https://example.invalid",
  });
  expect(resolveCommandUnavailableCause(options)).toBeUndefined();
  expect(
    resolveCommandUnavailableCause({
      ...options,
      effectiveGrants: resolveEffectiveGrants({
        registry: { grantedScopes: ["stella:read"] },
      }),
      evidence: {},
    }),
  ).toEqual({ type: "unknown-to-server", command: "matter list" });
  expect(
    resolveCommandUnavailableCause({
      ...options,
      argv: ["time-entry", "list"],
      effectiveGrants: resolveEffectiveGrants({
        registry: { grantedScopes: [] },
      }),
      evidence: {
        featureOmittedTools: ["list_time_entries"],
      },
    }),
  ).toEqual({
    type: "feature-disabled",
    command: "time-entry list",
    feature: "time-billing",
  });
  expect(
    resolveCommandUnavailableCause({
      ...options,
      current: generatedRouteMap,
      effectiveGrants: resolveEffectiveGrants({
        registry: { grantedScopes: ["stella:search"] },
      }),
      evidence: {},
    })?.type,
  ).toBe("missing-scope");
});

test("explicit caller enrolment denials distinguish disabled tools and capabilities from unknown visibility", () => {
  const current = { kind: "route", children: {} } as const;
  const featureAccess = {
    tools: [],
    capabilities: [],
    disabled: {
      tools: ["list_time_entries"],
      capabilities: ["lists.verifications.get"],
    },
  };
  for (const [argv, feature] of [
    [["time-entry", "list"], "time-billing"],
    [["capability", "lists", "verifications-get"], "list-verification"],
  ] as const) {
    const options = {
      argv,
      baked: generatedRouteMap,
      current,
      effectiveGrants: resolveEffectiveGrants({
        registry: { grantedScopes: ["stella:read"] },
      }),
      evidence: {},
    };
    expect(
      resolveCommandUnavailableCause({
        ...options,
        featureAccess,
      }),
    ).toEqual({ type: "feature-disabled", command: argv.join(" "), feature });
    expect(
      resolveCommandUnavailableCause({
        ...options,
        featureAccess: { tools: [], capabilities: [] },
      }),
    ).toEqual({ type: "unknown-to-server", command: argv.join(" ") });
  }
});

for (const flag of ["--help", "-h", "--schema"]) {
  test(`visible command ${flag} describes the binding without requiring execution grants`, () => {
    const options = {
      argv: ["template", "save-filled", "new-version", flag],
      baked: generatedRouteMap,
      current: generatedRouteMap,
      effectiveGrants: resolveEffectiveGrants({
        registry: { grantedScopes: ["stella:documents_write"] },
      }),
    };
    expect(resolveCommandUnavailableCause(options)).toBeUndefined();
    expect(
      resolveCommandUnavailableCause({
        ...options,
        current: { kind: "route", children: {} },
      }),
    ).toMatchObject({ type: "missing-scope", scope: "stella:templates" });
    expect(
      resolveCommandUnavailableCause({
        ...options,
        argv: ["template", "save-filled", "new-version", "--", flag],
      }),
    ).toMatchObject({ type: "missing-scope", scope: "stella:templates" });
    expect(
      resolveCommandUnavailableCause({
        ...options,
        evidence: { featureOmittedTools: ["save_filled_template"] },
      }),
    ).toMatchObject({ type: "feature-disabled" });
  });
}
