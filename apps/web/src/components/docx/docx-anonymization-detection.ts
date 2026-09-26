import type { EditorView } from "prosemirror-view";

import type { AnonymizationTerm } from "@stll/folio-react";

import { useInspectorAnonymizationStore } from "@/components/inspector/inspector-anonymization-store";
import { getAnalytics } from "@/lib/analytics/provider";
import { anonymizeChatTextInWorker } from "@/lib/anonymize/anonymize-chat-worker-client";

import {
  buildAnonymizationDetectionKey,
  decideAnonymizationDetectionRun,
  dedupeDetectedAnonymizationTerms,
  shouldCommitAnonymizationDetectionResult,
} from "./docx-edit-mode.logic";

type StartAnonymizationDetectionOptions = {
  fieldId: string;
  onDetected: (terms: AnonymizationTerm[]) => void;
  /** Read on every run so allowlist changes apply without a restart. */
  readExcludedCanonicals: () => readonly string[];
  view: EditorView;
  workspaceId: string;
};

type AnonymizationDetection = {
  /** Kicks a detection run now instead of waiting for the heartbeat. */
  run: () => void;
  stop: () => void;
};

/**
 * Runs the wasm anonymization pipeline against the live doc text on a slow
 * heartbeat and reports each detected entity as a Folio decoration term.
 */
export const startAnonymizationDetection = ({
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
  // just dispatched). The worker can occasionally drop a
  // request across dev HMR (the singleton's pending map loses
  // entries when the client module re-evaluates); the next tick
  // simply re-dispatches until results actually land.
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
  const markRan = () =>
    useInspectorAnonymizationStore
      .getState()
      .markAnonymizationPipelineRan(fieldId);
  const readDetectionInput = () => {
    const text = view.state.doc.textBetween(
      0,
      view.state.doc.content.size,
      "\n",
      "\n",
    );
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
    // Cheap in-flight short-circuit before serializing the doc:
    // `view.state.doc.textBetween` walks the whole ProseMirror
    // tree, so on large DOCX files we must not pay it every 2s
    // tick while a worker request is still pending. The decision
    // helper repeats this guard for its own correctness, but the
    // expensive read has to stay behind it.
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
    anonymizeChatTextInWorker({
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
  // The doc text isn't always populated when the view first
  // captures (lazy DOCX load, async paged rendering). Slow
  // heartbeat catches it shortly after, and also picks up
  // edits without per-keystroke pipeline runs. The same-text
  // guard above no-ops re-runs once the doc is steady.
  const initialTimer = setTimeout(run, 300);
  const heartbeat = setInterval(run, 2000);
  return {
    run,
    stop: () => {
      cancelled = true;
      clearTimeout(initialTimer);
      clearInterval(heartbeat);
    },
  };
};
