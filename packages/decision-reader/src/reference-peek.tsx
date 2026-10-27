import { useRef, useState } from "react";
import type { MouseEvent, ReactElement, ReactNode } from "react";

import { panic } from "better-result";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import {
  ExternalLinkIcon,
  Maximize2Icon,
  PanelRightIcon,
} from "@stll/ui/icons";
import { Popover, PopoverPopup, PopoverTrigger } from "@stll/ui/popover";
import { ScrollArea } from "@stll/ui/scroll-area";
import { containedEventHandler } from "@stll/ui/use-contained-handler";
import { useIsMobile } from "@stll/ui/use-mobile";
import { cn } from "@stll/ui/utils";

import { useReaderMessages } from "./reader-adapters";
import { useReferencePeekEpoch } from "./reference-peek-layering";
import type { ReferencePeekEpoch } from "./reference-peek-layering";
import {
  PEEK_ACTION,
  PEEK_CLOSE_DELAY_MS,
  PEEK_OPEN_DELAY_MS,
  PEEK_TRIGGER_CLICK,
  peekActionItems,
  peekTriggerClick,
  REFERENCE_PEEK_KINDS,
} from "./reference-peek.logic";
import type {
  PeekActionItem,
  ReferencePeekKind,
  ReferencePeekTarget,
} from "./reference-peek.logic";
import { sanitizeHref } from "./sanitize-href";

/**
 * The `·` before a header part belongs to the part, so a part that gives way
 * entirely takes its separator with it instead of leaving a stray dot.
 * Generated content with empty alternative text: seen, never announced.
 */
const SEPARATED_PART =
  "before:text-muted-foreground before:mx-1.5 before:content-['·'_/_'']";

/** A fact after the header's identifier, e.g. the act or the date. */
export type PeekMetaPart = {
  /** Names the part for measurement and tests, e.g. `act` or `date`. */
  part: string;
  text: string;
};

/**
 * Whether a header's actions wait for their card. A card in the text or the
 * margin sits beside many others, so its actions appear only while the reader
 * points at or focuses that card; a peek is already the one thing the reader
 * is looking at, so its actions stay.
 */
export const PEEK_ACTION_PRESENCE = {
  always: "always",
  revealOnCard: "reveal-on-card",
} as const;

export type PeekActionPresence =
  (typeof PEEK_ACTION_PRESENCE)[keyof typeof PEEK_ACTION_PRESENCE];

/**
 * Opacity alone, so the actions keep their slot (the facts beside them never
 * reflow on hover) and their tab stops (focusing one reveals them). A coarse
 * pointer cannot hover, so there they always show. The card carries
 * `group/provision-card`.
 */
const ACTION_PRESENCE_CLASS = {
  always: "",
  "reveal-on-card":
    "opacity-0 transition-opacity group-hover/provision-card:opacity-100 group-focus-within/provision-card:opacity-100 pointer-coarse:opacity-100",
} as const satisfies Record<PeekActionPresence, string>;

type ReferencePeekHeaderProps = {
  actionPresence: PeekActionPresence;
  kind: ReferencePeekKind;
  /** What the peek is about, e.g. `§ 226 odst. 1`; never shortened first. */
  primary: string;
  meta: readonly PeekMetaPart[];
  actions: readonly PeekActionItem[];
  /** Runs after any action, so a peek can close behind it. */
  onAction?: (() => void) | undefined;
};

const PeekActionButton = ({
  action,
  onAction,
}: {
  action: PeekActionItem;
  onAction: (() => void) | undefined;
}) => {
  const messages = useReaderMessages();
  // A header can sit inside a card that toggles on click; an action is not
  // a press on the card.
  const done = (event: MouseEvent<HTMLElement>) => {
    event.stopPropagation();
    onAction?.();
  };
  switch (action.type) {
    case PEEK_ACTION.openInSidePanel: {
      const label = messages["common.openInSidePanel"];
      return (
        <Button
          aria-label={label}
          data-peek-action={action.type}
          onClick={(event) => {
            action.open();
            done(event);
          }}
          size="icon-xs"
          tooltip={label}
          variant="ghost"
        >
          <PanelRightIcon aria-hidden="true" className="size-3.5" />
        </Button>
      );
    }
    case PEEK_ACTION.openInStella: {
      const label = messages["common.openInStella"];
      return (
        <Button
          aria-label={label}
          data-peek-action={action.type}
          onClick={done}
          render={action.link}
          size="icon-xs"
          tooltip={label}
          variant="ghost"
        >
          <Maximize2Icon aria-hidden="true" className="size-3.5" />
        </Button>
      );
    }
    case PEEK_ACTION.openOriginal: {
      const label = messages["inspector.external.openOriginal"];
      return (
        <Button
          aria-label={label}
          data-peek-action={action.type}
          onClick={done}
          render={
            <a
              href={sanitizeHref(action.href)}
              rel="noopener noreferrer"
              target="_blank"
            />
          }
          size="icon-xs"
          tooltip={label}
          variant="ghost"
        >
          <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
        </Button>
      );
    }
    default:
      action satisfies never;
      return panic("Unhandled peek action");
  }
};

/**
 * The one header every peek draws, and the inline provision card with it:
 * the kind's icon, one row naming the reference and its facts, and the
 * actions.
 *
 * The row never wraps, and the actions sit outside the part that gives way,
 * so they are always there to press. The identifier gives way last: the
 * first fact (the long one, an act's title or a court's name) goes first,
 * taking only the room left once the rest fit, then the later facts, and
 * the identifier is cut only when it alone is wider than the row (its full
 * text stays in the tooltip).
 */
export const ReferencePeekHeader = ({
  actionPresence,
  kind,
  primary,
  meta,
  actions,
  onAction,
}: ReferencePeekHeaderProps) => {
  const Icon = REFERENCE_PEEK_KINDS[kind].icon;
  return (
    <span
      className="reader-chrome flex min-w-0 items-center gap-1.5"
      data-kind={kind}
      data-slot="reference-peek-header"
    >
      <Icon
        aria-hidden="true"
        className="text-muted-foreground size-3.5 shrink-0"
        data-slot="reference-peek-kind"
      />
      <span
        className="flex min-w-0 flex-1 items-center overflow-hidden whitespace-nowrap"
        data-slot="reference-peek-summary"
      >
        <BidiText
          as="span"
          className="max-w-full shrink-0 truncate text-sm font-medium"
          data-slot="reference-peek-primary"
          title={primary}
        >
          {primary}
        </BidiText>
        {meta.map(({ part, text }, index) => (
          <span
            className={cn(
              "text-muted-foreground min-w-0 truncate text-xs",
              index === 0 && "max-w-max flex-1 basis-0",
              SEPARATED_PART,
            )}
            data-part={part}
            data-slot="reference-peek-meta"
            key={part}
            title={text}
          >
            <BidiText>{text}</BidiText>
          </span>
        ))}
      </span>
      {actions.length > 0 && (
        <span
          className={cn(
            "flex shrink-0 items-center gap-0.5",
            ACTION_PRESENCE_CLASS[actionPresence],
          )}
          data-slot="reference-peek-actions"
        >
          {actions.map((action) => (
            <PeekActionButton
              action={action}
              key={action.type}
              onAction={onAction}
            />
          ))}
        </span>
      )}
    </span>
  );
};

/** The actions a reference offers where it is drawn: no side panel on a phone. */
export const usePeekActionItems = (
  target: ReferencePeekTarget,
): PeekActionItem[] =>
  peekActionItems({ target, sidePanelAvailable: !useIsMobile() });

/**
 * The reference in the text that opens the peek. A link keeps every browser
 * navigation gesture; a button has none; marked text has nowhere to go and
 * still wraps with the prose around it, which a button would not.
 */
type PeekTrigger =
  | { type: "link"; element: ReactElement }
  | { type: "button"; element: ReactElement }
  | { type: "text"; element: ReactElement };

type ReferencePeekProps = {
  target: ReferencePeekTarget;
  trigger: PeekTrigger;
  /** How the reference reads in its text, added to the trigger's own. */
  className?: string | undefined;
  /** The reference as the text reads it, drawn inside the trigger. */
  children: ReactNode;
  header: { primary: string; meta: readonly PeekMetaPart[] };
  /** What this kind shows about the reference; mounted only while open. */
  body?: ReactNode;
};

type PeekState =
  { type: "closed" } | { type: "open"; epoch: ReferencePeekEpoch };

const CLOSED_PEEK = { type: "closed" } as const satisfies PeekState;

/**
 * The shell every reference peek uses: one open and close timing, one
 * header, one bounded body, one set of actions, and the layering rule in
 * `reference-peek-layering.ts`.
 *
 * Resting the pointer on the reference opens it after `PEEK_OPEN_DELAY_MS`;
 * the reference and the card are one hover region, so moving into the card
 * keeps it open. Focus opens it at once, a plain click opens it and keeps it
 * open after the pointer leaves, and Escape closes it and returns focus to
 * the reference without opening it again. Tab moves from the reference into
 * the card's actions.
 */
export const ReferencePeek = ({
  target,
  trigger,
  className,
  children,
  header,
  body,
}: ReferencePeekProps) => {
  const [state, setState] = useState<PeekState>(CLOSED_PEEK);
  const epoch = useReferencePeekEpoch();
  const focusedTrigger = useRef<HTMLElement | null>(null);
  const restoringFocus = useRef(false);
  const actions = usePeekActionItems(target);
  const open = state.type === "open" && state.epoch === epoch;

  const setOpen = (next: boolean) => {
    if (!next) {
      setState(CLOSED_PEEK);
      return;
    }
    // The selection toolbar holds every peek; see reference-peek-layering.
    if (epoch === null) {
      return;
    }
    setState({ type: "open", epoch });
  };

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        className={className}
        closeDelay={PEEK_CLOSE_DELAY_MS}
        data-peek-kind={target.kind}
        delay={PEEK_OPEN_DELAY_MS}
        nativeButton={trigger.type === "button"}
        // A reference with an address stays a link to assistive technology;
        // Base UI would announce every non-native trigger as a button.
        {...(trigger.type === "link" ? { role: "link" } : {})}
        onClick={containedEventHandler((event) => {
          // Hover or focus may already have opened the peek; a plain press
          // opens it explicitly instead of toggling it closed.
          event.preventBaseUIHandler();
          const click = peekTriggerClick(event);
          switch (click) {
            case PEEK_TRIGGER_CLICK.navigate:
              return;
            case PEEK_TRIGGER_CLICK.open:
              event.preventDefault();
              setOpen(true);
              return;
            default:
              click satisfies never;
              panic(`Unhandled peek trigger click: ${String(click)}`);
          }
        })}
        onFocus={(event) => {
          if (event.currentTarget !== event.target || restoringFocus.current) {
            return;
          }
          // Kept to hand focus back on Escape; a peek opened by hover never
          // took focus, so it has nothing to hand back.
          focusedTrigger.current = event.currentTarget;
          setOpen(true);
        }}
        openOnHover
        render={trigger.element}
        tooltip={false}
      >
        {children}
      </PopoverTrigger>
      <PopoverPopup
        align="start"
        className="reader-chrome w-[min(28rem,calc(100vw-2rem))]"
        finalFocus={() => {
          // The trigger is handed back once: a later close of a peek opened
          // by hover took no focus and must not move it to this one.
          const returnTo = focusedTrigger.current;
          focusedTrigger.current = null;
          // Restoring keyboard focus after dismissal must not reopen the peek.
          restoringFocus.current = true;
          returnTo?.focus({ preventScroll: true });
          restoringFocus.current = false;
          return false;
        }}
        padding="md"
      >
        <div
          className="flex min-w-0 flex-col gap-2"
          data-kind={target.kind}
          data-slot="reference-peek"
        >
          <ReferencePeekHeader
            actionPresence={PEEK_ACTION_PRESENCE.always}
            actions={actions}
            kind={target.kind}
            meta={header.meta}
            onAction={() => setOpen(false)}
            primary={header.primary}
          />
          {body !== undefined && (
            <ScrollArea
              axis="vertical"
              className="max-h-[min(24rem,calc(100dvh-8rem))]"
              data-slot="reference-peek-body"
              scrollFade
            >
              <div className="flex min-w-0 flex-col gap-2">{body}</div>
            </ScrollArea>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
};
