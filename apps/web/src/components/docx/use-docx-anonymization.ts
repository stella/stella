import { useMemo, useRef, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import type { EditorView } from "@tiptap/pm/view";

import type { FolioAnonymizationTerm } from "@stll/folio-react";
import { useExternalSyncEffect } from "@stll/ui/effects";

import {
  useInspectorAnonymizationStore,
  useIsAnonymizationActive,
} from "@/components/inspector/inspector-anonymization-store";
import { anonymizeChatTextInWorker } from "@/lib/anonymize/anonymize-chat-worker-client";
import { queryView } from "@/lib/query-view.logic";
import { useQueryViewError } from "@/lib/use-query-view";
import { anonymizationAllowlistOptions } from "@/lib/workspaces/queries/anonymization-allowlist";
import { anonymizationTermsOptions } from "@/lib/workspaces/queries/anonymization-terms";

import { startAnonymizationDetection } from "./docx-anonymization-detection";
import {
  aggregateAnonymizationMatches,
  buildExcludedCanonicalsSet,
  mergeAnonymizationTerms,
} from "./docx-edit-mode.logic";

type UseDocxAnonymizationHighlightsOptions = {
  editorView: EditorView | null;
  entityId: string;
  fieldId: string;
  workspaceId: string;
};

/**
 * The workspace anonymization terms and the detected entities, as the
 * `anonymizationTerms` Folio highlights, and the handler that publishes
 * their occurrences to the inspector facet.
 */
export const useDocxAnonymizationHighlights = ({
  editorView,
  entityId,
  fieldId,
  workspaceId,
}: UseDocxAnonymizationHighlightsOptions) => {
  // True while the inspector's Anonymization facet is mounted.
  // We gate both the term feed *and* entity detection on
  // this so highlights paint only while the user is on that tab
  // — switching to Metadata / History / Suggestions clears the
  // overlay immediately and stops the wasm pipeline from running
  // in the background.
  const isAnonymizationActive = useIsAnonymizationActive();
  const anonymizationTermsQuery = useQuery(
    anonymizationTermsOptions(workspaceId),
  );
  const anonymizationTermsQueryView = queryView(anonymizationTermsQuery);
  useQueryViewError(
    anonymizationTermsQueryView,
    "useDocxAnonymizationHighlights:query",
  );
  // The query's own entries, a stable reference while the read stands.
  const workspaceTermEntries =
    anonymizationTermsQueryView.type === "items"
      ? anonymizationTermsQueryView.items.entries
      : null;
  // Detected-entity highlights — runs the wasm anonymization
  // pipeline against the live doc text and exposes each detected
  // entity as a Folio decoration term. Combined with workspace
  // vocabulary so the editor shows everything that *would* be
  // anonymized right now, not only the curated catalogue.
  //
  // Re-runs when the doc text changes (settled inside the
  // pipeline) so edits and reloads pick up new entities without
  // re-running on every keystroke, and does nothing while the
  // document stays unchanged.
  const [detectedAnonymizationTerms, setDetectedAnonymizationTerms] = useState<
    FolioAnonymizationTerm[]
  >([]);
  // Exposed by the detection effect below so the exclusions-watching
  // effect can kick a fresh run the moment the allowlist changes, and
  // the match callback can report document changes.
  const detectionRef = useRef<ReturnType<
    typeof startAnonymizationDetection
  > | null>(null);
  // Hold the latest exclusions in a ref so detection sees fresh
  // exclusions without re-installing itself on every keystroke /
  // mutation.
  const excludedCanonicalsRef = useRef<readonly string[]>([]);
  const allowlistQuery = useQuery({
    ...anonymizationAllowlistOptions({ workspaceId, entityId }),
    enabled: isAnonymizationActive,
  });
  const allowlistQueryView = queryView(allowlistQuery);
  useQueryViewError(
    allowlistQueryView,
    "useDocxAnonymizationHighlights:query-2",
  );
  const policyReady =
    anonymizationTermsQuery.status === "success" &&
    allowlistQuery.status === "success";
  const policyReadFailed =
    anonymizationTermsQuery.status === "error" ||
    allowlistQuery.status === "error";
  useExternalSyncEffect(() => {
    if (isAnonymizationActive && policyReadFailed) {
      useInspectorAnonymizationStore
        .getState()
        .markAnonymizationPipelineFailed(fieldId);
    }
  }, [fieldId, isAnonymizationActive, policyReadFailed]);
  useExternalSyncEffect(() => {
    const view = editorView;
    if (!view || !isAnonymizationActive || !policyReady) {
      // Never detect against missing policy. Leaving the facet or losing
      // its policy clears previous detections until a complete read returns.
      setDetectedAnonymizationTerms([]);
      return undefined;
    }
    const detection = startAnonymizationDetection({
      detect: anonymizeChatTextInWorker,
      fieldId,
      onDetected: setDetectedAnonymizationTerms,
      readExcludedCanonicals: () => excludedCanonicalsRef.current,
      view,
      workspaceId,
    });
    // Expose the detection so an outside effect can kick a fresh
    // run right after the user toggles an exclusion, and the match
    // callback can report document edits.
    detectionRef.current = detection;
    return () => {
      detectionRef.current = null;
      detection.stop();
    };
  }, [editorView, isAnonymizationActive, policyReady, workspaceId, fieldId]);
  // Per-doc allowlist: canonicals the user has flagged as false
  // positives. The chat-anon worker filters these out of its
  // detected entities itself; we still need to strip them from
  // the workspace catalog list, because catalog terms are sent
  // straight to Folio without going through the worker.
  const excludedCanonicalsSet = buildExcludedCanonicalsSet(
    allowlistQueryView.type === "items" ? allowlistQueryView.items.entries : [],
  );
  useExternalSyncEffect(() => {
    excludedCanonicalsRef.current = [...excludedCanonicalsSet];
    // Kick the detection right away so worker-found terms that
    // the user just added to the allowlist disappear.
    detectionRef.current?.run();
  }, [excludedCanonicalsSet]);
  // oxlint-disable-next-line no-manual-memo/no-manual-memo -- load-bearing, without this memo boundary the React Compiler does not cache this value
  const mergedAnonymizationTerms = useMemo<FolioAnonymizationTerm[]>(
    () =>
      mergeAnonymizationTerms({
        isAnonymizationActive,
        workspaceTerms:
          workspaceTermEntries === null
            ? []
            : workspaceTermEntries
                .filter((entry) => entry.enabled)
                .map((entry) => ({
                  canonical: entry.canonical,
                  label: entry.label,
                  variants: entry.variants,
                })),
        detectedTerms: detectedAnonymizationTerms,
        excludedCanonicals: excludedCanonicalsSet,
      }),
    [
      isAnonymizationActive,
      workspaceTermEntries,
      detectedAnonymizationTerms,
      excludedCanonicalsSet,
    ],
  );
  // Publish Folio's match list to the inspector facet so it can
  // show counts and filter the workspace vocabulary list. Folio
  // reports it through `onAnonymizationMatchesChange` each time
  // the occurrences change. Skipped state updates are no-ops
  // (zustand suppresses sets that yield identical references);
  // the entry is cleared on unmount.
  const handleAnonymizationMatchesChange = (
    matches: readonly { canonical: string; label: string }[],
  ) => {
    const { publishAnonymizationMatches } =
      useInspectorAnonymizationStore.getState();
    if (!isAnonymizationActive) {
      return;
    }
    publishAnonymizationMatches(
      fieldId,
      aggregateAnonymizationMatches(matches),
    );
  };
  useExternalSyncEffect(() => {
    const { clearAnonymizationMatches } =
      useInspectorAnonymizationStore.getState();
    if (!isAnonymizationActive) {
      clearAnonymizationMatches(fieldId);
    }
    return () => {
      clearAnonymizationMatches(fieldId);
    };
  }, [fieldId, isAnonymizationActive]);

  return {
    /** Folio highlights these terms and reports their occurrences. */
    anonymizationTerms: mergedAnonymizationTerms,
    onAnonymizationMatchesChange: handleAnonymizationMatchesChange,
    /**
     * Call on every document change, the DOCX load included: entity
     * detection rereads the text once it settles, and ignores a document
     * it already read.
     */
    noteDocumentChanged: () => {
      detectionRef.current?.noteDocChanged();
    },
  };
};

/**
 * Two-way selection bridge between this document and the inspector
 * anonymization facet, returned as the matching `DocxEditor` props.
 */
export const useDocxAnonymizationSelection = (fieldId: string) => {
  // Bridge document selections → inspector "Term to anonymize"
  // input. Folio fires `onSelectionTextChange` with the range
  // and the resolved text on every selection-bearing
  // transaction, so we just have to length-gate and publish.
  // The cleanup clears the store so a second tab opening this
  // facet doesn't see a stale prefill from the previous file.
  const handleSelectionTextChange = (selection: {
    from: number;
    to: number;
    text: string;
  }) => {
    if (selection.from === selection.to) {
      return;
    }
    const single = selection.text.replace(/\s+/gu, " ").trim();
    if (single.length < 2 || single.length > 200) {
      return;
    }
    useInspectorAnonymizationStore
      .getState()
      .publishDocumentTextSelection(fieldId, single);
  };
  useExternalSyncEffect(
    () => () => {
      useInspectorAnonymizationStore
        .getState()
        .clearDocumentTextSelection(fieldId);
    },
    [fieldId],
  );

  // - Click in document → push to store as source="doc" with
  //   this editor's fieldId so only this document's facet
  //   reacts.
  // - Selection from sidebar (source="sidebar") → forward
  //   canonical + seq to Folio only when the bridged fieldId
  //   matches. Background editor panes (cached inactive tabs)
  //   stay quiet.
  // - Doc-sourced selections aren't echoed back to the editor —
  //   that would re-scroll on its own click.
  const handleAnonymizationTermClick = (canonical: string, label: string) => {
    useInspectorAnonymizationStore
      .getState()
      .selectAnonymizationTerm(canonical, label, "doc", fieldId);
  };
  const sidebarSelectedCanonical = useInspectorAnonymizationStore((s) =>
    s.anonymizationSelection.source === "sidebar" &&
    s.anonymizationSelection.fieldId === fieldId
      ? s.anonymizationSelection.canonical
      : null,
  );
  const sidebarSelectionSeq = useInspectorAnonymizationStore((s) =>
    s.anonymizationSelection.source === "sidebar" &&
    s.anonymizationSelection.fieldId === fieldId
      ? s.anonymizationSelection.seq
      : 0,
  );

  return {
    anonymizationSelectionSeq: sidebarSelectionSeq,
    onAnonymizationTermClick: handleAnonymizationTermClick,
    onSelectionTextChange: handleSelectionTextChange,
    selectedAnonymizationCanonical: sidebarSelectedCanonical,
  };
};
