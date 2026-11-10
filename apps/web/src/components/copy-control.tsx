// The one owner of copying to the clipboard in the app: every Copy control
// writes through `useCopyControl` or `useSelectionCopyControl`, and only this
// module touches the clipboard, listens for the document's native `copy`, or
// renders the Copy and Copied swap. `copy-feedback-owner` enforces it.

import { useRef } from "react";
import type { ComponentProps, RefObject } from "react";

import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { copyRichToClipboard, copyToClipboard } from "@stll/clipboard";
import { Button } from "@stll/ui/button";
import { CopyFeedback, useCopiedFeedback } from "@stll/ui/copy-button";
import type { CopyToClipboardIcon } from "@stll/ui/icons";
import { stellaToast } from "@stll/ui/toast";

import { nativeCopyMatches } from "@/components/copy-control.logic";
import { useMountEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { getAnalytics } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";
import { notifyUserError } from "@/lib/errors/user-toast";

/** What a Copy writes: plain text, with rich text where it has any. */
export type CopyContent = { plain: string; html?: string | undefined };

/** A control that copies a value it holds, or the reader's selected words. */
type CopyControlKind = "selection" | "value";

// Module-private: only this module's hooks can produce a control state, so a
// Copy cannot exist outside the owner.
const COPY_CONTROL_OWNER = Symbol("copy-control");

export type CopyControlState<Kind extends CopyControlKind = CopyControlKind> = {
  readonly copied: boolean;
  /** Writes the content; resolves whether it reached the clipboard. */
  readonly copy: (content: CopyContent | string) => Promise<boolean>;
  readonly kind: Kind;
  readonly owner: typeof COPY_CONTROL_OWNER;
};

// --- The document's native copy ---------------------------------------------

/** What the reader's own copy put on the clipboard. */
type NativeCopy = { selection: Selection; text: string };

type NativeCopyTarget = {
  confirm: () => void;
  /** Whether this copy put exactly the control's own payload there. */
  matches: (copy: NativeCopy) => boolean;
  selectionChanged: () => void;
};

type DocumentCopyListeners = {
  controller: AbortController;
  targets: Set<NativeCopyTarget>;
};

// One `copy` and one `selectionchange` listener per document, whatever the
// number of controls: the owner resolves which controls a native copy is for.
const documentListeners = new WeakMap<Document, DocumentCopyListeners>();

/**
 * The text a native copy leaves on the clipboard: what a surface's own copy
 * handler wrote in place of the selection (the chat transcript writes its
 * own text), otherwise the selected text the browser copies.
 */
const nativeCopyText = (event: Event, selection: Selection) => {
  const clipboardData =
    event instanceof ClipboardEvent ? event.clipboardData : null;
  const written = event.defaultPrevented
    ? clipboardData?.getData("text/plain")
    : undefined;
  return written === undefined || written === ""
    ? selection.toString()
    : written;
};

const listenersFor = (ownerDoc: Document): DocumentCopyListeners => {
  const existing = documentListeners.get(ownerDoc);
  if (existing !== undefined) {
    return existing;
  }
  const listeners: DocumentCopyListeners = {
    controller: new AbortController(),
    targets: new Set(),
  };
  const { signal } = listeners.controller;
  // On the window, so it runs after every handler on the page has written
  // the clipboard: the confirmation answers what the clipboard now holds.
  const copyTarget: Document | Window = ownerDoc.defaultView ?? ownerDoc;
  copyTarget.addEventListener(
    "copy",
    (event) => {
      const selection = ownerDoc.getSelection();
      if (selection === null || selection.isCollapsed) {
        return;
      }
      const copy = { selection, text: nativeCopyText(event, selection) };
      for (const target of listeners.targets) {
        if (target.matches(copy)) {
          target.confirm();
        }
      }
    },
    { signal },
  );
  ownerDoc.addEventListener(
    "selectionchange",
    () => {
      for (const target of listeners.targets) {
        target.selectionChanged();
      }
    },
    { signal },
  );
  documentListeners.set(ownerDoc, listeners);
  return listeners;
};

const registerNativeCopy = (
  ownerDoc: Document,
  target: NativeCopyTarget,
): (() => void) => {
  const listeners = listenersFor(ownerDoc);
  listeners.targets.add(target);
  return () => {
    listeners.targets.delete(target);
    if (listeners.targets.size === 0) {
      listeners.controller.abort();
      documentListeners.delete(ownerDoc);
    }
  };
};

// --- Controls ---------------------------------------------------------------

type CopyConfirmation = "in-place" | "toast";

const useCopyWrite = ({
  confirm,
  confirmation,
  generationRef,
}: {
  confirm: () => void;
  confirmation: CopyConfirmation;
  generationRef: RefObject<number>;
}) => {
  const t = useTranslations();
  return async (content: CopyContent | string): Promise<boolean> => {
    const generation = generationRef.current;
    const { html, plain } =
      typeof content === "string"
        ? { html: undefined, plain: content }
        : content;
    const written =
      html === undefined
        ? await copyToClipboard(plain)
        : await copyRichToClipboard({ html, plain });
    if (Result.isError(written)) {
      getAnalytics().captureError(written.error, {
        fingerprintKey: "CopyControl.copy:failure",
        scope: { type: "handler", handlerId: "CopyControl.copy:failure" },
      });
      notifyUserError(written.error, t("errors.actionFailed"));
      return false;
    }
    // A write that settles after the reader selected other words is no
    // longer a copy of what the control now offers.
    if (generation !== generationRef.current) {
      return true;
    }
    if (confirmation === "toast") {
      stellaToast.add({ title: t("common.copied"), type: "success" });
    } else {
      confirm();
    }
    return true;
  };
};

type CopyControlOptions =
  | {
      /**
       * The plain text the control writes. A native copy that leaves exactly
       * this on the clipboard (whitespace aside) confirms it too.
       */
      payload: string;
      confirmation?: "in-place";
    }
  | {
      /**
       * `toast` for a control that closes as it copies (a menu item): it has
       * nowhere to show Copied, so only its own press confirms, by toast.
       * `in-place` without a payload for a control whose value depends on
       * the choice pressed (a menu of citation formats).
       */
      confirmation: CopyConfirmation;
      payload?: undefined;
    };

/**
 * A Copy of a value the control holds: a message, a code block, a link. It
 * confirms when the clipboard holds exactly what it copies: on its press, and
 * on the reader's own copy of exactly that text.
 */
export const useCopyControl = (
  options: CopyControlOptions,
): CopyControlState<"value"> => {
  const confirmation = options.confirmation ?? "in-place";
  const { copied, confirm } = useCopiedFeedback();
  const generationRef = useRef(0);
  const copy = useCopyWrite({ confirm, confirmation, generationRef });
  const payloadOf = useLatestCallback(() => options.payload);
  // Whether the control has a payload is fixed by its call site's shape.
  const matchesNativeCopy = options.payload !== undefined;

  useMountEffect(() => {
    if (!matchesNativeCopy) {
      return undefined;
    }
    return registerNativeCopy(document, {
      confirm,
      matches: ({ text }) => {
        const payload = payloadOf();
        return (
          payload !== undefined && nativeCopyMatches({ copied: text, payload })
        );
      },
      selectionChanged: () => undefined,
    });
  });

  return { copied, copy, kind: "value", owner: COPY_CONTROL_OWNER };
};

type SelectionCopyOptions = {
  /** The surface the bar floats over; its document carries the listeners. */
  rootRef: RefObject<HTMLElement | null>;
  /**
   * Whether the bar's Copy acts on this non-empty selection, so that the
   * reader's own copy of it copies the same words.
   */
  ownsSelection: (selection: Selection, root: HTMLElement) => boolean;
};

/**
 * The Copy of a selection bar. Its press and the reader's own copy of the
 * selected words (Cmd+C, Ctrl+C, the browser's Copy menu) both turn it into
 * Copied, and a new selection clears it.
 */
export const useSelectionCopyControl = ({
  ownsSelection,
  rootRef,
}: SelectionCopyOptions): CopyControlState<"selection"> => {
  const { copied, confirm, reset } = useCopiedFeedback();
  // Counts selection changes, so a clipboard write that settles after the
  // reader moved on to other words never confirms a copy of those words.
  const generationRef = useRef(0);
  const owns = useLatestCallback(ownsSelection);
  const copy = useCopyWrite({
    confirm,
    confirmation: "in-place",
    generationRef,
  });

  useMountEffect(() => {
    const root = rootRef.current;
    if (root === null) {
      return undefined;
    }
    // A selection bar copies the selected words themselves, so a native copy
    // of the words it is showing for always puts its payload there.
    return registerNativeCopy(root.ownerDocument, {
      confirm,
      matches: ({ selection }) => owns(selection, root),
      selectionChanged: () => {
        generationRef.current += 1;
        reset();
      },
    });
  });

  return { copied, copy, kind: "selection", owner: COPY_CONTROL_OWNER };
};

// --- Rendering --------------------------------------------------------------

type CopyControlFeedbackProps = {
  control: CopyControlState;
  /** The idle label, when "Copy" alone is too vague. */
  label?: string | undefined;
  icon?: typeof CopyToClipboardIcon | undefined;
  iconOnly?: boolean | undefined;
  iconClassName?: string | undefined;
  /** Classes for the visible label, e.g. to hide it on narrow screens. */
  labelClassName?: string | undefined;
};

/**
 * The Copy to Copied swap, for a control whose trigger is its own (a menu
 * of copy formats). It keeps the wider label's width, so nothing shifts.
 */
export const CopyControlFeedback = ({
  control,
  icon,
  iconClassName,
  iconOnly,
  label,
  labelClassName,
}: CopyControlFeedbackProps) => {
  const t = useTranslations();
  return (
    <CopyFeedback
      copied={control.copied}
      copiedLabel={t("common.copied")}
      icon={icon}
      iconClassName={iconClassName}
      iconOnly={iconOnly}
      label={label ?? t("common.copy")}
      labelClassName={labelClassName}
    />
  );
};

/** The accessible name of a copy control in its current state. */
export const useCopyControlLabel = (
  control: CopyControlState,
  label?: string,
): string => {
  const t = useTranslations();
  if (control.copied) {
    return t("common.copied");
  }
  return label ?? t("common.copy");
};

type CopyButtonElementProps = Omit<
  ComponentProps<typeof Button>,
  "aria-label" | "children" | "onClick"
>;

type CopyFeedbackOptions = Omit<CopyControlFeedbackProps, "control">;

type CopyButtonProps = CopyButtonElementProps & CopyFeedbackOptions;

type CopyButtonParts = {
  buttonProps: CopyButtonElementProps;
  content: CopyContent | string;
  control: CopyControlState;
  /** Names the action by its current label whether or not it is visible. */
  currentLabel: string;
  feedback: CopyFeedbackOptions;
};

const renderCopyButton = ({
  buttonProps,
  content,
  control,
  currentLabel,
  feedback,
}: CopyButtonParts) => (
  <Button
    {...buttonProps}
    aria-label={currentLabel}
    data-copied={control.copied ? "" : undefined}
    onClick={() => {
      detached(control.copy(content), "copy-control.copy");
    }}
  >
    <CopyControlFeedback {...feedback} control={control} />
  </Button>
);

type CopyControlButtonProps = CopyButtonProps & {
  control: CopyControlState;
  content: CopyContent | string;
};

/**
 * A Copy button driven by a control a parent holds, such as a selection bar
 * whose Copy must outlive the button.
 */
export const CopyControlButton = ({
  content,
  control,
  icon,
  iconClassName,
  iconOnly,
  label,
  labelClassName,
  ...buttonProps
}: CopyControlButtonProps) => {
  const currentLabel = useCopyControlLabel(control, label);
  return renderCopyButton({
    buttonProps,
    content,
    control,
    currentLabel,
    feedback: { icon, iconClassName, iconOnly, label, labelClassName },
  });
};

type CopyControlProps = CopyButtonProps & {
  /** The value the control copies. */
  text: string;
};

/**
 * The app's Copy of a value: the glyph turns into a check and the label into
 * Copied where the reader pressed it; only a failed copy raises a toast.
 */
export const CopyControl = ({
  icon,
  iconClassName,
  iconOnly,
  label,
  labelClassName,
  text,
  ...buttonProps
}: CopyControlProps) => {
  const control = useCopyControl({ payload: text });
  const currentLabel = useCopyControlLabel(control, label);
  return renderCopyButton({
    buttonProps,
    content: text,
    control,
    currentLabel,
    feedback: { icon, iconClassName, iconOnly, label, labelClassName },
  });
};
