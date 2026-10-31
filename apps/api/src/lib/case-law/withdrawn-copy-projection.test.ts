import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import type { StoredArtefactProvenance } from "@/api/lib/chat/artefact-provenance";
import { proveTextOnlyPersistedChatMessageContent } from "@/api/lib/chat/persisted-message-content";

import {
  decisionReferencesIn,
  WithdrawnCopyProjection,
} from "./withdrawn-copy-projection";

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
    const annotation = { quote: "Selected judgment text", body: "My own note" };
    expect(projection.annotation(annotation, id)).toEqual({
      ...annotation,
      quote: marker,
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
    generationProvenance: null,
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
  ).toEqual({
    ...row,
    content: marker,
    citations: [],
  });
});

describe("thread title withdrawal projection", () => {
  const generated = (decisionIds: readonly string[]) =>
    ({
      version: 1,
      slots: {
        title: {
          type: "generated",
          generator: "apps/api/src/handlers/chat/generate-thread-title.ts",
          decisionIds: [...decisionIds],
          coverage: "complete",
        },
      },
    }) satisfies StoredArtefactProvenance;

  const thread = (
    titleSource: "ai" | "user",
    generationProvenance?: StoredArtefactProvenance | null,
    recapText?: string | null,
  ) => ({
    title: "A title without a decision reference",
    titleSource,
    subjectDecisionId: null,
    generationProvenance,
    ...(recapText === undefined ? {} : { recapText }),
  });

  test("masks generated title by its captured source even when title text has no reference", () => {
    expect(projection.thread(thread("ai", generated([id]))).title).toBe(marker);
  });

  test("title provenance does not assign sources to a legacy recap", () => {
    const row = projection.thread(
      thread("ai", generated([id]), "Independent legacy recap"),
    );
    expect(row.title).toBe(marker);
    expect(row.recapText).toBe("Independent legacy recap");
  });

  test("user title source always preserves the title", () => {
    expect(projection.thread(thread("user", generated([id]))).title).toBe(
      "A title without a decision reference",
    );
  });

  test("authored title origin overrides a stale ai title source", () => {
    const provenance = {
      version: 1,
      slots: { title: { type: "authored" } },
    } satisfies StoredArtefactProvenance;
    expect(
      projection.thread({ ...thread("ai", provenance), subjectDecisionId: id })
        .title,
    ).toBe("A title without a decision reference");
  });

  test("title source stays scoped to its slot when recap text names a withdrawn decision", () => {
    const provenance = {
      version: 1,
      slots: {
        title: {
          type: "generated",
          generator: "apps/api/src/handlers/chat/generate-thread-title.ts",
          decisionIds: [],
          coverage: "complete",
        },
        recap: {
          type: "generated",
          generator: "apps/api/src/handlers/chat/thread-recap.ts",
          decisionIds: [id],
          coverage: "complete",
        },
      },
    } satisfies StoredArtefactProvenance;
    const row = projection.thread(
      thread(
        "ai",
        provenance,
        `Recap refers to [decision](#stella-decision=${id})`,
      ),
    );
    expect(row.title).toBe("A title without a decision reference");
    expect(row.recapText).toBe(marker);
  });

  test("active or empty title sources ignore unrelated messages", () => {
    const active = projection.thread({
      ...thread("ai", generated(["00000000-0000-4000-8000-000000000002"])),
      messages: [`Message refers to [decision](#stella-decision=${id})`],
    });
    const empty = projection.thread({
      ...thread("ai", generated([])),
      messages: [`Message refers to [decision](#stella-decision=${id})`],
    });
    expect(active.title).toBe("A title without a decision reference");
    expect(empty.title).toBe("A title without a decision reference");
  });

  test("legacy missing or null title origin keeps the subject decision rule", () => {
    expect(
      projection.thread({ ...thread("ai"), subjectDecisionId: id }).title,
    ).toBe(marker);
    expect(
      projection.thread({ ...thread("ai", null), subjectDecisionId: id }).title,
    ).toBe(marker);
  });
});
