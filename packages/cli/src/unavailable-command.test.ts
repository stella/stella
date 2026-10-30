import { panic } from "better-result";
import { expect, test } from "bun:test";

import { loadBakedCapabilityCatalog } from "./capability-catalog-load.js";
import { projectFeatureCommands } from "./feature-command-projection.js";
import { buildCliRouteTree } from "./generate-capability-tree.js";
import { generatedRouteMap } from "./generated/route-map.js";
import {
  commandUnavailableMessage,
  resolveCommandUnavailableCause,
} from "./unavailable-command.js";
import type { CommandUnavailableCause } from "./unavailable-command.js";

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
        argv: [...serverArgs, ...argv],
        baked,
        current,
        evidence: featureEvidence,
      }),
    ).toEqual(
      resolveCommandUnavailableCause({
        argv,
        baked,
        current,
        evidence: featureEvidence,
      }),
    );
  }
  expect(
    resolveCommandUnavailableCause({ argv, baked, current: baked }),
  ).toBeUndefined();
  expect(
    resolveCommandUnavailableCause({
      argv: ["capability", "lists", "verifications-gte"],
      baked,
      current,
    }),
  ).toBeUndefined();
  expect(
    resolveCommandUnavailableCause({
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
        argv: [name],
        baked: generatedRouteMap,
        current: generatedRouteMap,
      }),
    ).toBeUndefined();
    expect(
      resolveCommandUnavailableCause({
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
    token: "opaque-token",
    serverUrl: "https://example.invalid",
  };
  const missing = resolveCommandUnavailableCause({
    ...options,
    evidence: {
      grantedScopes: ["openid", "stella:search"],
      scopeOmittedTools: ["list_matters"],
    },
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
      evidence: { grantedScopes: ["stella:read"] },
    }),
  ).toEqual({ type: "unknown-to-server", command: "matter list" });
  expect(
    resolveCommandUnavailableCause({
      ...options,
      argv: ["time-entry", "list"],
      evidence: {
        grantedScopes: [],
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
      evidence: { grantedScopes: ["stella:search"] },
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
      evidence: { grantedScopes: ["stella:read"] },
    };
    expect(
      resolveCommandUnavailableCause({ ...options, featureAccess }),
    ).toEqual({ type: "feature-disabled", command: argv.join(" "), feature });
    expect(
      resolveCommandUnavailableCause({
        ...options,
        featureAccess: { tools: [], capabilities: [] },
      }),
    ).toEqual({ type: "unknown-to-server", command: argv.join(" ") });
  }
});
