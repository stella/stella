import { createContext, use, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

import { panic } from "better-result";

/**
 * The surfaces that dock above the composer, in the order they stack upward
 * from it: the review pill sits on the bar, the thread card above both.
 */
export type DockedChatSlot = "review" | "thread";

type DockedChatSlots = Readonly<Record<DockedChatSlot, HTMLElement | null>>;

type DockedChatSlotRef = (element: HTMLElement | null) => () => void;

type DockedChatStackValue = {
  slots: DockedChatSlots;
  slotRefs: Readonly<Record<DockedChatSlot, DockedChatSlotRef>>;
};

const DockedChatStackContext = createContext<DockedChatStackValue | null>(null);

const NO_SLOTS: DockedChatSlots = { review: null, thread: null };

const withSlot = (
  slots: DockedChatSlots,
  slot: DockedChatSlot,
  element: HTMLElement | null,
): DockedChatSlots => {
  if (slots[slot] === element) {
    return slots;
  }
  return slot === "thread"
    ? { review: slots.review, thread: element }
    : { review: element, thread: slots.thread };
};

/**
 * One chat surface per host: the composer's column registers a slot for each
 * docked surface, and the surfaces render into it. The thread card and the
 * review pill are therefore laid out in the composer's own column (its width,
 * its inset, its bottom anchor) instead of guessing where the composer is.
 */
export const DockedChatStackProvider = ({
  children,
}: {
  children: ReactNode;
}) => {
  const [slots, setSlots] = useState<DockedChatSlots>(NO_SLOTS);
  const [slotRefs] = useState(() => {
    const refFor =
      (slot: DockedChatSlot): DockedChatSlotRef =>
      (element) => {
        setSlots((current) => withSlot(current, slot, element));
        return () => {
          setSlots((current) =>
            current[slot] === element ? withSlot(current, slot, null) : current,
          );
        };
      };
    return { review: refFor("review"), thread: refFor("thread") };
  });
  return (
    <DockedChatStackContext value={{ slots, slotRefs }}>
      {children}
    </DockedChatStackContext>
  );
};

/** The composer column's registration for one slot; undefined outside a stack. */
export const useDockedChatSlotRef = (
  slot: DockedChatSlot,
): DockedChatSlotRef | undefined => use(DockedChatStackContext)?.slotRefs[slot];

/** Whether this host's composer column is mounted and offers `slot`. */
export const useDockedChatSlot = (slot: DockedChatSlot): HTMLElement | null =>
  use(DockedChatStackContext)?.slots[slot] ?? null;

/** Marks the composer column every docked surface renders into. */
export const DOCKED_CHAT_COLUMN_SLOT = "docked-chat-column";

/** The `<body>` child holding `node`: the app root, or a portalled layer. */
const bodyLayerOf = (node: Node): Node | null => {
  let current = node;
  while (current.parentNode !== null) {
    if (current.parentNode === current.ownerDocument?.body) {
      return current;
    }
    current = current.parentNode;
  }
  return null;
};

/**
 * Whether a press landed on the page the chat floats over (the document or
 * reader text) rather than on the chat itself. A press anywhere in the
 * composer column (thread card, chips, composer, status row) is the chat's,
 * and so is one in a portalled layer such as a menu, a tooltip or a dialog:
 * those sit beside the app root under `<body>`, opened from the chat or
 * covering it.
 */
export const isPressOutsideDockedChat = ({
  column,
  target,
}: {
  column: Element;
  target: EventTarget | null;
}): boolean => {
  if (!(target instanceof Node) || column.contains(target)) {
    return false;
  }
  const layer = bodyLayerOf(target);
  return layer !== null && layer === bodyLayerOf(column);
};

type DockedChatSurfaceProps = {
  slot: DockedChatSlot;
  children: ReactNode;
};

/**
 * Renders a docked surface into the composer column. A surface outside a
 * stack is a host that forgot the provider, which would leave it drawn
 * nowhere, so it fails loudly instead.
 */
export const DockedChatSurface = ({
  slot,
  children,
}: DockedChatSurfaceProps) => {
  const stack = use(DockedChatStackContext);
  if (stack === null) {
    return panic("A docked chat surface needs a DockedChatStackProvider host");
  }
  const element = stack.slots[slot];
  return element === null ? null : createPortal(children, element);
};
