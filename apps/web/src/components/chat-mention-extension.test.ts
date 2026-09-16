import { describe, expect, test } from "bun:test";
import { Schema } from "prosemirror-model";

import { resourceRef, RESOURCE_TYPE } from "@stll/api-contract";

import type { ChatMentionOption } from "@/components/chat-mention-extension";
import {
  findChatSuggestionMatch,
  selectChatSuggestionItems,
} from "@/components/chat-mention-extension";
import { toChatMentionNodeAttrs } from "@/components/chat-mention-node-attrs";
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

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*" },
    text: { inline: true },
  },
});

const findMentionAfter = (prefix: string) => {
  const text = `${prefix}@`;
  const doc = schema.node("doc", null, [
    schema.node("paragraph", null, [schema.text(text)]),
  ]);

  return findChatSuggestionMatch({
    char: "@",
    allowSpaces: true,
    allowToIncludeChar: false,
    allowedPrefixes: null,
    startOfLine: false,
    $position: doc.resolve(text.length + 1),
  });
};

describe("chat mention suggestions", () => {
  test("opens after every JavaScript whitespace character", () => {
    const whitespaceCharacters = [
      "\u0009",
      "\u000b",
      "\u000c",
      "\u0020",
      "\u00a0",
      "\u1680",
      "\u2000",
      "\u2001",
      "\u2002",
      "\u2003",
      "\u2004",
      "\u2005",
      "\u2006",
      "\u2007",
      "\u2008",
      "\u2009",
      "\u200a",
      "\u2028",
      "\u2029",
      "\u202f",
      "\u205f",
      "\u3000",
      "\ufeff",
    ];

    for (const whitespace of whitespaceCharacters) {
      expect(findMentionAfter(`instruction${whitespace}`)).not.toBeNull();
    }
  });

  test("does not open inside words, email addresses, or punctuation", () => {
    for (const prefix of ["name", "person.example", "clause-", "field_"]) {
      expect(findMentionAfter(prefix)).toBeNull();
    }
  });

  test("opens at the start of a paragraph", () => {
    expect(findMentionAfter("")).not.toBeNull();
  });

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
