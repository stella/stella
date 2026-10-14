/**
 * The verified DOCX as Folio lays it out, read-only, with the run's claims
 * marked on the painted pages in their verdict's mark and selectable by click.
 *
 * Folio paints its pages itself, so a ProseMirror decoration never reaches
 * them; the marks are CSS highlights over the painted runs, rebuilt whenever
 * Folio repaints. The document comes from a host plugin, the claims are
 * resolved against it once, and claims with no place in the original are
 * listed under the pages so they stay one click away.
 */

import * as React from "react";

import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { ScrollArea } from "@stll/ui/scroll-area";
import { textMarkHighlightRule } from "@stll/ui/text-mark";
import type { TextMarkState } from "@stll/ui/text-mark";

import { PeekPdfViewer } from "@/components/pdf/peek/peek-pdf-viewer";
import {
  claimUnderPoint,
  MARK_PRIORITY,
  paintClaimRanges,
  resolveHighlightApi,
} from "@/features/avt/original-docx-paint";
import {
  claimHighlightName,
  locateClaimsInDocument,
} from "@/features/avt/original-docx.logic";
import type { ClaimLocations } from "@/features/avt/original-docx.logic";
import { STATE_COLOR, StateSwatch } from "@/features/avt/state-chip";
import type {
  ClaimState,
  VerificationClaim,
  VerificationRun,
} from "@/features/avt/types";
import { useExternalSyncEffect, useMountEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";

const MARK_STATES = Object.keys(MARK_PRIORITY).filter(
  (mark): mark is TextMarkState => mark in MARK_PRIORITY,
);

const CLAIM_STATES = Object.keys(STATE_COLOR).filter(
  (state): state is ClaimState => state in STATE_COLOR,
);

/** Before Folio has handed over the document, no claim has a place yet. */
const NOT_YET_LOCATED: ClaimLocations = { located: [], unlocated: [] };

/** How one claim is drawn; `mark: null` leaves it unmarked but clickable. */
export type OriginalClaimMark = {
  state: ClaimState;
  mark: TextMarkState | null;
};

type OriginalDocxViewProps = {
  workspaceId: string;
  run: VerificationRun;
  claims: readonly VerificationClaim[];
  selected: VerificationClaim["id"] | null;
  markOf: (claim: VerificationClaim) => OriginalClaimMark;
  onSelect: (id: VerificationClaim["id"]) => void;
};

export const OriginalDocxView = ({
  workspaceId,
  run,
  claims,
  selected,
  markOf,
  onSelect,
}: OriginalDocxViewProps) => {
  const t = useTranslations();
  const [doc, setDoc] = React.useState<ProseMirrorNode | null>(null);
  // Folio keeps host plugins for as long as the editor is mounted, so the
  // array is made once.
  const [plugins] = React.useState(() => [createDocumentPlugin(setDoc)]);

  const locations = React.useMemo(
    () =>
      doc === null
        ? NOT_YET_LOCATED
        : locateClaimsInDocument({
            doc,
            blocks: run.blocks,
            claims: run.claims,
          }),
    [doc, run.blocks, run.claims],
  );

  const claimById = new Map(claims.map((claim) => [claim.id, claim]));
  const marks = locations.located.flatMap((location) => {
    const claim = claimById.get(location.claimId);
    return claim === undefined ? [] : [{ location, ...markOf(claim) }];
  });
  // One string for what the highlights show, so they are rebuilt only when
  // a mark changes.
  const marksKey = marks
    .map(
      ({ location, state, mark }) =>
        `${location.claimId}:${state}:${mark ?? "none"}`,
    )
    .join("|");
  const unlocated = locations.unlocated.flatMap((id) => {
    const claim = claimById.get(id);
    return claim === undefined ? [] : [claim];
  });

  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const rangesRef = React.useRef(
    new Map<VerificationClaim["id"], readonly Range[]>(),
  );
  const frameRef = React.useRef<number | null>(null);
  const highlightNames = CLAIM_STATES.flatMap((state) =>
    MARK_STATES.map((mark) => claimHighlightName(run.id, state, mark)),
  );

  // Null where the browser lacks the Custom Highlight API: nothing is
  // painted, and the ranges still answer clicks.
  const highlightApi = resolveHighlightApi(globalThis);

  const clearHighlights = useLatestCallback(() => {
    for (const name of highlightNames) {
      highlightApi?.delete(name);
    }
  });

  // Rebuild every mark from the runs Folio has painted now: a repaint (zoom,
  // a page scrolled into view) replaces the text nodes the ranges sit on.
  const paint = useLatestCallback(() => {
    frameRef.current = null;
    const root = containerRef.current;
    clearHighlights();
    rangesRef.current = new Map();
    if (root === null) {
      return;
    }
    rangesRef.current = paintClaimRanges({
      root,
      marks,
      scope: run.id,
      api: highlightApi,
    });
  });

  const schedulePaint = useLatestCallback(() => {
    if (frameRef.current === null) {
      frameRef.current = requestAnimationFrame(paint);
    }
  });

  // Folio repaints its pages on its own schedule; each repaint is new text
  // to mark.
  // A callback ref, so the observer's life is the node's (React Compiler keeps
  // its identity while `schedulePaint`'s holds).
  const observePages = (node: HTMLDivElement | null) => {
    containerRef.current = node;
    if (node === null) {
      return undefined;
    }
    const observer = new MutationObserver(schedulePaint);
    observer.observe(node, {
      characterData: true,
      childList: true,
      subtree: true,
    });
    return () => {
      observer.disconnect();
      containerRef.current = null;
    };
  };

  useMountEffect(() => () => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
    }
    clearHighlights();
  });

  // The highlights live in the browser's registry, outside React; a change
  // of mark or of where the claims are pushes into it.
  useExternalSyncEffect(() => {
    schedulePaint();
  }, [marksKey, schedulePaint]);

  const claimUnder = (event: React.MouseEvent) =>
    claimUnderPoint(rangesRef.current, { x: event.clientX, y: event.clientY });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <style>
        {CLAIM_STATES.flatMap((state) =>
          MARK_STATES.map((mark) =>
            textMarkHighlightRule({
              name: claimHighlightName(run.id, state, mark),
              variant: STATE_COLOR[state].mark.variant,
              tone: STATE_COLOR[state].mark.tone,
              state: mark,
            }),
          ),
        ).join("\n")}
      </style>
      {/* The marks are painted text, not elements: a click or a hover is
          matched against their boxes. Every claim is also reachable by
          keyboard through the stepper and the reading view. */}
      <div
        className="min-h-0 flex-1 data-[claim-hover=true]:[&_*]:cursor-pointer"
        onClickCapture={(event) => {
          const id = claimUnder(event);
          if (id !== null) {
            onSelect(id);
          }
        }}
        onMouseMove={(event) => {
          const hovering = claimUnder(event) !== null;
          event.currentTarget.dataset["claimHover"] = String(hovering);
        }}
        ref={observePages}
      >
        <PeekPdfViewer
          activePropertyId=""
          docxPlugins={plugins}
          entityId={run.entityId}
          fieldId={run.fileFieldId}
          filePurpose="native-display"
          interactionMode="preview-only"
          scaleOffset={0}
          viewId="all"
          workspaceId={workspaceId}
        />
      </div>
      {unlocated.length > 0 && (
        <div className="flex max-h-32 shrink-0 flex-col border-t">
          <ScrollArea axis="vertical" className="min-h-0">
            <div className="space-y-1.5 px-4 py-2">
              <p className="text-muted-foreground text-xs font-medium">
                {t("avt.verification.notLocated", { count: unlocated.length })}
              </p>
              <ul className="flex flex-wrap gap-1.5">
                {unlocated.map((claim) => (
                  <li className="min-w-0" key={claim.id}>
                    <Button
                      aria-pressed={claim.id === selected}
                      className="max-w-64"
                      onClick={() => onSelect(claim.id)}
                      size="sm"
                      variant={claim.id === selected ? "secondary" : "outline"}
                    >
                      <StateSwatch state={markOf(claim).state} />
                      <span className="truncate" dir="auto">
                        {claim.text}
                      </span>
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          </ScrollArea>
        </div>
      )}
    </div>
  );
};

const claimDocumentKey = new PluginKey("stella-avt-claim-document");

/** Hands the document Folio loaded (and any later replacement) to the view. */
const createDocumentPlugin = (onDocument: (doc: ProseMirrorNode) => void) =>
  new Plugin({
    key: claimDocumentKey,
    view(view) {
      onDocument(view.state.doc);
      return {
        update(nextView, previousState) {
          if (nextView.state.doc !== previousState.doc) {
            onDocument(nextView.state.doc);
          }
        },
      };
    },
  });
