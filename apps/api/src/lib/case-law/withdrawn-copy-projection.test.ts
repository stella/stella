import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { proveTextOnlyPersistedChatMessageContent } from "@/api/lib/chat/persisted-message-content";

import {
  decisionReferencesIn,
  WithdrawnCopyProjection,
} from "./withdrawn-copy-projection";
import { WITHDRAWN_COPY_REGISTRY } from "./withdrawn-copy-registry";

const id = toSafeId<"caseLawDecision">("abcdef01-0000-4000-8000-000000000001");
const marker = "Withdrawn by publisher";
const projection = new WithdrawnCopyProjection([id], marker);
const content = proveTextOnlyPersistedChatMessageContent({
  version: 3,
  data: [
    {
      type: "text",
      content: `Stored quote [decision](#stella-decision=${id})`,
    },
  ],
});

describe("withdrawn decision copies", () => {
  test("only complete UUIDs in decision hrefs become corpus references", () => {
    for (let length = 0; length < id.length; length++) {
      expect(
        decisionReferencesIn(`#stella-decision=${id.slice(0, length)}`).size,
      ).toBe(0);
    }
    expect([...decisionReferencesIn(`#stella-decision=${id}`)]).toEqual([id]);
  });
  test("UUID spelling does not change the withdrawal verdict", () => {
    expect(id.toUpperCase()).not.toBe(id);
    expect(projection.marker(null, id.toUpperCase())).toBe(marker);
    expect(projection.marker({ decisionId: id.toUpperCase() })).toBe(marker);
  });
  test("finds explicit identities in nested snapshots and citation text", () => {
    const refs = decisionReferencesIn({
      output: { value: { decisionId: id } },
      citation: `[paragraph](#stella-decision-passage=${id}:paragraph-1)`,
    });
    expect([...refs]).toEqual([id]);
    expect(decisionReferencesIn({ decisionId: "invalid" }).size).toBe(0);
  });

  test("keeps user text and coordinates while replacing every selected quote", () => {
    const annotation = {
      quote: "Selected judgment text",
      quotePrefix: "The court held: ",
      quoteSuffix: " in this case.",
      body: "My own note",
      blockAnchorId: "paragraph-7",
      startOffset: 12,
      endOffset: 34,
    };
    expect(projection.annotation(annotation, id)).toEqual({
      ...annotation,
      quote: marker,
      quotePrefix: marker,
      quoteSuffix: marker,
    });
    expect(projection.annotation(annotation, null)).toBe(annotation);
    const answer = {
      decisionId: id,
      quote: "First quote",
      continuationSpans: [
        { paragraphId: "p2", startOffset: 2, endOffset: 8, quote: "Second" },
      ],
    };
    const masked = projection.answer(answer);
    expect(masked.quote).toBe(marker);
    expect(masked.continuationSpans).toEqual([
      { paragraphId: "p2", startOffset: 2, endOffset: 8, quote: marker },
    ]);
    expect(answer.quote).toBe("First quote");
  });

  test("every registry quote column for annotation is masked and other fields stay unchanged", () => {
    const quoteFields = Object.values(WITHDRAWN_COPY_REGISTRY).flatMap(
      ({ fields }) =>
        Object.entries(fields).flatMap(([field, policy]) =>
          policy.kind === "quote" && policy.projection === "annotation"
            ? [field]
            : [],
        ),
    );
    expect(quoteFields).toContain("quote");
    const retained = {
      body: "Reader note",
      blockAnchorId: "paragraph-3",
      startOffset: 2,
      endOffset: 17,
    };
    const row = {
      quote: "Copied words",
      ...Object.fromEntries(
        quoteFields.map(
          (field) => [field, `Copied words for ${field}`] as const,
        ),
      ),
      ...retained,
    };
    const masked = projection.annotation(row, id);
    for (const field of quoteFields) {
      expect(Reflect.get(masked, field)).toBe(marker);
      expect(Reflect.get(row, field)).toBe(`Copied words for ${field}`);
    }
    expect(masked).toMatchObject(retained);
    expect(Object.keys(masked).toSorted()).toEqual(Object.keys(row).toSorted());
    expect(projection.annotation(row, null)).toBe(row);
  });

  test("replaces assistant snapshots and preserves user messages exactly", () => {
    const assistant = { role: "assistant", content };
    expect(projection.chat(assistant).content.data).toEqual([
      { type: "text", content: marker },
    ]);
    const user = { role: "user", content };
    expect(projection.chat(user, id)).toBe(user);
    const unaffected = {
      role: "assistant",
      content: proveTextOnlyPersistedChatMessageContent({
        version: 3,
        data: [{ type: "text", content: "Another decision" }],
      }),
    };
    expect(projection.chat(unaffected)).toBe(unaffected);
  });

  test("masks assistant citations to another withdrawn decision", () => {
    const row = {
      role: "assistant",
      content: "Derived explanation",
      citations: [{ decisionId: id, paragraphId: "p1" }],
    } satisfies Parameters<WithdrawnCopyProjection["answerMessage"]>[0];
    expect(
      projection.answerMessage(row, "00000000-0000-4000-8000-000000000002"),
    ).toEqual({
      ...row,
      content: marker,
      citations: [],
    });
    expect(projection.answerMessage({ ...row, role: "user" }, id).content).toBe(
      row.content,
    );
  });
});

test("tagged decision identities share the canonical verdict and authored thread titles are retained", () => {
  const tagged = [
    { targetType: "decision", targetId: id },
    { target: { type: "case_law_decision", id } },
  ];
  for (const value of tagged) {
    expect([...decisionReferencesIn(value)]).toEqual([id]);
    expect(projection.marker(value)).toBe(marker);
  }
  const row = {
    title: "Own title",
    titleSource: "user" as const,
    subjectDecisionId: id,
    recapText: "Generated summary",
  };
  expect(projection.thread(row)).toMatchObject({
    title: row.title,
    recapText: marker,
  });
  expect(projection.thread({ ...row, titleSource: "ai" })).toMatchObject({
    title: marker,
    recapText: marker,
  });
});

test("assistant text links retain their decision association without a citation record", () => {
  const row = {
    role: "assistant" as const,
    content: `Derived explanation [decision](#stella-decision=${id})`,
    citations: [],
  };
  expect(
    projection.answerMessage(row, "00000000-0000-4000-8000-000000000002"),
  ).toEqual({ ...row, content: marker, citations: [] });
});
