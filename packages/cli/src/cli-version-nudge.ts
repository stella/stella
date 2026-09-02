// CLI update nudge (spec 051 addendum). The latest published version comes from
// npm's release channel while the server independently advertises its minimum
// supported version. This module is pure (no I/O): version parsing is
// Valibot-validated and any unparsable or missing input yields no nudge
// (fail-silent). The nudge never touches stdout or the exit code.

import * as v from "valibot";

// Mirror of the server-owned minimum-policy header.
export const CLI_MINIMUM_HEADER = "x-stella-cli-minimum";

const SemVerSchema = v.pipe(v.string(), v.regex(/^\d+\.\d+\.\d+$/u));

const parseVersion = (
  raw: string | undefined,
): readonly [number, number, number] | undefined => {
  if (raw === undefined) {
    return undefined;
  }
  const parsed = v.safeParse(SemVerSchema, raw);
  if (!parsed.success) {
    return undefined;
  }
  const parts = parsed.output.split(".");
  return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
};

/** -1 / 0 / 1 when both versions parse; `undefined` when either does not. */
const compareVersions = (
  a: string | undefined,
  b: string | undefined,
): number | undefined => {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === undefined || right === undefined) {
    return undefined;
  }
  for (let index = 0; index < 3; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) {
      return delta > 0 ? 1 : -1;
    }
  }
  return 0;
};

/** What a nudge evaluation produced: an optional line + the version to remember. */
export type VersionNudge = {
  line?: string;
  nudgeVersion?: string;
};

/**
 * Decide whether to nudge (spec 051 addendum). Priority: an explicit minimum the
 * current version is below becomes an "unsupported" warning; otherwise a newer
 * latest becomes an update hint. Anti-nag: if the target version equals the one
 * last nudged, stay silent. Any unparsable/missing version yields no nudge.
 */
export const buildVersionNudge = ({
  current,
  latest,
  minimum,
  lastNudged,
}: {
  current: string;
  latest: string | undefined;
  minimum: string | undefined;
  lastNudged: string | undefined;
}): VersionNudge => {
  if (compareVersions(current, minimum) === -1) {
    // The comparison only returns -1 when `minimum` parsed, so it is defined.
    const target = latest ?? minimum;
    if (target === undefined || target === lastNudged) {
      return {};
    }
    return {
      line: `stella ${current} is no longer supported (server requires >= ${minimum}); upgrade with: npm i -g @stll/cli`,
      nudgeVersion: target,
    };
  }

  if (latest !== undefined && compareVersions(latest, current) === 1) {
    if (latest === lastNudged) {
      return {};
    }
    return {
      line: `stella ${current} -> ${latest} available; npm i -g @stll/cli`,
      nudgeVersion: latest,
    };
  }

  return {};
};
