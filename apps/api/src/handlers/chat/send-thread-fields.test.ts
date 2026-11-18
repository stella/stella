import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";

import {
  resolveSendThreadFields,
  type SendThreadFields,
  sendThreadFieldsAuditChanges,
  sendThreadFieldsChanged,
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

const fullSend = {
  activeSkill: reviewSkill,
  contextMatterIds: [matterB],
  dataWorkspaceIds: [matterA, matterC],
  subjectDecisionId: decisionA,
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
        request: { activeSkill: undefined },
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

    expect(
      resolveSendThreadFields({ request: { activeSkill: undefined }, stored }),
    ).toEqual(stored.fields);
    expect(
      resolveSendThreadFields({
        request: {
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

  test("adopting an empty row only widens its data scope", () => {
    const stored = {
      fields: { ...placeholder, dataWorkspaceIds: [matterA, matterB] },
      hasMessages: false,
    };
    const adopted = resolveSendThreadFields({
      request: { activeSkill: undefined, dataWorkspaceIds: [matterC, matterA] },
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
      request: { activeSkill: undefined, dataWorkspaceIds: [matterA] },
      stored,
    });

    expect(sendThreadFieldsChanged(placeholder, adopted)).toBe(false);
    expect(sendThreadFieldsAuditChanges(placeholder, adopted)).toEqual({});
  });
});
