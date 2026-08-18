import { describe, expect, test } from "bun:test";

import { compileCreateDocumentSourceToDocument } from "@/components/chat/create-document-compiler";
import {
  advanceCreateDocumentDraftPreview,
  type CreateDocumentDraftPreviewState,
} from "@/components/chat/create-document-draft-preview.logic";

// The legal-source shape the create-document tool streams (mirrors the mock
// scenario the e2e drafting spec drives): directives, a clause with a body,
// a table, signatures. Streamed one character at a time it passes through
// every partial-directive and partial-row state the compiler rejects.
const SOURCE =
  "@doc kind=agreement locale=en page=A4\n" +
  "@title MUTUAL NON-DISCLOSURE AGREEMENT\n" +
  "@clause Definition of Confidential Information\n" +
  "Confidential Information means any information disclosed by " +
  "[[Disclosing Party]] to [[Receiving Party]].\n" +
  "@table Parties\n" +
  "| Party | Role |\n" +
  "| [[Party A]] | Disclosing |\n" +
  "| [[Party B]] | Receiving |\n" +
  "@signatures\nparty: [[Party A]]\nparty: [[Party B]]\n";
const NAME = "Mutual NDA";

const prefixes = Array.from({ length: SOURCE.length }, (_, index) =>
  SOURCE.slice(0, index + 1),
);

const compilesOk = (source: string) =>
  compileCreateDocumentSourceToDocument(source, { titleFallback: NAME })
    .status === "ok";

const streamPrefixes = () => {
  const states: CreateDocumentDraftPreviewState[] = [];
  let state: CreateDocumentDraftPreviewState | null = null;
  for (const source of prefixes) {
    state = advanceCreateDocumentDraftPreview(state, {
      name: NAME,
      source,
      status: "streaming",
    });
    states.push(state);
  }
  return states;
};

describe("advanceCreateDocumentDraftPreview", () => {
  test("the streamed source passes through prefixes the compiler rejects", () => {
    // Guards the fallback below against vacuity: if every prefix compiled,
    // "never drops the preview" would hold without any carry-over.
    const rejected = prefixes.filter((source) => !compilesOk(source));
    expect(rejected.length).toBeGreaterThan(0);
    expect(compilesOk(SOURCE)).toBe(true);
  });

  test("while streaming, a rejected prefix keeps the last compiled preview", () => {
    const states = streamPrefixes();
    const firstCompiled = states.findIndex((state) => state.preview !== null);
    expect(firstCompiled).toBeGreaterThanOrEqual(0);

    let shownLength = 0;
    for (const state of states.slice(firstCompiled)) {
      expect(state.preview).not.toBeNull();
      // Every shown document compiled from a prefix of the stream, and the
      // shown prefix only grows.
      expect(state.preview?.source).toBe(
        SOURCE.slice(0, state.preview?.source.length),
      );
      expect(compilesOk(state.preview?.source ?? "")).toBe(true);
      expect(state.preview?.source.length).toBeGreaterThanOrEqual(shownLength);
      shownLength = state.preview?.source.length ?? shownLength;
    }
    // A prefix the compiler rejects is served from the earlier revision.
    const carried = states.find(
      (state) =>
        state.preview !== null && state.preview.source !== state.source,
    );
    expect(carried).toBeDefined();
    expect(compilesOk(carried?.source ?? "")).toBe(false);
    // The final prefix is the whole source and compiles on its own.
    expect(states.at(-1)?.preview?.source).toBe(SOURCE);
  });

  test("compiles one document per accepted prefix and reuses it while carried", () => {
    const states = streamPrefixes();
    const documents = new Set(
      states.flatMap((state) =>
        state.preview === null ? [] : [state.preview.document],
      ),
    );
    const compiledPrefixes = new Set(
      states
        .filter((state) => state.preview?.source === state.source)
        .map((state) => state.source),
    );
    expect(documents.size).toBe(compiledPrefixes.size);
  });

  test("returns the previous state when nothing relevant changed", () => {
    const first = advanceCreateDocumentDraftPreview(null, {
      name: NAME,
      source: SOURCE,
      status: "streaming",
    });
    const second = advanceCreateDocumentDraftPreview(first, {
      name: NAME,
      source: SOURCE,
      status: "streaming",
    });
    expect(second).toBe(first);
  });

  test("streaming to ready with the same source keeps the compiled document without recompiling", () => {
    const streaming = advanceCreateDocumentDraftPreview(null, {
      name: NAME,
      source: SOURCE,
      status: "streaming",
    });
    const ready = advanceCreateDocumentDraftPreview(streaming, {
      name: NAME,
      source: SOURCE,
      status: "ready",
    });
    expect(ready.status).toBe("ready");
    expect(ready.preview).toBe(streaming.preview);
  });

  test("a final source that fails to compile shows no preview even after a compiled revision", () => {
    const broken = `${SOURCE}@nonsense directive\n`;
    expect(compilesOk(broken)).toBe(false);
    const streaming = advanceCreateDocumentDraftPreview(null, {
      name: NAME,
      source: SOURCE,
      status: "streaming",
    });
    expect(streaming.preview).not.toBeNull();

    const brokenStreaming = advanceCreateDocumentDraftPreview(streaming, {
      name: NAME,
      source: broken,
      status: "streaming",
    });
    expect(brokenStreaming.preview).toBe(streaming.preview);

    const brokenReady = advanceCreateDocumentDraftPreview(brokenStreaming, {
      name: NAME,
      source: broken,
      status: "ready",
    });
    expect(brokenReady.preview).toBeNull();
  });

  test("an empty source has no preview", () => {
    expect(
      advanceCreateDocumentDraftPreview(null, {
        name: NAME,
        source: "  \n",
        status: "streaming",
      }).preview,
    ).toBeNull();
  });
});
