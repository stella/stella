"use client";

import { createContext, use, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, ReactNode, Ref } from "react";

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
  /** The object's actions, in menu order. Empty renders only `children`. */
  actions: readonly EntityAction[];
  /** The object, which becomes the right-click target. It may render an
   *  `EntityActionsButton` anywhere inside. */
  children: ReactNode;
  /** A line above the actions in both menus, such as when a message was
   *  sent. It is a label, not an action. */
  heading?: ReactNode;
  /** The accessible name of the "…" button, e.g. "Actions". */
  label: string;
};

type CursorAnchor = { getBoundingClientRect: () => DOMRect };

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
export const EntityActions = ({
  actions,
  children,
  heading,
  label,
}: EntityActionsProps) => {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<CursorAnchor | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const context: EntityActionsContextValue = { actions, heading, label };

  if (actions.length === 0) {
    return (
      <EntityActionsContext value={context}>{children}</EntityActionsContext>
    );
  }

  const openAt = (
    event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>,
    anchorRect: CursorAnchor,
  ) => {
    event.preventDefault();
    // The innermost object answers; the one around it does not open too.
    event.stopPropagation();
    returnFocus.current = focusReturnTarget(event.currentTarget, event.target);
    setAnchor(anchorRect);
    setOpen(true);
  };

  const handleContextMenu = (event: MouseEvent<HTMLElement>) => {
    // A portalled popup inside the object (its own "…" menu) is not the
    // object; nor is a right-click something inside already answered.
    if (
      event.defaultPrevented ||
      !(event.target instanceof Node) ||
      !event.currentTarget.contains(event.target) ||
      nativeContextMenuReason(event) !== null
    ) {
      return;
    }
    const { clientX: x, clientY: y } = event;
    openAt(event, {
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
      nativeContextMenuReason({ shiftKey: false, target }) !== null
    ) {
      return;
    }
    // The keyboard has no pointer position: open beside the focused control.
    openAt(event, {
      getBoundingClientRect: () => target.getBoundingClientRect(),
    });
  };

  return (
    <EntityActionsContext value={context}>
      {/* `contents` keeps the object's own layout: this element only listens. */}
      <div
        className="contents"
        data-slot="entity-actions"
        onContextMenu={handleContextMenu}
        onKeyDown={handleKeyDown}
        role="presentation"
      >
        {children}
      </div>
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
