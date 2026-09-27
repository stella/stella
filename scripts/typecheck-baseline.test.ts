import { expect, test } from "bun:test";

import { compareField, deltaDiffs, diffAll } from "./typecheck-baseline";

test("a change is compared with its merge base even when main has used the committed budget", () => {
  const committed = {
    api: { types: 1_000_000, instantiations: 8_000_000 },
    web: { types: 1_000_000, instantiations: 8_000_000 },
    "web-e2e": { types: 40_000, instantiations: 60_000 },
  } as const;
  const base = {
    api: { types: 1_100_000, instantiations: 9_000_000 },
    web: { types: 1_000_000, instantiations: 8_000_000 },
    "web-e2e": { types: 40_000, instantiations: 60_000 },
  } as const;
  const head = [
    {
      id: "api",
      counters: { types: 1_110_000, instantiations: 9_010_000 },
      context: "",
    },
    {
      id: "web",
      counters: { types: 1_000_000, instantiations: 8_000_000 },
      context: "",
    },
    {
      id: "web-e2e",
      counters: { types: 40_000, instantiations: 60_000 },
      context: "",
    },
  ] as const;

  expect(
    diffAll(head, committed).some((diff) => diff.status === "regressed"),
  ).toBe(true);
  expect(
    diffAll(head, base).filter((diff) => diff.status === "regressed"),
  ).toEqual([]);
});

test("the delta gate isolates a new explosion in one project and field", () => {
  const base = {
    api: { types: 1_000_000, instantiations: 8_000_000 },
    web: { types: 1_000_000, instantiations: 8_000_000 },
    "web-e2e": { types: 40_000, instantiations: 60_000 },
  } as const;
  const head = [
    {
      id: "api",
      counters: { types: 1_000_000, instantiations: 8_000_000 },
      context: "",
    },
    {
      id: "web",
      counters: { types: 1_010_000, instantiations: 16_000_000 },
      context: "",
    },
    {
      id: "web-e2e",
      counters: { types: 40_000, instantiations: 60_000 },
      context: "",
    },
  ] as const;

  expect(
    diffAll(head, base)
      .filter((diff) => diff.status === "regressed")
      .map((diff) => `${diff.id}.${diff.field}`),
  ).toEqual(["web.instantiations"]);
});

test("the per-change allowance uses the larger of percentage and floor", () => {
  expect(compareField("types", 1_050_000, 1_000_000)).toBe("ok");
  expect(compareField("types", 1_050_001, 1_000_000)).toBe("regressed");
  expect(compareField("types", 60_000, 40_000)).toBe("ok");
  expect(compareField("types", 60_001, 40_000)).toBe("regressed");
  expect(compareField("instantiations", 160_000, 60_000)).toBe("ok");
  expect(compareField("instantiations", 160_001, 60_000)).toBe("regressed");
});

test("a project new in the change is left to the committed budget", () => {
  const base = {
    api: { types: 1_000_000, instantiations: 8_000_000 },
    web: { types: 1_000_000, instantiations: 8_000_000 },
    "web-e2e": { types: 0, instantiations: 0 },
  } as const;
  const head = [
    {
      id: "api",
      counters: { types: 1_000_000, instantiations: 8_000_000 },
      context: "",
    },
    {
      id: "web-e2e",
      counters: { types: 40_000, instantiations: 60_000 },
      context: "",
    },
  ] as const;

  expect(deltaDiffs(head, base).map((diff) => diff.id)).toEqual(["api", "api"]);
  expect(
    diffAll(head, base).some(
      (diff) => diff.id === "web-e2e" && diff.status === "regressed",
    ),
  ).toBe(true);
});
