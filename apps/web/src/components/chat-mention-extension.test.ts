import { describe, expect, test } from "bun:test";

import type {
  ChatMentionKind,
  ChatMentionOption,
} from "@/components/chat-mention-extension";
import { selectChatSuggestionItems } from "@/components/chat-mention-extension";

// A real producer never emits the category as the kind: an entity row
// carries an entity kind, and the other categories carry their own marker.
const KIND_BY_CATEGORY = {
  entity: "document",
  workspace: "workspace",
  decision: "decision",
} as const satisfies Record<ChatMentionOption["category"], ChatMentionKind>;

const option = ({
  category = "entity",
  id,
  label,
}: {
  category?: ChatMentionOption["category"];
  id: string;
  label: string;
}): ChatMentionOption => ({
  id,
  label,
  category,
  kind: KIND_BY_CATEGORY[category],
  mimeType: null,
});

describe("chat mention suggestions", () => {
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

    expect(result.map((item) => item.id)).toEqual(["decision-1"]);
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

    expect(result.map((item) => item.id)).toEqual(["entity-1"]);
  });
});
