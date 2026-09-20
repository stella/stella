/**
 * The hosted DOCX editor's registry, plus the DOM handles the host needs to
 * move the live editor between slots. The decisions live in
 * `docx-editor-host.logic.ts`; this module only holds them and owns the
 * sweep timer.
 */

import { create } from "zustand";

import { Temporal } from "@stll/time";

import {
  claimDocxEditorSlot,
  DOCX_EDITOR_RELEASE_GRACE_MS,
  EMPTY_DOCX_EDITOR_REGISTRY,
  nextDocxEditorSweepAt,
  releaseDocxEditorSlot,
  selectMountedDocxEditorClaim,
  sweepDocxEditorRegistry,
} from "./docx-editor-host.logic";
import type {
  DocxEditorClaim,
  DocxEditorHostRegistry,
  DocxEditorSlotName,
} from "./docx-editor-host.logic";

/** Assigned once per slot mount so a release names exactly what it claimed. */
let slotSequence = 0;
export const nextDocxEditorSlotSequence = (): number => {
  slotSequence += 1;
  return slotSequence;
};

const slotElementKey = (hostKey: string, slot: DocxEditorSlotName): string =>
  `${hostKey}#${slot}`;

type DocxEditorHostState = {
  registry: DocxEditorHostRegistry;
  /** Where each slot's empty target div is, once it has mounted. */
  slotElements: Readonly<Record<string, HTMLElement>>;
  /** Which slot each instance's DOM node currently sits in. A slot draws its
   *  loading shell until the editor has actually landed in it. */
  attachedSlots: Readonly<Record<string, DocxEditorSlotName>>;
};

type DocxEditorHostActions = {
  claimSlot: (hostKey: string, claim: DocxEditorClaim) => void;
  releaseSlot: (args: {
    hostKey: string;
    sequence: number;
    slot: DocxEditorSlotName;
  }) => void;
  /** `element: null` releases, and only if the slot still holds the element the
   *  caller registered — a fast remount otherwise clears the new one. */
  setSlotElement: (args: {
    element: HTMLElement | null;
    hostKey: string;
    released?: HTMLElement | null;
    slot: DocxEditorSlotName;
  }) => void;
  setAttachedSlot: (hostKey: string, slot: DocxEditorSlotName) => void;
};

export const useDocxEditorHostStore = create<
  DocxEditorHostState & DocxEditorHostActions
>()((set) => ({
  registry: EMPTY_DOCX_EDITOR_REGISTRY,
  slotElements: {},
  attachedSlots: {},

  claimSlot: (hostKey, claim) => {
    set((state) => ({
      registry: claimDocxEditorSlot(state.registry, { claim, hostKey }),
    }));
  },

  releaseSlot: ({ hostKey, sequence, slot }) => {
    set((state) => ({
      registry: releaseDocxEditorSlot(state.registry, {
        hostKey,
        now: Temporal.Now.instant().epochMilliseconds,
        sequence,
        slot,
      }),
    }));
    armSweep();
  },

  setSlotElement: ({ element, hostKey, released, slot }) => {
    const key = slotElementKey(hostKey, slot);
    set((state) => {
      if (element === null) {
        const held = state.slotElements[key];
        if (
          held === undefined ||
          (released !== null && released !== undefined && held !== released)
        ) {
          return state;
        }
        const { [key]: _dropped, ...rest } = state.slotElements;
        return { slotElements: rest };
      }
      if (state.slotElements[key] === element) {
        return state;
      }
      return { slotElements: { ...state.slotElements, [key]: element } };
    });
  },

  setAttachedSlot: (hostKey, slot) => {
    set((state) =>
      state.attachedSlots[hostKey] === slot
        ? state
        : { attachedSlots: { ...state.attachedSlots, [hostKey]: slot } },
    );
  },
}));

let sweepTimer: ReturnType<typeof setTimeout> | null = null;

/** One timer for the whole registry, re-armed for the earliest deadline. */
const armSweep = () => {
  if (sweepTimer !== null) {
    clearTimeout(sweepTimer);
    sweepTimer = null;
  }
  const due = nextDocxEditorSweepAt(
    useDocxEditorHostStore.getState().registry,
    DOCX_EDITOR_RELEASE_GRACE_MS,
  );
  if (due === null) {
    return;
  }
  sweepTimer = setTimeout(
    () => {
      sweepTimer = null;
      const now = Temporal.Now.instant().epochMilliseconds;
      useDocxEditorHostStore.setState((state) => {
        const registry = sweepDocxEditorRegistry(state.registry, {
          graceMs: DOCX_EDITOR_RELEASE_GRACE_MS,
          now,
        });
        if (registry === state.registry) {
          return state;
        }
        return {
          registry,
          attachedSlots: Object.fromEntries(
            Object.entries(state.attachedSlots).filter(
              ([hostKey]) => hostKey in registry,
            ),
          ),
        };
      });
      armSweep();
    },
    Math.max(0, due - Temporal.Now.instant().epochMilliseconds),
  );
};

export const selectDocxEditorHostKeys = (
  state: DocxEditorHostState,
): readonly string[] => Object.keys(state.registry);

/**
 * The claim the instance renders under. Read against the slots that have
 * registered their element, so the claim and the DOM node the editor is moved
 * into always name the same slot.
 */
export const selectDocxEditorClaim = (
  state: DocxEditorHostState,
  hostKey: string,
): DocxEditorClaim | null =>
  selectMountedDocxEditorClaim(
    state.registry[hostKey],
    (slot) => state.slotElements[slotElementKey(hostKey, slot)] !== undefined,
  );

export const selectDocxEditorSlotElement = (
  state: DocxEditorHostState,
  hostKey: string,
  slot: DocxEditorSlotName | undefined,
): HTMLElement | null =>
  slot === undefined
    ? null
    : (state.slotElements[slotElementKey(hostKey, slot)] ?? null);
