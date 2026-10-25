import { describe, expect, test } from "bun:test";

import {
  movedSources,
  planVariant,
  renderPlan,
  type TestFlightBuild,
} from "./release-plan";

const fingerprint = (
  hash: string,
  sources: { source: string; hash: string }[],
) => ({
  hash,
  sources: sources.map((source) => ({ ...source, type: "file" as const })),
});

const head = fingerprint("head", [
  { source: "app.config.ts", hash: "a2" },
  { source: "ios/Podfile", hash: "p1" },
  { source: "node_modules/expo-camera", hash: "c1" },
]);

const build = (
  fingerprintAtBuild: TestFlightBuild["fingerprint"],
): TestFlightBuild => ({
  sha: "0123456789abcdef0123456789abcdef01234567",
  url: "https://github.com/stella/stella/actions/runs/1",
  fingerprint: fingerprintAtBuild,
});

describe("moved sources", () => {
  test("names added, removed and changed sources, and nothing else", () => {
    const base = fingerprint("base", [
      { source: "app.config.ts", hash: "a1" },
      { source: "ios/Podfile", hash: "p1" },
      { source: "node_modules/expo-haptics", hash: "h1" },
    ]);
    expect(movedSources(head, base)).toEqual([
      { source: "app.config.ts", type: "file", change: "changed" },
      { source: "node_modules/expo-camera", type: "file", change: "added" },
      { source: "node_modules/expo-haptics", type: "file", change: "removed" },
    ]);
  });
});

describe("variant plan", () => {
  test("a variant without a TestFlight build needs its first one", () => {
    expect(planVariant("production", head, undefined)).toEqual({
      kind: "first-build",
      variant: "production",
      fingerprint: "head",
    });
  });

  test("a build whose native code matches takes an over-the-air update", () => {
    const current = build(head);
    expect(planVariant("preview", head, current)).toEqual({
      kind: "update",
      variant: "preview",
      fingerprint: "head",
      build: current,
    });
  });

  test("a native change needs a new build, naming what moved", () => {
    const stale = build(
      fingerprint("base", [
        { source: "app.config.ts", hash: "a2" },
        { source: "ios/Podfile", hash: "p0" },
        { source: "node_modules/expo-camera", hash: "c1" },
      ]),
    );
    expect(planVariant("preview", head, stale)).toEqual({
      kind: "build",
      variant: "preview",
      fingerprint: "head",
      build: stale,
      moved: [{ source: "ios/Podfile", type: "file", change: "changed" }],
    });
  });

  test("a build from before native fingerprints needs a new build", () => {
    expect(planVariant("preview", head, build(null))).toMatchObject({
      kind: "build",
      moved: [],
    });
  });
});

describe("rendered plan", () => {
  test("names the workflow each variant needs", () => {
    const rendered = renderPlan([
      planVariant("preview", head, build(head)),
      planVariant("production", head, build(null)),
    ]);
    expect(rendered).toContain(
      "- **preview** iOS fingerprint at this commit: `head`\n  - native code matches the [TestFlight build](https://github.com/stella/stella/actions/runs/1) from `012345678`. Run _Publish Mobile Update_ (preview)",
    );
    expect(rendered).toContain(
      "- **production** iOS fingerprint at this commit: `head`\n  - native code changed since the [TestFlight build]",
    );
    expect(rendered).toContain("that build predates native fingerprints");
  });
});
