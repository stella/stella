import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  isBusinessRegistrySlug,
  parseChatCorpusId,
  RESOURCE_TYPE,
  resourceRef,
} from "@stll/api-contract";

import type { ChatMentionOption } from "@/components/chat-mention-extension";
import { selectChatSuggestionItems } from "@/components/chat-mention-extension";
import {
  chatMentionOptionId,
  toChatMentionNodeAttrs,
} from "@/components/chat-mention-node-attrs";
import { toSafeId } from "@/lib/safe-id";

const option = ({
  category = "entity",
  id,
  label,
}: {
  category?: ChatMentionOption["category"];
  id: string;
  label: string;
}): ChatMentionOption => {
  switch (category) {
    case "entity":
      return {
        resource: resourceRef({
          type: RESOURCE_TYPE.ENTITY,
          id: toSafeId<"entity">(id),
        }),
        label,
        category,
        kind: "document",
        mimeType: null,
        matterId: "matter-1",
      };
    case "workspace":
      return {
        resource: resourceRef({
          type: RESOURCE_TYPE.WORKSPACE,
          id: toSafeId<"workspace">(id),
        }),
        label,
        category,
        kind: "workspace",
        mimeType: null,
      };
    case "decision":
      return {
        resource: resourceRef({
          type: RESOURCE_TYPE.CASE_LAW_DECISION,
          id: toSafeId<"caseLawDecision">(id),
        }),
        label,
        category,
        kind: "decision",
        mimeType: null,
      };
    case "corpus":
      return {
        scope: parseChatCorpusId(id) ?? panic(`Not a corpus chip id: ${id}`),
        label,
        category,
        kind: "corpus",
        mimeType: null,
      };
    case "registry":
      return {
        registry: isBusinessRegistrySlug(id)
          ? id
          : panic(`Not a registry slug: ${id}`),
        label,
        category,
        kind: "registry",
        mimeType: null,
      };
    case "connector":
      return {
        connector: id,
        label,
        category,
        kind: "connector",
        mimeType: null,
      };
    default:
      return category satisfies never;
  }
};

describe("chat mention suggestions", () => {
  test("maps every suggestion resource ID into TipTap node attributes", () => {
    const mentions = [
      option({ category: "entity", id: "entity-1", label: "Contract" }),
      option({ category: "workspace", id: "workspace-1", label: "Matter" }),
      option({ category: "decision", id: "decision-1", label: "Decision" }),
      option({
        category: "corpus",
        id: "case_law:CZE",
        label: "Case law · Czechia",
      }),
    ];

    for (const mention of mentions) {
      expect(toChatMentionNodeAttrs(mention).id).toBe(
        chatMentionOptionId(mention),
      );
    }
    expect(toChatMentionNodeAttrs(mentions[3] ?? panic("corpus")).id).toBe(
      "case_law:CZE",
    );
  });

  test("keeps searched decision hits even when the case number does not match the query", () => {
    const result = selectChatSuggestionItems({
      localItems: [option({ id: "entity-1", label: "Contract" })],
      query: "ECLI",
      searchedItems: [
        option({
          category: "decision",
          id: "decision-1",
          label: "20 Cdo 470/2017",
        }),
      ],
    });

    expect(result.map((item) => chatMentionOptionId(item))).toEqual([
      "decision-1",
    ]);
  });

  test("still filters local cached mentions by label", () => {
    const result = selectChatSuggestionItems({
      localItems: [
        option({ id: "entity-1", label: "Contract" }),
        option({ id: "entity-2", label: "Invoice" }),
      ],
      query: "con",
      searchedItems: [],
    });

    expect(result.map((item) => chatMentionOptionId(item))).toEqual([
      "entity-1",
    ]);
  });
});
