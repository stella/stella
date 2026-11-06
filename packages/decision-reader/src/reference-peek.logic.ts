import type { ReactElement } from "react";

import { panic } from "better-result";

import {
  BookTextIcon,
  FileTextIcon,
  ScrollTextIcon,
  TextQuoteIcon,
} from "@stll/ui/icons";
import type { LucideIcon } from "@stll/ui/icons";

import { isPlainPrimaryClick } from "./citation-click";
import type { CitationClick } from "./citation-click";

/**
 * Hover intent, the same for every peek. The pointer has to rest on a
 * reference this long before its peek opens, so reading across a line of
 * citations opens none of them.
 */
export const PEEK_OPEN_DELAY_MS = 400;
/**
 * How long a peek stays after the pointer leaves its reference. The pointer
 * crossing the gap into the card (inside Base UI's safe triangle) keeps it
 * open; this covers a path that cuts a corner on the way.
 */
export const PEEK_CLOSE_DELAY_MS = 250;

/** Where a peek can send the reader, in the order its header lists them. */
export const PEEK_ACTION = {
  openInSidePanel: "openInSidePanel",
  openInStella: "openInStella",
  openOriginal: "openOriginal",
} as const;
type PeekAction = keyof typeof PEEK_ACTION;

type PeekKindSpec = {
  /** Drawn at the start of the header, so the kind reads at a glance. */
  icon: LucideIcon;
  /** The actions this kind can offer; each still needs a target to show. */
  actions: readonly PeekAction[];
};

/**
 * Every kind of reference that peeks, with its header icon and its actions.
 * A new kind lands only with both decided.
 */
export const REFERENCE_PEEK_KINDS = {
  decision: {
    icon: FileTextIcon,
    actions: [
      PEEK_ACTION.openInSidePanel,
      PEEK_ACTION.openInStella,
      PEEK_ACTION.openOriginal,
    ],
  },
  provision: {
    icon: BookTextIcon,
    actions: [
      PEEK_ACTION.openInSidePanel,
      PEEK_ACTION.openInStella,
      PEEK_ACTION.openOriginal,
    ],
  },
  // An act cited as a whole has no publisher copy the reader links to.
  statute: {
    icon: ScrollTextIcon,
    actions: [PEEK_ACTION.openInSidePanel, PEEK_ACTION.openInStella],
  },
  // A citation the corpus could not resolve: stella holds nothing to open,
  // and the citation row carries no publisher address.
  unresolvedCitation: {
    icon: TextQuoteIcon,
    actions: [],
  },
} as const satisfies Record<string, PeekKindSpec>;
export type ReferencePeekKind = keyof typeof REFERENCE_PEEK_KINDS;

type PeekActionTargets = {
  /** Opens the reference beside the text; null where nothing can dock. */
  openInSidePanel: (() => void) | null;
  /** A router link to the reference's own page; null when stella has none. */
  openInStella: ReactElement | null;
  /** The publisher's copy; null when the source names none. */
  openOriginal: string | null;
};

/** Exactly the action targets a kind offers: no more, no fewer. */
type ReferencePeekActions<Kind extends ReferencePeekKind> = Pick<
  PeekActionTargets,
  (typeof REFERENCE_PEEK_KINDS)[Kind]["actions"][number]
>;

/** One peek's kind with the targets of its actions. */
export type ReferencePeekTarget = {
  [Kind in ReferencePeekKind]: {
    kind: Kind;
    actions: ReferencePeekActions<Kind>;
  };
}[ReferencePeekKind];

export type PeekActionItem =
  | { type: typeof PEEK_ACTION.openInSidePanel; open: () => void }
  | { type: typeof PEEK_ACTION.openInStella; link: ReactElement }
  | { type: typeof PEEK_ACTION.openOriginal; href: string };

type PeekActionItemsOptions = {
  target: ReferencePeekTarget;
  /** False on a phone, where there is no side panel beside the text. */
  sidePanelAvailable: boolean;
};

/** The actions a peek shows, in its kind's order, each with a target. */
export const peekActionItems = ({
  target,
  sidePanelAvailable,
}: PeekActionItemsOptions): PeekActionItem[] => {
  const targets: Partial<PeekActionTargets> = target.actions;
  const items: PeekActionItem[] = [];
  for (const action of REFERENCE_PEEK_KINDS[target.kind].actions) {
    switch (action) {
      case PEEK_ACTION.openInSidePanel: {
        const open = targets.openInSidePanel;
        if (open !== undefined && open !== null && sidePanelAvailable) {
          items.push({ type: action, open });
        }
        break;
      }
      case PEEK_ACTION.openInStella: {
        const link = targets.openInStella;
        if (link !== undefined && link !== null) {
          items.push({ type: action, link });
        }
        break;
      }
      case PEEK_ACTION.openOriginal: {
        const href = targets.openOriginal;
        if (href !== undefined && href !== null && href !== "") {
          items.push({ type: action, href });
        }
        break;
      }
      default:
        action satisfies never;
        return panic(`Unhandled peek action: ${String(action)}`);
    }
  }
  return items;
};

/** What a click on a reference that peeks does. */
export const PEEK_TRIGGER_CLICK = {
  /** A plain click opens the peek and keeps it open after the pointer leaves. */
  open: "open",
  /** A browser navigation gesture keeps the meaning the browser gives it. */
  navigate: "navigate",
} as const;

export const peekTriggerClick = (gesture: CitationClick) =>
  isPlainPrimaryClick(gesture)
    ? PEEK_TRIGGER_CLICK.open
    : PEEK_TRIGGER_CLICK.navigate;
