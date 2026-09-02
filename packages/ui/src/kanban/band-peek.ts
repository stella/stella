/**
 * The peek a collapsed band opens while a pointer rests on its folded slot,
 * as a state machine with an injectable scheduler so its timing rules can be
 * tested without a DOM.
 *
 * Two rules keep a peek from fighting the pointer:
 *
 *  - A slot that appeared under the pointer does not peek. Folding a band
 *    from its caption leaves the new slot right under the cursor; the first
 *    movement there must not reopen what was just closed. The band is
 *    suppressed until the pointer leaves the slot once.
 *  - A peek ends only after the pointer has left every part of the open
 *    band for a short linger. The band renders as separate elements (its
 *    caption, then its columns in each lane), so moving from the caption
 *    down into a column crosses an element boundary; without the linger the
 *    band would fold under the pointer and the slot would peek it straight
 *    back open.
 */

/** How long a pointer rests on a folded slot before the band peeks open. */
export const KANBAN_BAND_PEEK_DELAY_MS = 400;

/** How long the pointer may be outside an open band before the peek ends. */
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
  /** The pointer moved inside a band's folded slot. */
  slotPointerMove: (bandId: string) => void;
  /** The pointer left a band's folded slot. */
  slotPointerLeave: (bandId: string) => void;
  /** The pointer entered a part of a band that is rendered open. */
  openPointerEnter: (bandId: string) => void;
  /** The pointer left a part of a band that is rendered open. */
  openPointerLeave: (bandId: string) => void;
  /**
   * The band was folded by a pointer on its caption, so its slot now sits
   * under the pointer; it must not peek until the pointer leaves the slot.
   */
  foldedUnderPointer: (bandId: string) => void;
  /**
   * The band was folded without a pointer on it (keyboard, or a controlled
   * caller): any peek ends, and the slot may peek on the next hover.
   */
  bandFolded: (bandId: string) => void;
  /** The band was pinned open (its toggle, or a peek confirmed by a click). */
  bandExpanded: (bandId: string) => void;
  /**
   * A band's folded slot left the DOM (the band expanded or disappeared) so
   * a peek it was about to open, or a suppression it carried, no longer
   * applies.
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
  let suppressedBandId: string | null = null;
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
    slotPointerMove: (bandId) => {
      if (
        suppressedBandId === bandId ||
        peekingBandId === bandId ||
        openingBandId === bandId
      ) {
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
    slotPointerLeave: (bandId) => {
      if (openingBandId === bandId) {
        clearOpenTimer();
      }
      if (suppressedBandId === bandId) {
        suppressedBandId = null;
      }
    },
    openPointerEnter: (bandId) => {
      if (peekingBandId === bandId) {
        clearEndTimer();
      }
    },
    openPointerLeave: (bandId) => {
      if (peekingBandId !== bandId || cancelEnd !== null) {
        return;
      }
      cancelEnd = schedule(() => {
        cancelEnd = null;
        setPeeking(null);
      }, lingerMs);
    },
    foldedUnderPointer: (bandId) => {
      bandFolded(bandId);
      suppressedBandId = bandId;
    },
    bandFolded,
    bandExpanded: (bandId) => {
      if (openingBandId === bandId) {
        clearOpenTimer();
      }
      if (suppressedBandId === bandId) {
        suppressedBandId = null;
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
      if (suppressedBandId === bandId) {
        suppressedBandId = null;
      }
    },
    dispose: () => {
      clearOpenTimer();
      clearEndTimer();
    },
  };
};
