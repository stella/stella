import { Result, TaggedError } from "better-result";
import * as v from "valibot";

const stagingStateSchema = v.strictObject({
  corpus_index: v.optional(v.picklist(["on", "off"])),
  rollout: v.optional(v.picklist(["on", "knowledge-web-pending"])),
});

export type StagingState = v.InferOutput<typeof stagingStateSchema>;

export const STAGING_CHECKS = {
  "public-law-hydration": {
    tag: "@staging-public-law-hydration",
    key: "corpus_index",
    reportOnlyValue: "off",
  },
  "public-knowledge-flags": {
    tag: "@staging-public-knowledge-flags",
    key: "rollout",
    reportOnlyValue: "knowledge-web-pending",
  },
} as const;

export type StagingCheckKey = keyof typeof STAGING_CHECKS;

export class StagingStateError extends TaggedError("StagingStateError")<{
  cause?: unknown;
  message: string;
}> {}

export const parseStagingState = (raw: string | undefined): StagingState => {
  if (raw === undefined || raw === "") {
    return {};
  }

  const parsed = Result.try(() => JSON.parse(raw));
  if (parsed.isErr()) {
    throw new StagingStateError({
      message: "STAGING_STATE must contain valid JSON",
      cause: parsed.error,
    });
  }
  // Valibot object schemas also accept empty arrays; the declaration must be a JSON object.
  if (Array.isArray(parsed.value)) {
    throw new StagingStateError({
      message: "STAGING_STATE must be a JSON object",
    });
  }

  const result = v.safeParse(stagingStateSchema, parsed.value);
  if (!result.success) {
    throw new StagingStateError({
      message: "STAGING_STATE has an invalid shape or value",
      cause: result.issues,
    });
  }
  return result.output;
};

export type StagingCheckDisposition =
  | { mode: "gating" }
  | { mode: "report-only"; reason: string };

export const stagingCheckDisposition = (
  state: StagingState,
  checkKey: StagingCheckKey,
): StagingCheckDisposition => {
  const check = STAGING_CHECKS[checkKey];
  if (state[check.key] !== check.reportOnlyValue) {
    return { mode: "gating" };
  }
  return {
    mode: "report-only",
    reason: `${check.key}=${check.reportOnlyValue}`,
  };
};

export const stagingFailureDisposition = (
  state: StagingState,
  tags: readonly string[],
): StagingCheckDisposition => {
  if (tags.length !== 1) {
    return { mode: "gating" };
  }

  const check = Object.values(STAGING_CHECKS).find(
    ({ tag }) => tag === tags[0],
  );
  if (!check) {
    return { mode: "gating" };
  }

  return state[check.key] === check.reportOnlyValue
    ? {
        mode: "report-only",
        reason: `${check.key}=${check.reportOnlyValue}`,
      }
    : { mode: "gating" };
};
