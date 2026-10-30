import { panic } from "better-result";
import { expect, test } from "bun:test";

import { loadBakedCapabilityCatalog } from "./capability-catalog-load.js";
import { projectFeatureCommands } from "./feature-command-projection.js";
import { buildCliRouteTree } from "./generate-capability-tree.js";
import { generatedRouteMap } from "./generated/route-map.js";
import { unavailableCommandError } from "./unavailable-command.js";

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
  expect(unavailableCommandError({ argv, baked, current })).toBe(
    "Command 'capability lists verifications-get' is not enabled for this organization (feature: list-verification). Check the organization's enabled features and your access.\n",
  );
  for (const serverArgs of [
    ["--server", "https://example.invalid"],
    ["--server=https://example.invalid"],
  ]) {
    expect(
      unavailableCommandError({
        argv: [...serverArgs, ...argv],
        baked,
        current,
      }),
    ).toBe(unavailableCommandError({ argv, baked, current }));
  }
  expect(
    unavailableCommandError({ argv, baked, current: baked }),
  ).toBeUndefined();
  expect(
    unavailableCommandError({
      argv: ["capability", "lists", "verifications-gte"],
      baked,
      current,
    }),
  ).toBeUndefined();
  expect(
    unavailableCommandError({
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
    const message = unavailableCommandError({
      argv,
      baked: generatedRouteMap,
      current,
    });
    expect(message).toContain("not enabled for this organization");
    expect(message).toContain("feature:");
    expect(message).not.toContain("Unknown tool");
    expect(message).not.toContain("too old");
  }
});

test("unknown paths including inherited object names remain ordinary unknown commands", () => {
  for (const name of ["constructor", "toString", "__proto__"]) {
    expect(
      unavailableCommandError({
        argv: [name],
        baked: generatedRouteMap,
        current: generatedRouteMap,
      }),
    ).toBeUndefined();
    expect(
      unavailableCommandError({
        argv: ["matter", name],
        baked: generatedRouteMap,
        current: generatedRouteMap,
      }),
    ).toBeUndefined();
  }
});
