import type { Node as PMNode } from "@tiptap/pm/model";

import type { AnonymizationTerm } from "@stll/folio-react";

import { useInspectorAnonymizationStore } from "@/components/inspector/inspector-anonymization-store";
import { getAnalytics } from "@/lib/analytics/provider";

import {
  buildAnonymizationDetectionKey,
  decideAnonymizationDetectionRun,
  dedupeDetectedAnonymizationTerms,
  shouldCommitAnonymizationDetectionResult,
} from "./docx-edit-mode.logic";

type StartAnonymizationDetectionOptions = {
  detect: (input: {
    text: string;
    workspaceId: string;
    excludedCanonicals: readonly string[];
  }) => Promise<{ pairs: readonly { original: string; label: string }[] }>;
  fieldId: string;
  onDetected: (terms: AnonymizationTerm[]) => void;
  /** Read on every run so allowlist changes apply without a restart. */
  readExcludedCanonicals: () => readonly string[];
  /** The live editor view; only its current document is read. */
  view: { readonly state: { readonly doc: PMNode } };
  workspaceId: string;
};

type AnonymizationDetection = {
  /**
   * Reports that the document may have changed. A new document schedules
   * one detection run after edits settle; the same document is a no-op.
   */
  noteDocChanged: () => void;
  /** Runs detection now, e.g. after the allowlist changed. */
  run: () => void;
  stop: () => void;
};

/**
 * Quiet period after the last edit before the whole document is detected
 * again, so a burst of keystrokes costs one worker run.
 */
const DETECTION_SETTLE_MS = 300;

/**
 * Runs the wasm anonymization pipeline against the live doc text and reports
 * each detected entity as a Folio decoration term. Work is event-driven: one
 * run at start, one per settled edit (`noteDocChanged`) or allowlist change
 * (`run`), and nothing while the document stays unchanged.
 *
 * Every run covers the whole document because detection uses cross-paragraph
 * context (coreference), and a result is only shown when it was computed for
 * the current text and allowlist.
 */
export const startAnonymizationDetection = ({
  detect,
  fieldId,
  onDetected,
  readExcludedCanonicals,
  view,
  workspaceId,
}: StartAnonymizationDetectionOptions): AnonymizationDetection => {
  let cancelled = false;
  let failedKey: string | null = null;
  // Mark the pipeline as in-flight from mount so the
  // inspector facet shows "Detecting entities…" right
  // away instead of flashing "0 entities" during the
  // 300ms gap before the first `run()` fires (and
  // before that run can call `markAnonymizationPipelineStarted`
  // itself). The first `run()` also calls it again
  // (idempotent set-add); subsequent runs flip it on
  // around each worker call.
  useInspectorAnonymizationStore
    .getState()
    .markAnonymizationPipelineStarted(fieldId);
  // Track the text+exclusions we received *results* for (not
  // just dispatched).
  //
  // Exclusions are part of the cache key: when the user marks
  // a detected entity as a false positive, the doc text is
  // unchanged but the worker needs to rerun with the new
  // allowlist so the now-excluded canonical disappears from
  // detected terms without waiting for the user to edit.
  let lastDeliveredKey: string | null = null;
  // The worker client owns the deadline. Keep one request pending until
  // it settles so slow scans never accumulate duplicate document jobs.
  let requestStatus: "idle" | "running" = "idle";
  // ProseMirror documents are immutable, so the same node always has the
  // same text: serialize each document once, however often it is checked.
  let lastRead: { doc: PMNode; text: string } | null = null;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  const clearSettleTimer = () => {
    if (settleTimer !== null) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
  };
  const markRan = () =>
    useInspectorAnonymizationStore
      .getState()
      .markAnonymizationPipelineRan(fieldId);
  const readText = (): string => {
    const { doc } = view.state;
    if (lastRead !== null && lastRead.doc === doc) {
      return lastRead.text;
    }
    const text = doc.textBetween(0, doc.content.size, "\n", "\n");
    lastRead = { doc, text };
    return text;
  };
  const readDetectionInput = () => {
    const text = readText();
    const excludedCanonicals = readExcludedCanonicals();
    return {
      text,
      excludedCanonicals,
      cacheKey: buildAnonymizationDetectionKey({
        text,
        excludedCanonicals,
      }),
    };
  };
  const run = () => {
    if (cancelled) {
      return;
    }
    // This run reads the latest document, so a pending settle run is
    // redundant. While a request is in flight, its completion re-reads the
    // document and reruns when the text moved on.
    clearSettleTimer();
    // Cheap in-flight short-circuit before serializing the doc. The
    // decision helper repeats this guard for its own correctness, but the
    // read has to stay behind it.
    if (requestStatus === "running") {
      return;
    }
    const { text, excludedCanonicals, cacheKey } = readDetectionInput();
    if (cacheKey === failedKey) {
      return;
    }
    const decision = decideAnonymizationDetectionRun({
      text,
      cacheKey,
      lastDeliveredKey,
      requestStatus,
    });
    if (decision.action === "skip") {
      return;
    }
    if (decision.action === "markRan") {
      // Empty doc: nothing to detect. Release the
      // "in flight" lock so the facet exits the
      // "Detecting…" placeholder instead of stalling
      // on the mount-time mark.
      markRan();
      return;
    }
    if (decision.action === "alreadyDelivered") {
      // Already delivered for this exact text +
      // exclusions; no-op without flipping the
      // started state (we're not running anything).
      return;
    }
    requestStatus = "running";
    // (Re-)mark started: handles reruns triggered by
    // edits or allowlist changes after the first run
    // already called `markAnonymizationPipelineRan`.
    useInspectorAnonymizationStore
      .getState()
      .markAnonymizationPipelineStarted(fieldId);
    detect({
      text,
      workspaceId,
      excludedCanonicals,
    })
      .then((result) => {
        requestStatus = "idle";
        if (cancelled) {
          return;
        }
        if (
          !shouldCommitAnonymizationDetectionResult({
            currentKey: readDetectionInput().cacheKey,
            requestKey: cacheKey,
          })
        ) {
          run();
          return;
        }
        lastDeliveredKey = cacheKey;
        failedKey = null;
        onDetected(dedupeDetectedAnonymizationTerms(result.pairs));
        markRan();
        return;
      })
      .catch((error: unknown) => {
        requestStatus = "idle";
        if (cancelled) {
          return;
        }
        if (
          !shouldCommitAnonymizationDetectionResult({
            currentKey: readDetectionInput().cacheKey,
            requestKey: cacheKey,
          })
        ) {
          getAnalytics().captureError(error);
          run();
          return;
        }
        failedKey = cacheKey;
        getAnalytics().captureError(error);
        useInspectorAnonymizationStore
          .getState()
          .markAnonymizationPipelineFailed(fieldId);
      });
  };
  const scheduleRun = () => {
    clearSettleTimer();
    settleTimer = setTimeout(run, DETECTION_SETTLE_MS);
  };
  // The doc text isn't always populated when the view first captures (lazy
  // DOCX load, async paged rendering); the load itself is a document change
  // and reaches `noteDocChanged`.
  scheduleRun();
  return {
    noteDocChanged: () => {
      if (cancelled || view.state.doc === lastRead?.doc) {
        return;
      }
      scheduleRun();
    },
    run,
    stop: () => {
      cancelled = true;
      clearSettleTimer();
    },
  };
};
