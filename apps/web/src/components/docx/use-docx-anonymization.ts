import { useCallback, useMemo, useRef, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { Result } from "better-result";
import type { EditorView } from "prosemirror-view";

import { setAnonymizationTermsMeta } from "@stll/folio-react";
import type { AnonymizationTerm } from "@stll/folio-react";

import {
  useInspectorAnonymizationStore,
  useIsAnonymizationActive,
} from "@/components/inspector/inspector-anonymization-store";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { getAnalytics } from "@/lib/analytics/provider";
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
 * Feeds the workspace anonymization terms and the detected entities into
 * Folio's decoration plugin, and returns the handler that publishes the
 * plugin's live match list to the inspector facet.
 */
export const useDocxAnonymizationHighlights = ({
  editorView,
  entityId,
  fieldId,
  workspaceId,
}: UseDocxAnonymizationHighlightsOptions) => {
  // True while the inspector's Anonymization facet is mounted.
  // We gate both the term feed *and* the detection heartbeat on
  // this so highlights paint only while the user is on that tab
  // — switching to Metadata / History / Suggestions clears the
  // overlay immediately and stops the wasm pipeline from running
  // in the background.
  const isAnonymizationActive = useIsAnonymizationActive();
  const anonymizationTermsQuery = useQuery(
    anonymizationTermsOptions(workspaceId),
  );
  const workspaceAnonymizationTerms = useMemo<AnonymizationTerm[]>(() => {
    if (!anonymizationTermsQuery.data) {
      return [];
    }
    return anonymizationTermsQuery.data.entries
      .filter((entry) => entry.enabled)
      .map((entry) => ({
        canonical: entry.canonical,
        label: entry.label,
        variants: entry.variants,
      }));
  }, [anonymizationTermsQuery.data]);
  // Detected-entity highlights — runs the wasm anonymization
  // pipeline against the live doc text and exposes each detected
  // entity as a Folio decoration term. Combined with workspace
  // vocabulary so the editor shows everything that *would* be
  // anonymized right now, not only the curated catalogue.
  //
  // Re-runs when the doc text changes (debounced inside the
  // pipeline) so edits and reloads pick up new entities without
  // re-running on every keystroke.
  const [detectedAnonymizationTerms, setDetectedAnonymizationTerms] = useState<
    AnonymizationTerm[]
  >([]);
  // Exposed by the detection heartbeat effect below so the
  // exclusions-watching effect can kick a fresh run the moment
  // the allowlist changes, instead of waiting for the next 2s
  // heartbeat tick.
  const runDetectionRef = useRef<(() => void) | null>(null);
  // Hold the latest exclusions in a ref so the detection heartbeat
  // sees fresh exclusions without re-installing itself on every
  // keystroke / mutation.
  const excludedCanonicalsRef = useRef<readonly string[]>([]);
  const detectionRetry = useInspectorAnonymizationStore(
    (state) => state.anonymizationRetryByFieldId[fieldId] ?? 0,
  );
  useExternalSyncEffect(() => {
    const view = editorView;
    if (!view || !isAnonymizationActive) {
      // Facet not on screen: skip the wasm pipeline entirely and
      // drop any previously detected terms so a re-mount starts
      // from a clean slate.
      setDetectedAnonymizationTerms([]);
      return undefined;
    }
    const detection = startAnonymizationDetection({
      fieldId,
      onDetected: setDetectedAnonymizationTerms,
      readExcludedCanonicals: () => excludedCanonicalsRef.current,
      view,
      workspaceId,
    });
    // Expose `run` so an outside effect can kick a fresh
    // detection right after the user toggles an exclusion,
    // without waiting up to a heartbeat tick for the new
    // allowlist to take effect.
    runDetectionRef.current = detection.run;
    return () => {
      runDetectionRef.current = null;
      detection.stop();
    };
  }, [editorView, isAnonymizationActive, workspaceId, fieldId, detectionRetry]);
  // Per-doc allowlist: canonicals the user has flagged as false
  // positives. The chat-anon worker filters these out of its
  // detected entities itself; we still need to strip them from
  // the workspace catalog list, because catalog terms are sent
  // straight to Folio without going through the worker.
  const allowlistQuery = useQuery({
    ...anonymizationAllowlistOptions({ workspaceId, entityId }),
    enabled: isAnonymizationActive,
  });
  const excludedCanonicalsSet = useMemo(
    () =>
      buildExcludedCanonicalsSet(
        allowlistQuery.data ? allowlistQuery.data.entries : [],
      ),
    [allowlistQuery.data],
  );
  useExternalSyncEffect(() => {
    // oxlint-disable-next-line react/immutability -- latest-ref mirror consumed by the polling effect, never rendered
    excludedCanonicalsRef.current = [...excludedCanonicalsSet];
    // Kick the detection right away so worker-found terms that
    // the user just added to the allowlist disappear without
    // having to wait up to 2s for the next heartbeat tick.
    runDetectionRef.current?.();
  }, [excludedCanonicalsSet]);
  const mergedAnonymizationTerms = useMemo<AnonymizationTerm[]>(
    () =>
      mergeAnonymizationTerms({
        isAnonymizationActive,
        workspaceTerms: workspaceAnonymizationTerms,
        detectedTerms: detectedAnonymizationTerms,
        excludedCanonicals: excludedCanonicalsSet,
      }),
    [
      isAnonymizationActive,
      workspaceAnonymizationTerms,
      detectedAnonymizationTerms,
      excludedCanonicalsSet,
    ],
  );
  // Dispatch the live term list into the plugin. We can't simply
  // read matches right after `dispatch` because DOCX content
  // loads asynchronously: the first dispatch hits an empty doc
  // (matches=[]), then PM's docChanged transaction rebuilds
  // matches *later* without our effect re-firing. Publishing is
  // handled by the match callback below.
  useExternalSyncEffect(() => {
    const view = editorView;
    if (!view) {
      return;
    }
    const dispatched = Result.try(() => {
      const { key, payload } = setAnonymizationTermsMeta(
        mergedAnonymizationTerms,
      );
      view.dispatch(view.state.tr.setMeta(key, payload));
    });
    if (Result.isError(dispatched)) {
      getAnalytics().captureError(dispatched.error);
      useInspectorAnonymizationStore
        .getState()
        .markAnonymizationPipelineFailed(fieldId);
    }
  }, [editorView, mergedAnonymizationTerms, fieldId, detectionRetry]);
  // Publish the plugin's live match list to the inspector facet
  // so it can show counts and filter the workspace vocabulary
  // list. Skipped state updates are no-ops (zustand suppresses
  // sets that yield identical references); the entry is cleared
  // on unmount.
  // Wired from the plugin via Folio's
  // `onAnonymizationMatchesChange` prop. The plugin emits
  // the current match list on every transition (init, term push,
  // doc edit, async DOCX load); we mirror it into the matches
  // store so the inspector facet's counter and "matching
  // workspace terms" list stay in sync.
  const handleAnonymizationMatchesChange = useCallback(
    (matches: readonly { canonical: string; label: string }[]) => {
      const { publishAnonymizationMatches } =
        useInspectorAnonymizationStore.getState();
      if (!isAnonymizationActive) {
        return;
      }
      publishAnonymizationMatches(
        fieldId,
        aggregateAnonymizationMatches(matches),
      );
    },
    [fieldId, isAnonymizationActive],
  );
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

  return handleAnonymizationMatchesChange;
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
  const handleSelectionTextChange = useCallback(
    (selection: { from: number; to: number; text: string }) => {
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
    },
    [fieldId],
  );
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
  const handleAnonymizationTermClick = useCallback(
    (canonical: string, label: string) => {
      useInspectorAnonymizationStore
        .getState()
        .selectAnonymizationTerm(canonical, label, "doc", fieldId);
    },
    [fieldId],
  );
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
