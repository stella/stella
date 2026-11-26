"use client";

import { createContext, use, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, ReactNode, Ref } from "react";
import { createPortal } from "react-dom";

import { useRender } from "@base-ui/react/use-render";
import { panic } from "better-result";

import { EllipsisIcon } from "../icons";
import { nativeContextMenuReason } from "../lib/native-context-menu";
import { Button } from "./button";
import type { ContextMenuAction } from "./context-menu";
import { ContextMenuActionItems } from "./context-menu";
import {
  Menu,
  MenuAnchor,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "./menu";

// One owner for an object's actions. An object the user can act on (a
// matter, a document, a message, a row, a card, a sidebar item, a tab) hands
// `EntityActions` ONE action list; the object's "…" button
// (`EntityActionsButton`) and its right-click menu both render that list, so
// the two cannot drift apart.
//
// Right-click opens the object's actions, except where the browser's own menu
// is the one the user wants: Shift + right-click, editable text, a link, and
// selected text keep the native menu (`nativeContextMenuReason`). A nested
// object takes the click before the object around it.

/** One action of an object: the same shape `ContextMenu` renders. */
export type EntityAction = ContextMenuAction;

type EntityActionsContextValue = {
  actions: readonly EntityAction[];
  heading: ReactNode;
  label: string;
};

const EntityActionsContext = createContext<EntityActionsContextValue | null>(
  null,
);

export type EntityActionsProps = {
  /** The object's actions, in menu order. An empty list still owns the
   *  object's right-click: the native menu stays, never a parent's menu. */
  actions: readonly EntityAction[];
  /** The object, which becomes the right-click target. It may render an
   *  `EntityActionsButton` anywhere inside. */
  children: ReactNode;
  /** A line above the actions in both menus, such as when a message was
   *  sent. It is a label, not an action. */
  heading?: ReactNode;
  /** The accessible name of the "…" button, e.g. "Actions". */
  label: string;
  /**
   * Optional host element to attach the right-click listener to directly
   * (for example `<TableRow />`, where a wrapping `<div className="contents">`
   * would be invalid HTML inside `<tbody>`).
   */
  render?: useRender.RenderProp;
};

export type CursorAnchor = { getBoundingClientRect: () => DOMRect };

export type ContextMenuSurfaceOpenEvent = {
  /** Virtual anchor at pointer coordinates (or focused control for keyboard). */
  anchor: CursorAnchor;
  /** The focusable control inside the surface to return focus to on close. */
  returnFocus: HTMLElement | null;
  /** The triggering mouse or keyboard event. */
  event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>;
};

export type ContextMenuSurfaceProps = {
  children?: ReactNode;
  /** When true, right-click is still claimed so parents do not open, but the
   *  native browser menu stays. */
  disabled?: boolean;
  /** Called when a non-native right-click or context-menu key activates this
   *  surface. */
  onOpenContextMenu: (details: ContextMenuSurfaceOpenEvent) => void;
  /** Keep native browser context menu on Shift+click, editable text, links, and
   *  selected text. Defaults to true. */
  preserveNativeTargets?: boolean;
  /** Optional host element to attach the listener to directly. */
  render?: useRender.RenderProp | undefined;
};

const isContextMenuKey = (event: KeyboardEvent<HTMLElement>): boolean =>
  event.key === "ContextMenu" || (event.shiftKey && event.key === "F10");

const FOCUSABLE_SELECTOR =
  "a[href], button, input, select, textarea, [tabindex]:not([tabindex='-1'])";

/** The control focus returns to when the menu closes, inside the object. */
const focusReturnTarget = (
  container: HTMLElement,
  target: EventTarget,
): HTMLElement | null => {
  if (!(target instanceof Element)) {
    return null;
  }
  const focusable = target.closest<HTMLElement>(FOCUSABLE_SELECTOR);
  return focusable !== null && container.contains(focusable) ? focusable : null;
};

/**
 * Right-clicks (and context-menu keys) an object already answered for. The
 * innermost object owns the event even when it has no actions and leaves it
 * to the native menu, so the objects around it never open theirs. A marker
 * rather than `stopPropagation`: the native menu, and listeners further up
 * such as the desktop webview's policy, still see the event.
 */
const ownedEvents = new WeakSet<Event>();

/** Claims the event for this object; false when an inner object owns it. */
const claimEvent = (event: Event): boolean => {
  if (ownedEvents.has(event)) {
    return false;
  }
  ownedEvents.add(event);
  return true;
};

const EntityActionItems = ({
  actions,
  heading,
}: Pick<EntityActionsContextValue, "actions" | "heading">) => (
  <>
    {heading !== undefined && heading !== null && (
      <>
        <MenuGroup>
          <MenuGroupLabel className="font-normal">{heading}</MenuGroupLabel>
        </MenuGroup>
        <MenuSeparator />
      </>
    )}
    <ContextMenuActionItems actions={actions} />
  </>
);

/**
 * An object's actions: the right-click menu over `children`, and the list
 * an `EntityActionsButton` inside them opens.
 */
/**
 * Sanctioned right-click and context-menu-key surface for objects whose popup
 * is custom (rich menus, popovers, or inline rename triggers). Shares the same
 * event-claiming, native-menu preservation, keyboard support, and focus-return
 * contract as `EntityActions`.
 */
export const ContextMenuSurface = ({
  children,
  disabled = false,
  onOpenContextMenu,
  preserveNativeTargets = true,
  render,
}: ContextMenuSurfaceProps) => {
  const activate = (
    event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>,
    anchorRect: CursorAnchor,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    onOpenContextMenu({
      anchor: anchorRect,
      returnFocus: focusReturnTarget(event.currentTarget, event.target),
      event,
    });
  };

  const handleContextMenu = (event: MouseEvent<HTMLElement>) => {
    // A portalled popup inside the object (its own "…" menu) is not the
    // object; nor is a right-click something inside already answered.
    if (
      event.defaultPrevented ||
      !(event.target instanceof Node) ||
      !event.currentTarget.contains(event.target) ||
      !claimEvent(event.nativeEvent)
    ) {
      return;
    }
    if (
      disabled ||
      (preserveNativeTargets && nativeContextMenuReason(event) !== null)
    ) {
      return;
    }
    const { clientX: x, clientY: y } = event;
    activate(event, {
      getBoundingClientRect: () => new DOMRect(x, y, 0, 0),
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const target = event.target;
    if (
      event.defaultPrevented ||
      !isContextMenuKey(event) ||
      !(target instanceof Element) ||
      !event.currentTarget.contains(target) ||
      !claimEvent(event.nativeEvent)
    ) {
      return;
    }
    if (
      disabled ||
      (preserveNativeTargets &&
        nativeContextMenuReason({ shiftKey: false, target }) !== null)
    ) {
      return;
    }
    // The keyboard has no pointer position: open beside the focused control.
    activate(event, {
      getBoundingClientRect: () => target.getBoundingClientRect(),
    });
  };

  return useRender({
    defaultTagName: "div",
    render,
    props: {
      ...(render === undefined
        ? { className: "contents", role: "presentation" }
        : {}),
      // Hand-written handlers further up resolve the object a right-click
      // belongs to through this marker and leave this one alone.
      "data-context-menu-target": "",
      "data-slot": "entity-actions",
      onContextMenu: handleContextMenu,
      onKeyDown: handleKeyDown,
      children,
    },
  });
};

export const EntityActions = ({
  actions,
  children,
  heading,
  label,
  render,
}: EntityActionsProps) => {
  const [open, setOpen] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);
  const [anchor, setAnchor] = useState<CursorAnchor | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const context = useMemo<EntityActionsContextValue>(
    () => ({ actions, heading, label }),
    [actions, heading, label],
  );
  const hasActions = actions.length > 0;

  const target = (
    <ContextMenuSurface
      disabled={!hasActions}
      onOpenContextMenu={({ anchor: nextAnchor, returnFocus: nextFocus }) => {
        returnFocus.current = nextFocus;
        setHasOpened(true);
        setAnchor(nextAnchor);
        setOpen(true);
      }}
      render={render}
    >
      {children}
    </ContextMenuSurface>
  );

  const contextMenu =
    hasActions && hasOpened ? (
      <Menu
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) {
            setAnchor(null);
          }
        }}
        open={open}
      >
        <MenuAnchor />
        <MenuPopup
          anchor={anchor ?? undefined}
          data-slot="entity-actions-context-popup"
          finalFocus={() => returnFocus.current ?? false}
        >
          <EntityActionItems actions={actions} heading={heading} />
        </MenuPopup>
      </Menu>
    ) : null;

  return (
    <EntityActionsContext value={context}>
      {target}
      {contextMenu !== null &&
        typeof document !== "undefined" &&
        createPortal(contextMenu, document.body)}
    </EntityActionsContext>
  );
};

export type EntityActionsButtonProps = {
  /** Popup alignment against the button. */
  align?: "center" | "end" | "start";
  ref?: Ref<HTMLButtonElement>;
  /** Popup side against the button. */
  side?: "bottom" | "left" | "right" | "top";
};

/**
 * The "…" button of the `EntityActions` around it. It opens the same list
 * right-click opens, and renders nothing when the object has no actions.
 */
export const EntityActionsButton = ({
  align = "end",
  ref,
  side = "bottom",
}: EntityActionsButtonProps) => {
  const context = use(EntityActionsContext);
  if (context === null) {
    panic(
      "EntityActionsButton renders inside EntityActions, which owns the list it opens",
    );
  }
  if (context.actions.length === 0) {
    return null;
  }
  return (
    <Menu>
      <MenuTrigger
        ref={ref}
        render={
          <Button
            aria-label={context.label}
            className="size-6"
            size="icon-xs"
            variant="muted"
          >
            <EllipsisIcon aria-hidden="true" className="size-3.5" />
          </Button>
        }
      />
      <MenuPopup
        align={align}
        data-slot="entity-actions-button-popup"
        side={side}
      >
        <EntityActionItems
          actions={context.actions}
          heading={context.heading}
        />
      </MenuPopup>
    </Menu>
  );
};
