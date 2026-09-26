import { toolDefinition } from "@tanstack/ai";
import { panic, Result } from "better-result";
import * as v from "valibot";

import { ENTITY_CHECK_KINDS } from "@stll/business-registries/entity-checks";
import type {
  EntityCheckResult,
  EntityCheckSubject,
  runEntityCheck,
} from "@stll/business-registries/entity-checks";

import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import { runEntityCheckShared } from "@/api/lib/business-registries/entity-checks";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";

export const COUNTERPARTY_CHECK_TOOL_NAME = "counterparty_check" as const;

const TOOL_DESCRIPTION =
  "Screen a company or a person against an official register for due " +
  "diligence. cz-insolvency asks the Czech insolvency register (ISIR) " +
  "for pending and ended insolvency proceedings. The result status is " +
  "clear (the register answered and lists nothing), found (the records " +
  "it lists, each with a public link), unavailable (the register did not " +
  "answer: the subject is NOT cleared; say the check could not run), or " +
  "not-covered (the register cannot screen this subject type). Person " +
  "matches rely on name and birth date: compare the debtor as registered " +
  "before relying on one.";

const subjectSchema = v.variant("type", [
  v.strictObject({
    type: v.pipe(
      v.literal("company-id"),
      v.description("A registered business, by its national business ID."),
    ),
    companyId: v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(32),
      v.description(
        "National business ID in the check's country, e.g. the Czech IČO 26863154.",
      ),
    ),
  }),
  v.strictObject({
    type: v.pipe(
      v.literal("person"),
      v.description("A natural person, by name and birth date."),
    ),
    firstName: v.pipe(v.string(), v.minLength(2), v.maxLength(100)),
    lastName: v.pipe(v.string(), v.minLength(2), v.maxLength(100)),
    birthDate: v.pipe(
      v.string(),
      v.isoDate(),
      v.description("Birth date as YYYY-MM-DD."),
    ),
  }),
]);

const inputSchema = v.strictObject({
  check: v.pipe(
    v.picklist(ENTITY_CHECK_KINDS),
    v.description("Register to screen against."),
  ),
  subject: subjectSchema,
});

const toEntityCheckSubject = (
  subject: v.InferOutput<typeof subjectSchema>,
): EntityCheckSubject => {
  switch (subject.type) {
    case "company-id": {
      return { type: "company-id", value: subject.companyId };
    }
    case "person": {
      return {
        type: "person",
        firstName: subject.firstName,
        lastName: subject.lastName,
        birthDate: subject.birthDate,
      };
    }
    default: {
      subject satisfies never;
      return panic("Unhandled subject");
    }
  }
};

type CreateCounterpartyCheckToolsArgs = {
  runCheck?: typeof runEntityCheck | undefined;
};

/**
 * Register the `counterparty_check` chat tool. Checks against public
 * registers need no organization configuration, so the tool is always
 * offered.
 */
export const createCounterpartyCheckTools = ({
  runCheck,
}: CreateCounterpartyCheckToolsArgs = {}) => ({
  [COUNTERPARTY_CHECK_TOOL_NAME]: toolDefinition({
    name: COUNTERPARTY_CHECK_TOOL_NAME,
    description: TOOL_DESCRIPTION,
    inputSchema: toTanStackToolSchema(inputSchema),
  }).server(async ({ check, subject }): Promise<EntityCheckResult> => {
    const result = (
      await runEntityCheckShared({
        check,
        subject: toEntityCheckSubject(subject),
        runCheck,
      })
    ).mapError(
      (error) =>
        new ChatToolError({
          // A rejected subject (a bad IČO checksum, a future birth date) is
          // the model's to correct; a cancelled check may simply be rerun.
          kind: error.status === 400 ? "invalid-input" : "transient",
          message: error.message,
        }),
    );
    if (Result.isError(result)) {
      const { error } = result;
      throw error;
    }
    return result.value;
  }),
});
