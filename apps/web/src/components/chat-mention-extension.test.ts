import { describe, expect, test } from "bun:test";

import { resourceRef, RESOURCE_TYPE, toSafeId } from "@stll/api-contract";

import type { ChatMentionOption } from "@/components/chat-mention-extension";
import { selectChatSuggestionItems } from "@/components/chat-mention-extension";
import { toChatMentionNodeAttrs } from "@/components/chat-mention-node-attrs";

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
    ];

    for (const mention of mentions) {
      expect(toChatMentionNodeAttrs(mention).id).toBe(mention.resource.id);
    }
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

    expect(result.map((item) => String(item.resource.id))).toEqual([
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

    expect(result.map((item) => String(item.resource.id))).toEqual([
      "entity-1",
    ]);
  });
});
