import { create } from "zustand";

import {
  type PagePoint,
  type PdfSigningStamp,
  settleDrawnStampBox,
  type StampBox,
  type StampPageSize,
} from "@/components/inspector/pdf-signing-stamp.logic";

/** A stamp box on one page of the document being signed. */
export type StampDraft = {
  box: StampBox;
  page: StampPageSize;
  pageIndex: number;
};

/** A drag in progress on one page: the corner it started at and where it is. */
export type StampDrawing = {
  anchor: PagePoint;
  current: PagePoint;
  page: StampPageSize;
  pageIndex: number;
  pointerId: number;
};

export type PdfSignPlacementNotice = "page_too_small";

/**
 * Placing the stamp on the pages of one PDF, in whichever viewer shows that
 * file. `confirm` hands the result to whoever started the placement: a
 * stamp, or `undefined` to sign without a visible mark.
 */
export type PdfSignPlacementSession = {
  confirm: (stamp: PdfSigningStamp | undefined) => void;
  draft: StampDraft | null;
  drawing: StampDrawing | null;
  fieldId: string;
  notice: PdfSignPlacementNotice | null;
};

type PdfSignPlacementState = {
  session: PdfSignPlacementSession | null;
};

export const usePdfSignPlacementStore = create<PdfSignPlacementState>()(() => ({
  session: null,
}));

const updateSession = (
  update: (session: PdfSignPlacementSession) => PdfSignPlacementSession,
) => {
  usePdfSignPlacementStore.setState(({ session }) => ({
    session: session === null ? null : update(session),
  }));
};

/** Start placing the stamp on `fieldId`'s pages; replaces any other placement. */
export const beginPdfSignPlacement = ({
  confirm,
  fieldId,
}: Pick<PdfSignPlacementSession, "confirm" | "fieldId">) => {
  usePdfSignPlacementStore.setState({
    session: { confirm, draft: null, drawing: null, fieldId, notice: null },
  });
};

export const endPdfSignPlacement = () => {
  usePdfSignPlacementStore.setState({ session: null });
};

/** Finish placement with `stamp` (or none) and hand it to whoever started it. */
export const confirmPdfSignPlacement = (stamp: PdfSigningStamp | undefined) => {
  const { session } = usePdfSignPlacementStore.getState();
  if (session === null) {
    return;
  }
  endPdfSignPlacement();
  session.confirm(stamp);
};

export const setPdfSignDraft = (draft: StampDraft) => {
  updateSession((session) => ({ ...session, draft, notice: null }));
};

export const showPdfSignNotice = (notice: PdfSignPlacementNotice) => {
  updateSession((session) => ({ ...session, notice }));
};

export const startPdfSignDrawing = (drawing: StampDrawing) => {
  updateSession((session) => ({ ...session, drawing, notice: null }));
};

export const movePdfSignDrawing = (current: PagePoint) => {
  updateSession((session) =>
    session.drawing === null
      ? session
      : { ...session, drawing: { ...session.drawing, current } },
  );
};

/** Release the drag: what it drew, settled within the limits, becomes the stamp. */
export const finishPdfSignDrawing = (pointerId: number) => {
  updateSession((session) => {
    const { drawing } = session;
    if (drawing?.pointerId !== pointerId) {
      return session;
    }
    const box = settleDrawnStampBox(drawing);
    return box === null
      ? { ...session, drawing: null, notice: "page_too_small" }
      : {
          ...session,
          draft: { box, page: drawing.page, pageIndex: drawing.pageIndex },
          drawing: null,
        };
  });
};

export const cancelPdfSignDrawing = (pointerId: number) => {
  updateSession((session) =>
    session.drawing?.pointerId === pointerId
      ? { ...session, drawing: null }
      : session,
  );
};

const mountedViewers = new Map<string, number>();

/**
 * Count a viewer showing `fieldId`. Placement ends once the last viewer of
 * its file goes away, so it never waits on a page nobody can see. The check
 * runs after the current commit, so a viewer that remounts in the same
 * commit keeps the placement.
 */
export const attachPdfSignViewer = (fieldId: string) => {
  mountedViewers.set(fieldId, (mountedViewers.get(fieldId) ?? 0) + 1);
  return () => {
    const remaining = (mountedViewers.get(fieldId) ?? 1) - 1;
    if (remaining > 0) {
      mountedViewers.set(fieldId, remaining);
    } else {
      mountedViewers.delete(fieldId);
    }
    queueMicrotask(() => {
      if (
        !mountedViewers.has(fieldId) &&
        usePdfSignPlacementStore.getState().session?.fieldId === fieldId
      ) {
        endPdfSignPlacement();
      }
    });
  };
};
