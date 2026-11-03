import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { loadTurnPromptSources } from "@/api/handlers/chat/turn-prompt-sources";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";
import { installRecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";

let analytics: ReturnType<typeof installRecordingAnalytics>;
beforeEach(() => {
  analytics = installRecordingAnalytics();
});
afterEach(() => analytics.restore());

const failure = new DatabaseError({ message: "Prompt source unavailable" });

describe("turn prompt source requirements", () => {
  test.each(["returned", "thrown"] as const)(
    "optional %s failures omit enrichment and preserve required content",
    async (mode) => {
      const result = await loadTurnPromptSources({
        requestedSkills: {
          type: "required",
          load: async () => Result.ok("Requested skill content"),
        },
        connectorCatalog: {
          type: "optional",
          load: async () => {
            if (mode === "thrown") {
              throw failure;
            }
            return Result.err(failure);
          },
        },
      });
      expect(result).toEqual(
        Result.ok({
          requestedSkillsPrompt: "Requested skill content",
          connectableConnectors: undefined,
        }),
      );
      expect(analytics.exceptions()).toHaveLength(1);
    },
  );

  test.each(["returned", "thrown"] as const)(
    "required %s failures still fail prompt loading",
    async (mode) => {
      const result = await loadTurnPromptSources({
        requestedSkills: {
          type: "required",
          load: async () => {
            if (mode === "thrown") {
              throw failure;
            }
            return Result.err(failure);
          },
        },
        connectorCatalog: {
          type: "optional",
          load: async () => Result.ok(undefined),
        },
      });
      expect(result.isErr()).toBe(true);
    },
  );
});
