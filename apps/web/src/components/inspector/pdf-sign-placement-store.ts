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
  cancel: () => void;
  confirm: (stamp: PdfSigningStamp | undefined) => void;
  draft: StampDraft | null;
  drawing: StampDrawing | null;
  fieldId: string;
  notice: PdfSignPlacementNotice | null;
  isCurrent: () => boolean;
};

type PdfSignPlacementState = {
  session: PdfSignPlacementSession | null;
  /** How many mounted viewers show each file, by field id. */
  viewers: Readonly<Record<string, number>>;
};

export const usePdfSignPlacementStore = create<PdfSignPlacementState>()(() => ({
  session: null,
  viewers: {},
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
  cancel,
  confirm,
  fieldId,
  isCurrent,
}: Pick<
  PdfSignPlacementSession,
  "cancel" | "confirm" | "fieldId" | "isCurrent"
>) => {
  if (!isCurrent()) {
    return;
  }
  usePdfSignPlacementStore.setState({
    session: {
      cancel,
      confirm,
      draft: null,
      drawing: null,
      fieldId,
      isCurrent,
      notice: null,
    },
  });
};

export const endPdfSignPlacement = () => {
  const { session } = usePdfSignPlacementStore.getState();
  usePdfSignPlacementStore.setState({ session: null });
  session?.cancel();
};

/** Finish placement with `stamp` (or none) and hand it to whoever started it. */
export const confirmPdfSignPlacement = (stamp: PdfSigningStamp | undefined) => {
  const { session } = usePdfSignPlacementStore.getState();
  if (session === null) {
    return;
  }
  usePdfSignPlacementStore.setState({ session: null });
  if (session.isCurrent()) {
    session.confirm(stamp);
  }
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

const countViewer = (fieldId: string, change: 1 | -1) => {
  usePdfSignPlacementStore.setState(({ viewers }) => {
    const { [fieldId]: current = 0, ...others } = viewers;
    const next = current + change;
    return { viewers: next > 0 ? { ...others, [fieldId]: next } : others };
  });
};

/**
 * Count a viewer showing `fieldId`. Placement ends once the last viewer of
 * its file goes away, so it never waits on a page nobody can see. The check
 * runs after the current commit, so a viewer that remounts in the same
 * commit keeps the placement.
 */
export const attachPdfSignViewer = (fieldId: string) => {
  countViewer(fieldId, 1);
  return () => {
    countViewer(fieldId, -1);
    queueMicrotask(() => {
      const { session, viewers } = usePdfSignPlacementStore.getState();
      if (viewers[fieldId] === undefined && session?.fieldId === fieldId) {
        endPdfSignPlacement();
      }
    });
  };
};
