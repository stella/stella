import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import type { ChatSendMode } from "@stll/anonymize-chat";

import { createChatThirdPartyBoundary } from "@/api/handlers/chat/third-party-boundary";
import { toSafeId } from "@/api/lib/branded-types";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import { templateAiCollaboratorsForBoundary } from "./template-ai-boundary";

const NAME = "Dana Novotná";

const anonymizeFields = async ({ fields }: { fields: string[] }) => {
  const redactionMap = new Map<string, string>();
  const anonymized = fields.map((field) => {
    if (!field.includes(NAME)) {
      return field;
    }
    redactionMap.set("[PERSON_1]", NAME);
    return field.replaceAll(NAME, "[PERSON_1]");
  });
  return Result.ok({
    entityCount: redactionMap.size,
    fields: anonymized,
    redactionMap,
  });
};

const boundaryFor = (sendMode: ChatSendMode) =>
  createChatThirdPartyBoundary({
    anonymizeFields,
    anonymizationScopeId: "workspace-A",
    organizationId: toSafeId<"organization">("org-test"),
    scopedDb: createScopedDbMock({}).scopedDb,
    sendMode,
    threadRestorations: [],
  });

/** Collaborators that record what each nested request would send, and draft
 *  from it the way a model would: echoing the name it was given, in new
 *  sentences around it. */
const recordingCollaborators = (draftSuffix = "") => {
  const sent: unknown[] = [];
  return {
    collaborators: {
      adaptAiValue: async (input: {
        occurrences: readonly { context: string }[];
        stub: string;
      }) => {
        sent.push(input);
        return input.occurrences.map(() => `${input.stub}, as signatory`);
      },
      decideAiCondition: async (input: { values: Record<string, unknown> }) => {
        sent.push(input);
        return { decidedBy: "generative_model", value: true } as const;
      },
      generateAiValue: async (input: {
        prompt: string;
        values: Record<string, unknown>;
      }) => {
        sent.push(input);
        return {
          type: "drafted",
          value: `Dear ${String(input.values["party"])}, signed.${draftSuffix}`,
        } as const;
      },
    },
    sent,
  };
};

const runAll = async (sendMode: ChatSendMode, draftSuffix = "") => {
  const { collaborators, sent } = recordingCollaborators(draftSuffix);
  const unrestoredFields = new Set<string>();
  const wrapped = templateAiCollaboratorsForBoundary({
    boundary: boundaryFor(sendMode),
    collaborators,
    unrestoredFields,
  });
  const drafted = await wrapped.generateAiValue?.({
    fieldPath: "clause",
    prompt: `Draft a signature line for ${NAME}.`,
    values: { party: NAME },
  });
  await wrapped.decideAiCondition?.({
    fieldPath: "hasGuarantor",
    prompt: "Is there a guarantor?",
    values: { party: NAME },
  });
  const adapted = await wrapped.adaptAiValue?.({
    fieldPath: "party",
    label: undefined,
    occurrences: [{ context: `Between ${NAME} and {{party}}` }],
    prompt: undefined,
    stub: NAME,
  });
  return { adapted, drafted, sent, unrestoredFields };
};

describe("template AI fields in a chat turn", () => {
  test("prepare each nested request for the send mode and restore the drafts", async () => {
    const anonymized = await runAll(CHAT_SEND_MODE.anonymized);

    expect(JSON.stringify(anonymized.sent)).not.toContain(NAME);
    expect(JSON.stringify(anonymized.sent)).toContain("[PERSON_1]");
    expect(anonymized.drafted).toEqual({
      type: "drafted",
      value: `Dear ${NAME}, signed.`,
    });
    expect(anonymized.adapted).toEqual([`${NAME}, as signatory`]);
    expect([...anonymized.unrestoredFields]).toEqual([]);
  });

  test("restore a placeholder the model wrote without its brackets", async () => {
    const turn = await runAll(CHAT_SEND_MODE.anonymized, " Witness: PERSON_1.");

    expect(turn.drafted).toEqual({
      type: "drafted",
      value: `Dear ${NAME}, signed. Witness: ${NAME}.`,
    });
    expect([...turn.unrestoredFields]).toEqual([]);
  });

  test("name a field whose draft keeps a placeholder that cannot be restored", async () => {
    const turn = await runAll(
      CHAT_SEND_MODE.anonymized,
      " Witness: [PERSON_7].",
    );

    expect(turn.drafted).toEqual({
      type: "drafted",
      value: `Dear ${NAME}, signed. Witness: [PERSON_7].`,
    });
    expect([...turn.unrestoredFields]).toEqual(["clause"]);
  });

  test("send the values as they are in raw mode", async () => {
    const raw = await runAll(CHAT_SEND_MODE.rawOverride);

    expect(JSON.stringify(raw.sent)).toContain(NAME);
    expect(raw.drafted).toEqual({
      type: "drafted",
      value: `Dear ${NAME}, signed.`,
    });
  });
});
