import { describe, expect, test } from "bun:test";

import type {
  Deletion,
  Insertion,
  MoveFrom,
  MoveTo,
  Paragraph,
} from "../../types/content";
import { fromProseDoc } from "./fromProseDoc";
import { toProseDoc } from "./toProseDoc";

const REVA = { id: 1, author: "Author A", date: "2026-05-15T12:00:00Z" };
const REVB = { id: 2, author: "Author B", date: "2026-05-15T12:01:00Z" };

function paragraphWith(content: Paragraph["content"]): Paragraph {
  return {
    type: "paragraph",
    formatting: {},
    content,
  };
}

function runText(text: string): MoveTo["content"][number] {
  return {
    type: "run",
    formatting: {},
    content: [{ type: "text", text }],
  };
}

function makeMoveFrom(): MoveFrom {
  return {
    type: "moveFrom",
    info: REVA,
    content: [runText("moved away")],
  };
}

function makeMoveTo(): MoveTo {
  return {
    type: "moveTo",
    info: REVA,
    content: [runText("moved here")],
  };
}

function makeInsertion(info = REVA): Insertion {
  return {
    type: "insertion",
    info,
    content: [runText("inserted")],
  };
}

function makeDeletion(info = REVA): Deletion {
  return {
    type: "deletion",
    info,
    content: [runText("deleted")],
  };
}

function asDocument(paragraphs: Paragraph[]): never {
  return {
    package: {
      document: {
        content: paragraphs,
        finalSectionProperties: {},
      },
    },
  } as never;
}

describe("moveFrom / moveTo PM round-trip", () => {
  test("toProseDoc stamps the originating element via the moveKind mark attribute", () => {
    const doc = asDocument([
      paragraphWith([makeMoveFrom()]),
      paragraphWith([makeMoveTo()]),
    ]);
    const pmDoc = toProseDoc(doc);

    const moveFromText = pmDoc.firstChild!.firstChild!;
    const moveToText = pmDoc.child(1).firstChild!;

    const moveFromMark = moveFromText.marks.find(
      (m) => m.type.name === "deletion",
    );
    const moveToMark = moveToText.marks.find(
      (m) => m.type.name === "insertion",
    );

    expect(moveFromMark?.attrs["moveKind"]).toBe("moveFrom");
    expect(moveToMark?.attrs["moveKind"]).toBe("moveTo");
  });

  test("plain insertion / deletion marks keep moveKind = null", () => {
    const doc = asDocument([
      paragraphWith([makeInsertion()]),
      paragraphWith([makeDeletion()]),
    ]);
    const pmDoc = toProseDoc(doc);
    const insMark = pmDoc.firstChild!.firstChild!.marks.find(
      (m) => m.type.name === "insertion",
    );
    const delMark = pmDoc
      .child(1)
      .firstChild!.marks.find((m) => m.type.name === "deletion");
    expect(insMark?.attrs["moveKind"]).toBeNull();
    expect(delMark?.attrs["moveKind"]).toBeNull();
  });

  test("fromProseDoc re-emits moveFrom / moveTo elements based on moveKind", () => {
    const doc = asDocument([
      paragraphWith([makeMoveFrom()]),
      paragraphWith([makeMoveTo()]),
    ]);
    const roundtripped = fromProseDoc(toProseDoc(doc));

    const p1 = roundtripped.package.document.content[0] as Paragraph;
    const p2 = roundtripped.package.document.content[1] as Paragraph;

    expect(p1.content[0]?.type).toBe("moveFrom");
    expect(p2.content[0]?.type).toBe("moveTo");
  });

  test("coincident revisionIds across plain ins+del don't fuse into a phantom move", () => {
    // Real-world regression: two reviewers using authoring tools that
    // restart `w:id` counters can emit `<w:ins w:id="5">` and
    // `<w:del w:id="5">` for unrelated edits. The previous "is there
    // both an insertion AND a deletion with the same revisionId
    // somewhere in the document?" heuristic would re-emit both as a
    // single move pair, mis-attributing the edits.
    const doc = asDocument([
      paragraphWith([makeInsertion(REVA)]),
      paragraphWith([makeDeletion(REVA)]),
    ]);
    const roundtripped = fromProseDoc(toProseDoc(doc));

    const p1 = roundtripped.package.document.content[0] as Paragraph;
    const p2 = roundtripped.package.document.content[1] as Paragraph;

    // Both must round-trip as plain insertion/deletion — not as a
    // moveTo / moveFrom pair.
    expect(p1.content[0]?.type).toBe("insertion");
    expect(p2.content[0]?.type).toBe("deletion");
  });

  test("moveFrom / moveTo with different revisionIds still round-trip correctly", () => {
    // Equally common: real moves where `w:moveFrom w:id="3"` and
    // `w:moveTo w:id="11"` do NOT share an id. The old heuristic
    // dropped these into plain (deletion + insertion) because the
    // counts didn't pair up.
    const moveFrom: MoveFrom = {
      type: "moveFrom",
      info: REVA,
      content: [runText("moved away")],
    };
    const moveTo: MoveTo = {
      type: "moveTo",
      info: REVB,
      content: [runText("moved here")],
    };
    const doc = asDocument([
      paragraphWith([moveFrom]),
      paragraphWith([moveTo]),
    ]);
    const roundtripped = fromProseDoc(toProseDoc(doc));

    const p1 = roundtripped.package.document.content[0] as Paragraph;
    const p2 = roundtripped.package.document.content[1] as Paragraph;

    expect(p1.content[0]?.type).toBe("moveFrom");
    expect(p2.content[0]?.type).toBe("moveTo");
  });
});
