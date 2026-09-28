import { describe, expect, test } from "bun:test";

import {
  CHAT_SKILL_CONTEXT_NEED,
  CHAT_SKILL_DOCUMENT,
  type ChatSkillContextNeed,
} from "@stll/api-contract";

import { buildChatSlashItems } from "@/components/chat-editor-slash-items";
import { CHAT_EDIT_APPLY_MODE } from "@/lib/chat-edit-mode";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { toSafeId } from "@/lib/safe-id";

import {
  CHAT_SKILL_NEED_MESSAGE_KEY,
  chatSkillAvailabilityKey,
  chatSkillAvailabilityQuery,
  chatSkillMenuAvailability,
  chatSkillRowState,
  fileOverlaySkillDocument,
  oneClickSkillNeeds,
  slashItemSkillId,
  type ComposerSkillChatContext,
} from "./chat-skill-availability.logic";

const MATTER_ID = "019a0000-0000-7000-8000-0000000000aa";
const GLOBAL_THREAD: ChatThreadRef = {
  scope: "global",
  threadId: toSafeId<"chatThread">("019a0000-0000-7000-8000-000000000001"),
};
const MATTER_THREAD: ChatThreadRef = {
  scope: "workspace",
  threadId: toSafeId<"chatThread">("019a0000-0000-7000-8000-000000000002"),
  workspaceId: MATTER_ID,
};
const FILE_ID = "019a0000-0000-7000-8000-0000000000f1";

const WEB_SKILL = "019a0000-0000-7000-8000-000000000101";
const NOWHERE_SKILL = "019a0000-0000-7000-8000-000000000102";
const PLAIN_SKILL = "019a0000-0000-7000-8000-000000000103";
const EDIT_SKILL = "019a0000-0000-7000-8000-000000000104";

/** What the server answers for a chat, as the composer receives it. */
const answer = (
  blockedHere: Readonly<Record<string, readonly ChatSkillContextNeed[]>>,
) =>
  chatSkillMenuAvailability({
    unavailable: [{ skillId: NOWHERE_SKILL }],
    unavailableHere: Object.entries(blockedHere).map(([skillId, needs]) => ({
      needs,
      skillId,
    })),
  });

const PAGES = [
  {
    installed: [WEB_SKILL, NOWHERE_SKILL, PLAIN_SKILL].map((id, index) => ({
      description: `Skill ${String(index)}.`,
      enabled: true,
      id,
      name: `Skill ${String(index)}`,
      scope: "private" as const,
      slug: `skill-${String(index)}`,
    })),
  },
];

const chatWith = (
  webSearch: ComposerSkillChatContext["webSearch"],
): ComposerSkillChatContext => ({
  document: null,
  threadRef: GLOBAL_THREAD,
  webSearch,
});

/** The rows the Skills submenu lists and how each reads. */
const menuRows = (
  availability: ReturnType<typeof answer>,
  chat: ComposerSkillChatContext,
) =>
  buildChatSlashItems({
    shortcuts: [],
    skillPages: PAGES,
    unavailableSkillIds: availability?.hidden,
  }).map((item) => ({
    skillId: slashItemSkillId(item),
    state: chatSkillRowState({
      availability,
      oneClickNeeds: oneClickSkillNeeds(chat),
      skillId: slashItemSkillId(item),
    }),
  }));

describe("the composer asks about the chat it is in", () => {
  test("its query carries each switch a send carries", () => {
    expect(
      chatSkillAvailabilityQuery({
        anonymized: true,
        browserExtension: false,
        chat: {
          document: {
            entityId: FILE_ID,
            fileFieldId: undefined,
            kind: CHAT_SKILL_DOCUMENT.file,
          },
          editApplyMode: CHAT_EDIT_APPLY_MODE.manual,
          threadRef: MATTER_THREAD,
          webSearch: { available: true, enabled: false },
        },
      }),
    ).toEqual({
      anonymized: true,
      browserExtension: false,
      document: CHAT_SKILL_DOCUMENT.file,
      documentId: toSafeId<"entity">(FILE_ID),
      editApplyMode: CHAT_EDIT_APPLY_MODE.manual,
      webSearch: false,
      workspaceId: toSafeId<"workspace">(MATTER_ID),
    });
    expect(
      chatSkillAvailabilityQuery({
        anonymized: false,
        browserExtension: true,
        chat: chatWith({ available: true, enabled: true }),
      }),
    ).toEqual({ anonymized: false, browserExtension: true, webSearch: true });
  });

  test("a chat whose web search is still loading asks nothing yet", () => {
    expect(
      chatSkillAvailabilityQuery({
        anonymized: false,
        browserExtension: false,
        chat: chatWith(null),
      }),
    ).toBeNull();
  });

  test("each chat is cached apart, and the widest chat apart from all", () => {
    const off = chatSkillAvailabilityQuery({
      anonymized: false,
      browserExtension: false,
      chat: chatWith({ available: true, enabled: false }),
    });
    const on = chatSkillAvailabilityQuery({
      anonymized: false,
      browserExtension: false,
      chat: chatWith({ available: true, enabled: true }),
    });
    if (off === null || on === null) {
      throw new TypeError("expected both chats to be known");
    }
    const keys = [off, on, undefined].map((query) =>
      JSON.stringify(chatSkillAvailabilityKey(query)),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("a skill this chat cannot run", () => {
  test("shows disabled with the reason for what the chat lacks", () => {
    for (const need of Object.values(CHAT_SKILL_CONTEXT_NEED)) {
      const row = menuRows(
        answer({ [WEB_SKILL]: [need] }),
        chatWith({ available: false, enabled: false }),
      ).find(({ skillId }) => skillId === WEB_SKILL);
      expect(row?.state).toEqual({
        fixable: false,
        messageKey: CHAT_SKILL_NEED_MESSAGE_KEY[need],
        need,
        status: "blocked",
      });
    }
  });

  test("turning web search on is one click where the organization offers it", () => {
    const needsWeb = answer({
      [WEB_SKILL]: [CHAT_SKILL_CONTEXT_NEED.webSearch],
    });
    const offered = menuRows(
      needsWeb,
      chatWith({ available: true, enabled: false }),
    ).find(({ skillId }) => skillId === WEB_SKILL);
    expect(offered?.state).toMatchObject({ fixable: true, status: "blocked" });
    // Two needs are not met by one click.
    const twoNeeds = menuRows(
      answer({
        [WEB_SKILL]: [
          CHAT_SKILL_CONTEXT_NEED.webSearch,
          CHAT_SKILL_CONTEXT_NEED.matter,
        ],
      }),
      chatWith({ available: true, enabled: false }),
    ).find(({ skillId }) => skillId === WEB_SKILL);
    expect(twoNeeds?.state).toMatchObject({ fixable: false });
  });

  test("is offered again once the chat has web search on", () => {
    const webOff = chatWith({ available: true, enabled: false });
    const webOn = chatWith({ available: true, enabled: true });
    const before = menuRows(
      answer({ [WEB_SKILL]: [CHAT_SKILL_CONTEXT_NEED.webSearch] }),
      webOff,
    ).find(({ skillId }) => skillId === WEB_SKILL);
    // The web-on chat is its own query, whose answer blocks nothing.
    const after = menuRows(answer({}), webOn).find(
      ({ skillId }) => skillId === WEB_SKILL,
    );
    expect(before?.state.status).toBe("blocked");
    expect(after?.state).toEqual({ status: "offered" });
  });

  test("while the answer is loading, no skill row is offered", () => {
    expect(
      menuRows(undefined, chatWith({ available: true, enabled: false })),
    ).toEqual([]);
  });
});

describe("a skill no chat can run", () => {
  test("stays out of the menu instead of showing disabled", () => {
    const rows = menuRows(
      answer({ [WEB_SKILL]: [CHAT_SKILL_CONTEXT_NEED.webSearch] }),
      chatWith({ available: true, enabled: false }),
    );
    expect(rows.map(({ skillId }) => skillId).toSorted()).toEqual(
      [PLAIN_SKILL, WEB_SKILL].toSorted(),
    );
    expect(rows.find(({ skillId }) => skillId === PLAIN_SKILL)?.state).toEqual({
      status: "offered",
    });
  });
});

describe("the file overlay's document, as its send carries it", () => {
  const selectable = {
    selection: { editApplyMode: CHAT_EDIT_APPLY_MODE.manual },
    type: "selectable",
  } as const;

  test("a file with an edit mode is an open document in that mode", () => {
    expect(
      fileOverlaySkillDocument({
        activeFile: { entityId: FILE_ID },
        editMode: selectable,
        hasActiveDraft: false,
      }),
    ).toEqual({
      document: {
        entityId: FILE_ID,
        fileFieldId: undefined,
        kind: CHAT_SKILL_DOCUMENT.file,
      },
      editApplyMode: CHAT_EDIT_APPLY_MODE.manual,
    });
  });

  test("a file that cannot take edits is no open document", () => {
    expect(
      fileOverlaySkillDocument({
        activeFile: { entityId: FILE_ID },
        editMode: { type: "unavailable" },
        hasActiveDraft: false,
      }),
    ).toEqual({ document: null, editApplyMode: undefined });
  });

  test("a draft is sent as a draft", () => {
    expect(
      fileOverlaySkillDocument({
        activeFile: undefined,
        editMode: selectable,
        hasActiveDraft: true,
      }).document,
    ).toEqual({ kind: CHAT_SKILL_DOCUMENT.draft });
  });

  test("review mode is one click only where the composer can switch it", () => {
    const withSwitch: ComposerSkillChatContext = {
      document: { kind: CHAT_SKILL_DOCUMENT.draft },
      onReviewEdits: () => undefined,
      threadRef: GLOBAL_THREAD,
      webSearch: { available: false, enabled: false },
    };
    const needsReview = answer({
      [EDIT_SKILL]: [CHAT_SKILL_CONTEXT_NEED.reviewEdits],
    });
    expect(
      chatSkillRowState({
        availability: needsReview,
        oneClickNeeds: oneClickSkillNeeds(withSwitch),
        skillId: EDIT_SKILL,
      }),
    ).toMatchObject({ fixable: true });
    expect(
      chatSkillRowState({
        availability: needsReview,
        oneClickNeeds: oneClickSkillNeeds({
          ...withSwitch,
          onReviewEdits: undefined,
        }),
        skillId: EDIT_SKILL,
      }),
    ).toMatchObject({ fixable: false });
  });
});
