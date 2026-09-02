/**
 * The peek a collapsed band opens while a dragged card rests on its folded
 * slot, as a state machine with an injectable scheduler so its timing rules
 * can be tested without a DOM. A plain hover never peeks: the peek exists so
 * a drag can still land on a specific column inside a folded band, and the
 * board only feeds the controller drag events.
 *
 * One rule keeps a peek from fighting the drag: it ends only after the drag
 * has left every part of the open band for a short linger. The band renders
 * as separate elements (its caption, then its columns in each lane), so
 * moving from the caption down into a column crosses an element boundary;
 * without the linger the band would fold under the card and the slot would
 * peek it straight back open. The end of the drag, wherever it lands, ends
 * the peek at once.
 */

/** How long a dragged card rests on a folded slot before the band peeks open. */
export const KANBAN_BAND_PEEK_DELAY_MS = 400;

/** How long the drag may be outside an open band before the peek ends. */
export const KANBAN_BAND_PEEK_LINGER_MS = 150;

/** Runs `callback` after `ms`; the returned function cancels it. */
export type BandPeekScheduler = (
  callback: () => void,
  ms: number,
) => () => void;

const hostScheduler: BandPeekScheduler = (callback, ms) => {
  const timer = setTimeout(callback, ms);
  return () => clearTimeout(timer);
};

export type BandPeekControllerOptions = {
  /** Receives the band currently peeked open, or `null`. */
  onChange: (peekingBandId: string | null) => void;
  delayMs?: number;
  lingerMs?: number;
  /** Injectable so tests drive a manual clock. */
  schedule?: BandPeekScheduler;
};

export type BandPeekController = {
  /** A dragged card moved over a band's folded slot. */
  slotDragOver: (bandId: string) => void;
  /** The drag left a band's folded slot. */
  slotDragLeave: (bandId: string) => void;
  /** The drag entered a part of a band that is rendered open. */
  openDragEnter: (bandId: string) => void;
  /** The drag left a part of a band that is rendered open. */
  openDragLeave: (bandId: string) => void;
  /** The drag ended (dropped or cancelled), wherever it was. */
  dragEnded: () => void;
  /**
   * The band was folded (from its caption, the keyboard, or a controlled
   * caller): any peek ends, and the slot may peek on the next hover.
   */
  bandFolded: (bandId: string) => void;
  /** The band was pinned open (its toggle, or a peek confirmed by a click). */
  bandExpanded: (bandId: string) => void;
  /**
   * A band's folded slot left the DOM (the band expanded or disappeared) so
   * a peek it was about to open no longer applies.
   */
  slotUnmounted: (bandId: string) => void;
  /** Ends any pending timer, for unmount. */
  dispose: () => void;
};

export const createBandPeekController = ({
  onChange,
  delayMs = KANBAN_BAND_PEEK_DELAY_MS,
  lingerMs = KANBAN_BAND_PEEK_LINGER_MS,
  schedule = hostScheduler,
}: BandPeekControllerOptions): BandPeekController => {
  let peekingBandId: string | null = null;
  let cancelOpen: (() => void) | null = null;
  let openingBandId: string | null = null;
  let cancelEnd: (() => void) | null = null;

  const clearOpenTimer = () => {
    if (cancelOpen !== null) {
      cancelOpen();
      cancelOpen = null;
      openingBandId = null;
    }
  };
  const clearEndTimer = () => {
    if (cancelEnd !== null) {
      cancelEnd();
      cancelEnd = null;
    }
  };
  const setPeeking = (bandId: string | null) => {
    if (peekingBandId === bandId) {
      return;
    }
    peekingBandId = bandId;
    onChange(bandId);
  };

  const bandFolded = (bandId: string) => {
    if (openingBandId === bandId) {
      clearOpenTimer();
    }
    if (peekingBandId === bandId) {
      clearEndTimer();
      setPeeking(null);
    }
  };

  return {
    slotDragOver: (bandId) => {
      if (peekingBandId === bandId || openingBandId === bandId) {
        return;
      }
      clearOpenTimer();
      openingBandId = bandId;
      cancelOpen = schedule(() => {
        cancelOpen = null;
        openingBandId = null;
        clearEndTimer();
        setPeeking(bandId);
      }, delayMs);
    },
    slotDragLeave: (bandId) => {
      if (openingBandId === bandId) {
        clearOpenTimer();
      }
    },
    openDragEnter: (bandId) => {
      if (peekingBandId === bandId) {
        clearEndTimer();
      }
    },
    openDragLeave: (bandId) => {
      if (peekingBandId !== bandId || cancelEnd !== null) {
        return;
      }
      cancelEnd = schedule(() => {
        cancelEnd = null;
        setPeeking(null);
      }, lingerMs);
    },
    bandFolded,
    bandExpanded: (bandId) => {
      if (openingBandId === bandId) {
        clearOpenTimer();
      }
      if (peekingBandId === bandId) {
        clearEndTimer();
        setPeeking(null);
      }
    },
    slotUnmounted: (bandId) => {
      if (openingBandId === bandId) {
        clearOpenTimer();
      }
    },
    dragEnded: () => {
      clearOpenTimer();
      clearEndTimer();
      setPeeking(null);
    },
    dispose: () => {
      clearOpenTimer();
      clearEndTimer();
    },
  };
};
