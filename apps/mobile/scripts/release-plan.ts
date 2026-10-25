// What each variant's next release needs after a merge to main: an
// over-the-air update, when the merge's native fingerprint
// (scripts/fingerprint.ts) still matches the variant's latest TestFlight
// build, or a new TestFlight build first, when it does not.
//
// The plan only reports; it publishes and builds nothing. The release
// workflows stay manual and reviewed, and the plan names the one to run.
//
// Usage (the release plan workflow runs this):
//   bun scripts/release-plan.ts <dir>
// where <dir> holds, for each variant, `head-<variant>.json`, the merge's
// iOS fingerprint as `fingerprint.ts ios --json` prints it under that
// variant, and, when the variant has a TestFlight build,
// `build-<variant>.json`: the build's commit, run link and fingerprint at
// that commit (null when the commit predates the fingerprint script). The
// variant's name and identifier are part of its fingerprint, so each
// variant is fingerprinted on its own.

import { panic } from "better-result";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import type { FingerprintSourceHash } from "./fingerprint";

/** The variants that ship through TestFlight. */
const RELEASED_VARIANTS = ["preview", "production"] as const;

type ReleasedVariant = (typeof RELEASED_VARIANTS)[number];

const fingerprintSchema = v.object({
  hash: v.string(),
  sources: v.array(
    v.object({
      source: v.string(),
      type: v.picklist(["file", "dir", "contents"]),
      hash: v.nullable(v.string()),
    }),
  ),
});

type NativeFingerprint = v.InferOutput<typeof fingerprintSchema>;

const buildSchema = v.object({
  sha: v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/u)),
  url: v.pipe(v.string(), v.url()),
  fingerprint: v.nullable(fingerprintSchema),
});

export type TestFlightBuild = v.InferOutput<typeof buildSchema>;

/** A source that differs between two fingerprints, and how. */
type MovedSource = {
  readonly source: string;
  readonly type: FingerprintSourceHash["type"];
  readonly change: "added" | "removed" | "changed";
};

type PlanTarget = {
  readonly variant: ReleasedVariant;
  /** The merge's fingerprint under this variant. */
  readonly fingerprint: string;
};

type VariantPlan = PlanTarget &
  (
    | { readonly kind: "first-build" }
    | { readonly kind: "update"; readonly build: TestFlightBuild }
    | {
        readonly kind: "build";
        readonly build: TestFlightBuild;
        readonly moved: readonly MovedSource[];
      }
  );

export const movedSources = (
  head: NativeFingerprint,
  base: NativeFingerprint,
): MovedSource[] => {
  const headSources = new Map(head.sources.map((s) => [s.source, s]));
  const baseSources = new Map(base.sources.map((s) => [s.source, s]));
  // The merge's sources in fingerprint order, then the ones it no longer has.
  const names = new Set([...headSources.keys(), ...baseSources.keys()]);
  return [...names].flatMap((name): MovedSource[] => {
    const now = headSources.get(name);
    const before = baseSources.get(name);
    if (now === undefined) {
      return before === undefined
        ? []
        : [{ source: name, type: before.type, change: "removed" }];
    }
    if (before === undefined) {
      return [{ source: name, type: now.type, change: "added" }];
    }
    return now.hash === before.hash
      ? []
      : [{ source: name, type: now.type, change: "changed" }];
  });
};

export const planVariant = (
  variant: ReleasedVariant,
  head: NativeFingerprint,
  build: TestFlightBuild | undefined,
): VariantPlan => {
  const target = { variant, fingerprint: head.hash };
  if (build === undefined) {
    return { ...target, kind: "first-build" };
  }
  if (build.fingerprint?.hash === head.hash) {
    return { ...target, kind: "update", build };
  }
  return {
    ...target,
    kind: "build",
    build,
    moved:
      build.fingerprint === null ? [] : movedSources(head, build.fingerprint),
  };
};

const shortSha = (sha: string): string => sha.slice(0, 9);

export const renderPlan = (plans: readonly VariantPlan[]): string => {
  const lines = ["## Mobile release plan", ""];
  for (const plan of plans) {
    lines.push(
      `- **${plan.variant}** iOS fingerprint at this commit: \`${plan.fingerprint}\``,
    );
    switch (plan.kind) {
      case "first-build":
        lines.push(
          `  - no TestFlight build yet. Run _Release Mobile iOS_ (${plan.variant}) to ship the first one.`,
        );
        break;
      case "update":
        lines.push(
          `  - native code matches the [TestFlight build](${plan.build.url}) from \`${shortSha(plan.build.sha)}\`. Run _Publish Mobile Update_ (${plan.variant}) to ship this commit over the air.`,
        );
        break;
      case "build":
        lines.push(
          `  - native code changed since the [TestFlight build](${plan.build.url}) from \`${shortSha(plan.build.sha)}\`; updates from this commit cannot reach it. Run _Release Mobile iOS_ (${plan.variant}), then publish updates again.`,
        );
        if (plan.build.fingerprint === null) {
          lines.push("    - that build predates native fingerprints");
        }
        for (const moved of plan.moved) {
          lines.push(
            `    - ${moved.type} \`${moved.source}\`${moved.change === "changed" ? "" : ` (${moved.change})`}`,
          );
        }
        break;
    }
  }
  return `${lines.join("\n")}\n`;
};

const readJson = <Schema extends v.GenericSchema>(
  file: string,
  schema: Schema,
): v.InferOutput<Schema> => {
  const parsed = v.safeParse(schema, JSON.parse(readFileSync(file, "utf-8")));
  if (!parsed.success) {
    return panic(`${file}: ${v.summarize(parsed.issues)}`);
  }
  return parsed.output;
};

if (import.meta.main) {
  const [dir] = process.argv.slice(2);
  if (dir === undefined) {
    process.stderr.write("usage: bun scripts/release-plan.ts <dir>\n");
    process.exit(1);
  }
  const plans = RELEASED_VARIANTS.map((variant) => {
    const build = path.join(dir, `build-${variant}.json`);
    return planVariant(
      variant,
      readJson(path.join(dir, `head-${variant}.json`), fingerprintSchema),
      existsSync(build) ? readJson(build, buildSchema) : undefined,
    );
  });
  process.stdout.write(renderPlan(plans));
}
