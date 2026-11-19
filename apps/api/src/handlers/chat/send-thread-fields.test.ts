import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";

import {
  ignoredSendThreadFields,
  resolveSendThreadFields,
  resolveSendThreadSkill,
  type SendThreadFields,
  sendThreadFieldsAuditChanges,
  sendThreadFieldsChanged,
  type SendThreadFieldsRequest,
} from "./send-thread-fields";

const matterA = toSafeId<"workspace">("00000000-0000-0000-0000-00000000000a");
const matterB = toSafeId<"workspace">("00000000-0000-0000-0000-00000000000b");
const matterC = toSafeId<"workspace">("00000000-0000-0000-0000-00000000000c");
const decisionA = toSafeId<"caseLawDecision">(
  "00000000-0000-0000-0000-0000000000da",
);
const decisionB = toSafeId<"caseLawDecision">(
  "00000000-0000-0000-0000-0000000000db",
);
const reviewSkill = { skillName: "review" };
const builderSkill = { skillName: "playbook-builder" };

/** A row a composer setting stored before the first message. */
const placeholder: SendThreadFields = {
  activeSkill: null,
  contextMatterIds: [],
  dataWorkspaceIds: [matterA],
  subjectDecisionId: null,
};

const fullSend: SendThreadFieldsRequest = {
  activeSkill: reviewSkill,
  contextMatterIds: [matterB],
  dataWorkspaceIds: [matterA, matterC],
  subjectDecisionId: decisionA,
};

/** A send that carries none of the fields its first message decides. */
const emptySend: SendThreadFieldsRequest = {
  activeSkill: undefined,
  contextMatterIds: undefined,
  dataWorkspaceIds: [],
  subjectDecisionId: null,
};

describe("the fields a send runs its thread with", () => {
  test("a send that creates the thread stores everything it carries", () => {
    expect(
      resolveSendThreadFields({ request: fullSend, stored: null }),
    ).toEqual({
      activeSkill: reviewSkill,
      contextMatterIds: [matterB],
      dataWorkspaceIds: [matterA, matterC],
      subjectDecisionId: decisionA,
    });
    expect(
      resolveSendThreadFields({
        request: emptySend,
        stored: null,
      }),
    ).toEqual({
      activeSkill: null,
      contextMatterIds: [],
      dataWorkspaceIds: [],
      subjectDecisionId: null,
    });
  });

  test("a row stored before the first message takes what the first send carries", () => {
    const stored = { fields: placeholder, hasMessages: false };
    const adopted = resolveSendThreadFields({ request: fullSend, stored });

    expect(sendThreadFieldsChanged(placeholder, adopted)).toBe(true);
    expect(adopted).toEqual(
      resolveSendThreadFields({ request: fullSend, stored: null }),
    );
  });

  test("an empty row keeps a stored value only where the send carries none", () => {
    const stored = {
      fields: {
        activeSkill: builderSkill,
        contextMatterIds: [matterB],
        dataWorkspaceIds: [matterA],
        subjectDecisionId: decisionB,
      },
      hasMessages: false,
    };

    expect(resolveSendThreadFields({ request: emptySend, stored })).toEqual(
      stored.fields,
    );
    expect(
      resolveSendThreadFields({
        request: {
          ...emptySend,
          activeSkill: reviewSkill,
          contextMatterIds: [],
          subjectDecisionId: decisionA,
        },
        stored,
      }),
    ).toEqual({
      activeSkill: reviewSkill,
      // An explicit empty list unpins, as it does on any send.
      contextMatterIds: [],
      dataWorkspaceIds: [matterA],
      subjectDecisionId: decisionA,
    });
  });

  test("validation reads the same skill the thread is loaded with", () => {
    const threads = [
      null,
      { fields: placeholder, hasMessages: false },
      { fields: placeholder, hasMessages: true },
      {
        fields: { ...placeholder, activeSkill: builderSkill },
        hasMessages: false,
      },
      {
        fields: { ...placeholder, activeSkill: builderSkill },
        hasMessages: true,
      },
    ];
    for (const request of [fullSend, emptySend]) {
      expect(
        threads.map((stored) =>
          resolveSendThreadSkill({
            activeSkill: request.activeSkill,
            stored,
          }),
        ),
      ).toEqual(
        threads.map(
          (stored) => resolveSendThreadFields({ request, stored }).activeSkill,
        ),
      );
    }
  });

  test("adopting an empty row only widens its data scope", () => {
    const stored = {
      fields: { ...placeholder, dataWorkspaceIds: [matterA, matterB] },
      hasMessages: false,
    };
    const adopted = resolveSendThreadFields({
      request: { ...emptySend, dataWorkspaceIds: [matterC, matterA] },
      stored,
    });

    expect(adopted.dataWorkspaceIds).toEqual([matterA, matterB, matterC]);
    expect(sendThreadFieldsAuditChanges(stored.fields, adopted)).toEqual({
      dataWorkspaceIds: {
        old: [matterA, matterB],
        new: [matterA, matterB, matterC],
      },
    });
  });

  test("a thread that holds a message keeps every stored value", () => {
    const stored = {
      fields: {
        activeSkill: builderSkill,
        contextMatterIds: [matterB],
        dataWorkspaceIds: [matterA],
        subjectDecisionId: decisionB,
      },
      hasMessages: true,
    };
    const ordinaryChat = {
      fields: placeholder,
      hasMessages: true,
    };

    expect(resolveSendThreadFields({ request: fullSend, stored })).toEqual(
      stored.fields,
    );
    // An ordinary chat stays ordinary when a later send names a skill.
    expect(
      resolveSendThreadFields({ request: fullSend, stored: ordinaryChat }),
    ).toEqual(placeholder);
  });

  test("an unchanged adoption needs no write and names no change", () => {
    const stored = { fields: placeholder, hasMessages: false };
    const adopted = resolveSendThreadFields({
      request: { ...emptySend, dataWorkspaceIds: [matterA] },
      stored,
    });

    expect(sendThreadFieldsChanged(placeholder, adopted)).toBe(false);
    expect(sendThreadFieldsAuditChanges(placeholder, adopted)).toEqual({});
  });
});

describe("the carried fields a send's thread does not run with", () => {
  const ignoredFor = (
    request: SendThreadFieldsRequest,
    stored: Parameters<typeof resolveSendThreadFields>[0]["stored"],
  ) =>
    ignoredSendThreadFields({
      request,
      resolved: resolveSendThreadFields({ request, stored }),
    });

  const skillOnly: SendThreadFieldsRequest = {
    ...emptySend,
    activeSkill: builderSkill,
  };

  test("a send that creates or adopts its thread ignores nothing it carries", () => {
    const storedBeforeFirstMessage = [
      null,
      { fields: placeholder, hasMessages: false },
      {
        fields: {
          ...placeholder,
          activeSkill: reviewSkill,
          subjectDecisionId: decisionB,
        },
        hasMessages: false,
      },
    ];
    for (const stored of storedBeforeFirstMessage) {
      for (const request of [fullSend, emptySend, skillOnly]) {
        expect(ignoredFor(request, stored)).toEqual([]);
      }
    }
  });

  test("a thread that holds a message names each carried field it keeps its own value for", () => {
    const started = {
      fields: {
        ...placeholder,
        activeSkill: builderSkill,
        subjectDecisionId: decisionB,
      },
      hasMessages: true,
    };

    expect(ignoredFor(fullSend, started)).toEqual([
      "activeSkill",
      "subjectDecisionId",
    ]);
    expect(
      ignoredFor({ ...fullSend, subjectDecisionId: null }, started),
    ).toEqual(["activeSkill"]);
    // Restating the thread's own values, or carrying none, ignores nothing.
    expect(
      ignoredFor(
        {
          ...fullSend,
          activeSkill: builderSkill,
          subjectDecisionId: decisionB,
        },
        started,
      ),
    ).toEqual([]);
    expect(ignoredFor(emptySend, started)).toEqual([]);
    // An ordinary chat keeps no skill when a later send names one.
    expect(
      ignoredFor(skillOnly, { fields: placeholder, hasMessages: true }),
    ).toEqual(["activeSkill"]);
  });
});
