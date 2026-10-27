import { Schema } from "@tiptap/pm/model";
import type { Node as PMNode } from "@tiptap/pm/model";
import { afterEach, beforeEach, expect, jest, test } from "bun:test";

import type { AnonymizationTerm } from "@stll/folio-react";

import { useInspectorAnonymizationStore } from "@/components/inspector/inspector-anonymization-store";

import {
  confirmAnonymizationDetectionCurrent,
  startAnonymizationDetection,
} from "./docx-anonymization-detection";

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*" },
    text: {},
  },
});

const PERSON = "Jana Nováková";

const paragraphText = (index: number, revision = 0) =>
  `Clause ${index}.${revision}: ${PERSON} signs for the buyer in Brno.`;

type Work = {
  /** Detection passes that read the input (text + allowlist). */
  checks: number;
  /** Whole-document text reads (`doc.textBetween` over the full range). */
  serializations: number;
  serializedChars: number;
  /** Detection requests sent to the worker. */
  requests: number;
  requestedChars: number;
  deliveries: number;
};

const emptyWork = (): Work => ({
  checks: 0,
  serializations: 0,
  serializedChars: 0,
  requests: 0,
  requestedChars: 0,
  deliveries: 0,
});

type PendingDetection = {
  text: string;
  resolve: () => void;
  reject: (error: Error) => void;
};

/**
 * Drives `startAnonymizationDetection` against a real ProseMirror document
 * on Bun's fake clock and counts every unit of work it does: full-document
 * reads, worker requests and timers left armed. Detection answers
 * immediately unless `holdRequests` keeps them pending.
 */
const createHarness = ({
  paragraphCount,
  holdRequests = false,
  failRequests = false,
}: {
  paragraphCount: number;
  holdRequests?: boolean;
  failRequests?: boolean;
}) => {
  let work = emptyWork();
  let requestsFail = failRequests;
  const paragraphs = Array.from({ length: paragraphCount }, (_, index) =>
    paragraphText(index),
  );
  const countReads = (doc: PMNode): PMNode => {
    const textBetween = doc.textBetween.bind(doc);
    doc.textBetween = (...args: Parameters<PMNode["textBetween"]>) => {
      const text = textBetween(...args);
      work.serializations += 1;
      work.serializedChars += text.length;
      return text;
    };
    return doc;
  };
  const buildDoc = () =>
    countReads(
      schema.node(
        "doc",
        null,
        paragraphs.map((text) =>
          schema.node("paragraph", null, schema.text(text)),
        ),
      ),
    );
  const view = { state: { doc: buildDoc() } };
  const fieldId = `field-${paragraphCount}`;
  const requestTexts: string[] = [];
  const pending: PendingDetection[] = [];
  let delivered: AnonymizationTerm[] = [];
  const detection = startAnonymizationDetection({
    // oxlint-disable-next-line typescript/promise-function-async -- the fake returns the pending promise directly
    detect: ({ text }) => {
      work.requests += 1;
      work.requestedChars += text.length;
      requestTexts.push(text);
      const pairs = text.includes(PERSON)
        ? [{ original: PERSON, label: "person" }]
        : [];
      if (requestsFail) {
        return Promise.reject(new Error("detection failed"));
      }
      if (!holdRequests) {
        return Promise.resolve({ pairs });
      }
      return new Promise((resolve, reject) => {
        pending.push({ text, resolve: () => resolve({ pairs }), reject });
      });
    },
    fieldId,
    onDetected: (terms) => {
      work.deliveries += 1;
      delivered = terms;
    },
    readExcludedCanonicals: () => {
      work.checks += 1;
      return [];
    },
    view,
    workspaceId: "workspace-1",
  });
  // Promise callbacks run on microtasks, which the fake clock does not drive.
  const flush = async () => {
    for (let turn = 0; turn < 8; turn += 1) {
      await Promise.resolve();
    }
  };
  const advance = async (ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 100) {
      jest.advanceTimersByTime(Math.min(100, ms - elapsed));
      await flush();
    }
  };
  /** Edits the document; `reported: false` simulates a missed Folio emission. */
  const editParagraph = (
    index: number,
    revision: number,
    { reported = true }: { reported?: boolean } = {},
  ) => {
    paragraphs[index] = paragraphText(index, revision);
    view.state = { doc: buildDoc() };
    if (reported) {
      detection.noteDocChanged();
    }
  };
  const status = () =>
    useInspectorAnonymizationStore.getState()
      .anonymizationPipelineStatusByFieldId[fieldId] ?? "idle";

  return {
    advance,
    detection,
    editParagraph,
    fieldId,
    flush,
    get delivered() {
      return delivered;
    },
    pending,
    requestTexts,
    resetWork: () => {
      work = emptyWork();
    },
    recoverWorker: () => {
      requestsFail = false;
    },
    status,
    get work() {
      return work;
    },
  };
};

beforeEach(() => {
  jest.useFakeTimers();
  useInspectorAnonymizationStore.setState({
    anonymizationDetectionsByFieldId: {},
    anonymizationPipelineStatusByFieldId: {},
  });
});

afterEach(() => {
  jest.useRealTimers();
});

const PARAGRAPHS = 100;
const SIZES = [PARAGRAPHS, PARAGRAPHS * 10] as const;

for (const paragraphCount of SIZES) {
  test(`an unchanged ${paragraphCount}-paragraph document costs no work per idle minute`, async () => {
    const harness = createHarness({ paragraphCount });
    await harness.advance(1000);
    expect(harness.work.requests).toBe(1);
    expect(harness.delivered).toEqual([{ canonical: PERSON, label: "person" }]);

    harness.resetWork();
    await harness.advance(60_000);

    expect(harness.work).toEqual(emptyWork());
    expect(jest.getTimerCount()).toBe(0);
    harness.detection.stop();
  });

  test(`one edit to a ${paragraphCount}-paragraph document reads and detects it once`, async () => {
    const harness = createHarness({ paragraphCount });
    await harness.advance(1000);
    harness.resetWork();

    harness.editParagraph(Math.floor(paragraphCount / 2), 1);
    await harness.advance(5000);

    expect(harness.work.serializations).toBe(1);
    expect(harness.work.requests).toBe(1);
    expect(harness.work.deliveries).toBe(1);
    // Detection keeps whole-document context (coreference spans
    // paragraphs), so the one request carries the edited paragraph
    // together with the rest of the text.
    expect(harness.requestTexts.at(-1)).toContain(
      paragraphText(Math.floor(paragraphCount / 2), 1),
    );
    expect(jest.getTimerCount()).toBe(0);
    harness.detection.stop();
  });
}

test("a burst of keystrokes settles into one detection request", async () => {
  const harness = createHarness({ paragraphCount: PARAGRAPHS });
  await harness.advance(1000);
  harness.resetWork();

  for (let revision = 1; revision <= 20; revision += 1) {
    harness.editParagraph(3, revision);
    await harness.advance(50);
  }
  await harness.advance(5000);

  expect(harness.work.serializations).toBe(1);
  expect(harness.work.requests).toBe(1);
  expect(harness.requestTexts.at(-1)).toContain(paragraphText(3, 20));
  expect(jest.getTimerCount()).toBe(0);
  harness.detection.stop();
});

test("a match-list echo without a document change does no work", async () => {
  const harness = createHarness({ paragraphCount: PARAGRAPHS });
  await harness.advance(1000);
  harness.resetWork();

  harness.detection.noteDocChanged();
  await harness.advance(5000);

  expect(harness.work).toEqual(emptyWork());
  expect(jest.getTimerCount()).toBe(0);
  harness.detection.stop();
});

test("an edit made while detection runs is detected before results are shown", async () => {
  const harness = createHarness({
    paragraphCount: PARAGRAPHS,
    holdRequests: true,
  });
  await harness.advance(1000);
  expect(harness.pending).toHaveLength(1);

  harness.editParagraph(7, 1);
  await harness.advance(5000);
  // The first request is still pending; nothing new is dispatched yet.
  expect(harness.pending).toHaveLength(1);

  harness.pending[0]?.resolve();
  await harness.flush();
  // The stale result is not shown; the edited text is detected instead.
  expect(harness.work.deliveries).toBe(0);
  expect(harness.pending).toHaveLength(2);
  expect(harness.pending[1]?.text).toContain(paragraphText(7, 1));

  harness.pending[1]?.resolve();
  await harness.flush();
  expect(harness.work.deliveries).toBe(1);
  expect(harness.delivered).toEqual([{ canonical: PERSON, label: "person" }]);
  harness.detection.stop();
});

test.each([true, false])(
  "an edit whose settle timer expires during a failed request reaches a replacement detection (replacement succeeds: %s)",
  async (replacementSucceeds) => {
    const harness = createHarness({
      paragraphCount: PARAGRAPHS,
      holdRequests: true,
    });
    await harness.advance(1000);
    expect(harness.pending).toHaveLength(1);
    expect(harness.pending.at(0)?.text).not.toContain(paragraphText(7, 1));

    harness.editParagraph(7, 1);
    await harness.advance(5000);
    expect(harness.pending).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(0);

    harness.pending.at(0)?.reject(new Error("The original detection failed"));
    await harness.flush();
    expect(harness.work.deliveries).toBe(0);
    expect(harness.pending).toHaveLength(2);
    expect(harness.pending.at(1)?.text).toContain(paragraphText(7, 1));
    expect(harness.status()).toBe("running");

    if (replacementSucceeds) {
      harness.pending.at(1)?.resolve();
    } else {
      harness.pending.at(1)?.reject(new Error("The current detection failed"));
    }
    await harness.flush();
    await harness.advance(5000);
    expect(harness.pending).toHaveLength(2);
    expect(jest.getTimerCount()).toBe(0);
    expect(harness.status()).toBe(replacementSucceeds ? "ready" : "error");
    expect(harness.work.deliveries).toBe(replacementSucceeds ? 1 : 0);
    expect(confirmAnonymizationDetectionCurrent(harness.fieldId)).toBe(
      replacementSucceeds,
    );
    expect(harness.pending).toHaveLength(2);
    harness.detection.stop();
  },
);

test("an edit Folio never reports is detected before the anonymized download proceeds", async () => {
  const harness = createHarness({ paragraphCount: PARAGRAPHS });
  await harness.advance(1000);
  expect(confirmAnonymizationDetectionCurrent(harness.fieldId)).toBe(true);
  expect(harness.status()).toBe("ready");

  harness.editParagraph(42, 1, { reported: false });
  harness.resetWork();
  await harness.advance(60_000);
  // Nothing noticed the edit on its own.
  expect(harness.work.requests).toBe(0);

  // The gate refuses, leaves the ready state and detects the current text.
  expect(confirmAnonymizationDetectionCurrent(harness.fieldId)).toBe(false);
  expect(harness.status()).toBe("running");
  expect(harness.work.requests).toBe(1);
  expect(harness.requestTexts.at(-1)).toContain(paragraphText(42, 1));

  await harness.flush();
  expect(harness.status()).toBe("ready");
  expect(confirmAnonymizationDetectionCurrent(harness.fieldId)).toBe(true);
  expect(harness.work.requests).toBe(1);
  harness.detection.stop();
});

test("the download gate refuses while detection for the current text runs", async () => {
  const harness = createHarness({
    paragraphCount: PARAGRAPHS,
    holdRequests: true,
  });
  await harness.advance(1000);
  expect(harness.pending).toHaveLength(1);

  expect(confirmAnonymizationDetectionCurrent(harness.fieldId)).toBe(false);
  // The in-flight request already covers this text; nothing is duplicated.
  expect(harness.pending).toHaveLength(1);

  harness.pending[0]?.resolve();
  await harness.flush();
  expect(confirmAnonymizationDetectionCurrent(harness.fieldId)).toBe(true);
  harness.detection.stop();
});

test("the download gate refuses when detection failed for the current text", async () => {
  const harness = createHarness({
    paragraphCount: PARAGRAPHS,
    failRequests: true,
  });
  await harness.advance(1000);
  expect(harness.status()).toBe("error");

  expect(confirmAnonymizationDetectionCurrent(harness.fieldId)).toBe(false);
  expect(harness.status()).toBe("error");
  harness.detection.stop();
});

test("a stopped detection no longer gates its field", async () => {
  const harness = createHarness({
    paragraphCount: PARAGRAPHS,
    holdRequests: true,
  });
  await harness.advance(1000);
  expect(confirmAnonymizationDetectionCurrent(harness.fieldId)).toBe(false);

  harness.detection.stop();
  harness.detection.stop();
  expect(confirmAnonymizationDetectionCurrent(harness.fieldId)).toBe(true);
});

test("closing the last editor for a field leaves no gate entry in the store", async () => {
  const docked = createHarness({ paragraphCount: PARAGRAPHS });
  const fullView = createHarness({ paragraphCount: PARAGRAPHS });
  expect(docked.fieldId).toBe(fullView.fieldId);
  await docked.advance(1000);
  const entries = () =>
    useInspectorAnonymizationStore.getState().anonymizationDetectionsByFieldId;
  expect(entries()[docked.fieldId]).toHaveLength(2);

  docked.detection.stop();
  expect(entries()[docked.fieldId]).toHaveLength(1);

  fullView.detection.stop();
  expect(docked.fieldId in entries()).toBe(false);
});

test("a successful editor cannot hide another editor's failure and retry recovers that editor", async () => {
  const failed = createHarness({
    paragraphCount: PARAGRAPHS,
    failRequests: true,
  });
  const successful = createHarness({
    paragraphCount: PARAGRAPHS,
    holdRequests: true,
  });
  await failed.advance(1000);
  expect(failed.status()).toBe("error");
  successful.pending.at(0)?.resolve();
  await successful.flush();
  expect(successful.status()).toBe("error");
  expect(confirmAnonymizationDetectionCurrent(failed.fieldId)).toBe(false);

  failed.recoverWorker();
  useInspectorAnonymizationStore
    .getState()
    .retryAnonymizationPipeline(failed.fieldId);
  await failed.flush();
  expect(failed.work.requests).toBe(2);
  expect(successful.work.requests).toBe(1);
  expect(failed.status()).toBe("ready");
  expect(confirmAnonymizationDetectionCurrent(failed.fieldId)).toBe(true);
  failed.detection.stop();
  successful.detection.stop();
});

test("closing one editor preserves the other editor's error and retry state", async () => {
  const failed = createHarness({
    paragraphCount: PARAGRAPHS,
    failRequests: true,
  });
  const successful = createHarness({ paragraphCount: PARAGRAPHS });
  await failed.advance(1000);
  successful.detection.stop();
  useInspectorAnonymizationStore
    .getState()
    .clearAnonymizationMatches(failed.fieldId);
  expect(failed.status()).toBe("error");
  expect(confirmAnonymizationDetectionCurrent(failed.fieldId)).toBe(false);
  failed.detection.stop();
});
