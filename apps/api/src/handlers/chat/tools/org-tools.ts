import { valibotSchema } from "@ai-sdk/valibot";
import { tool } from "ai";
import * as v from "valibot";

import type { ScopedDb } from "@/api/db";
import type { SafeId } from "@/api/lib/branded-types";

// -----------------------------------------------------------------
// Org-level tools (always available)
// -----------------------------------------------------------------

type OrgToolsContext = {
  accessibleWorkspaceIds: SafeId<"workspace">[];
  organizationId: SafeId<"organization">;
  scopedDb: ScopedDb;
};

export const createOrgTools = (_context: OrgToolsContext) => ({
  "ask-user": tool({
    description:
      "Ask the user clarifying questions before executing " +
      "a complex task. Use this when the request is " +
      "ambiguous or requires decisions you cannot make " +
      "alone (jurisdiction, parties, preferences, scope). " +
      "The UI renders the questions automatically. Once " +
      "the user answers, synthesize their input into a " +
      "plan and execute it.",
    inputSchema: valibotSchema(
      v.strictObject({
        analysis: v.pipe(
          v.string(),
          v.description(
            "Brief analysis of the task and what you " +
              "already know from context",
          ),
        ),
        questions: v.pipe(
          v.array(
            v.strictObject({
              question: v.string(),
              reason: v.pipe(
                v.string(),
                v.description("Why this matters for the task"),
              ),
              options: v.optional(
                v.pipe(
                  v.array(v.string()),
                  v.description(
                    "Suggested options (A/B/C style). " +
                      "The user can also write their " +
                      "own answer.",
                  ),
                ),
              ),
              default: v.optional(
                v.pipe(
                  v.string(),
                  v.description("Preselected option or default value"),
                ),
              ),
            }),
          ),
          v.minLength(1),
          v.maxLength(10),
          v.description("Clarifying questions to ask"),
        ),
      }),
    ),
    outputSchema: valibotSchema(
      v.strictObject({
        answers: v.array(
          v.strictObject({
            question: v.string(),
            answer: v.string(),
          }),
        ),
      }),
    ),
  }),
});
