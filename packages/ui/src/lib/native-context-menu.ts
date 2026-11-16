// When a right-click belongs to the browser rather than to stella.
//
// Right-click opens stella's menu only on an object the user can act on, and
// that menu is the object's own actions (`EntityActions`). Inside such an
// object a few targets still keep the native menu, because their native items
// are the ones the user wants there: editable text (cut, paste, spelling), a
// selected run of text (copy, look up), and a link (open in a new tab, copy
// the address). Shift + right-click always asks for the native menu.
//
// The desktop webview narrows this further: its native menu also carries the
// browser's own items (reload, inspect), so outside editable or selected text
// it shows no menu at all (`nativeTextContextMenuReason`).

/** Why a right-click keeps the native menu, or null when stella may take it. */
export type NativeContextMenuReason =
  "editable" | "link" | "selection" | "shift";

type ContextMenuEventLike = {
  readonly shiftKey: boolean;
  readonly target: EventTarget | null;
};

/** Input types whose value is text a user edits; the others are controls. */
const NON_TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/** The element a right-click landed on; a text node answers for its parent. */
const elementOf = (target: EventTarget | null): Element | null => {
  if (target instanceof Element) {
    return target;
  }
  if (target instanceof Node) {
    return target.parentElement;
  }
  return null;
};

/**
 * What a `contenteditable` value means under the HTML standard: its keywords
 * match ASCII case-insensitively, the empty string means "true", and an
 * invalid value inherits from the parent.
 */
const contentEditableState = (
  value: string | null,
): "editable" | "inherit" | "not-editable" => {
  // A missing attribute inherits, like an invalid one.
  if (value === null) {
    return "inherit";
  }
  switch (value.toLowerCase()) {
    case "":
    case "true":
    case "plaintext-only":
      return "editable";
    case "false":
      return "not-editable";
    default:
      return "inherit";
  }
};

/** The element is, or sits inside, text the user can edit. */
export const isEditableContextMenuTarget = (element: Element): boolean => {
  const field = element.closest("input, textarea");
  if (field !== null) {
    const type = field.getAttribute("type")?.toLowerCase() ?? "text";
    if (field.tagName.toLowerCase() === "textarea") {
      return true;
    }
    return !NON_TEXT_INPUT_TYPES.has(type);
  }
  // The nearest valid `contenteditable` decides: an island marked "false"
  // inside an editor (a node view, a chip) is not editable text.
  for (
    let current = element.closest("[contenteditable]");
    current !== null;
    current = current.parentElement?.closest("[contenteditable]") ?? null
  ) {
    const state = contentEditableState(current.getAttribute("contenteditable"));
    if (state !== "inherit") {
      return state === "editable";
    }
  }
  return false;
};

/** The element is, or sits inside, a link with a destination. */
export const isLinkContextMenuTarget = (element: Element): boolean =>
  element.closest("a[href]") !== null;

/** A non-empty text selection covers the element. */
export const isSelectedTextContextMenuTarget = (element: Element): boolean => {
  const selection = element.ownerDocument.defaultView?.getSelection() ?? null;
  if (selection === null || selection.isCollapsed) {
    return false;
  }
  if (selection.toString().trim() === "") {
    return false;
  }
  for (let index = 0; index < selection.rangeCount; index += 1) {
    if (selection.getRangeAt(index).intersectsNode(element)) {
      return true;
    }
  }
  return false;
};

/**
 * Why this right-click keeps the browser's menu on an object, or null when
 * the object's own actions open instead.
 */
export const nativeContextMenuReason = (
  event: ContextMenuEventLike,
): NativeContextMenuReason | null => {
  if (event.shiftKey) {
    return "shift";
  }
  const element = elementOf(event.target);
  if (element === null) {
    return null;
  }
  if (isEditableContextMenuTarget(element)) {
    return "editable";
  }
  if (isSelectedTextContextMenuTarget(element)) {
    return "selection";
  }
  if (isLinkContextMenuTarget(element)) {
    return "link";
  }
  return null;
};

/**
 * The narrower rule a desktop webview applies to a right-click nothing in the
 * page handled: only editable or selected text keeps a (text) menu, since
 * the webview's native menu elsewhere offers browser items such as reload.
 */
export const nativeTextContextMenuReason = (
  event: Pick<ContextMenuEventLike, "target">,
): Extract<NativeContextMenuReason, "editable" | "selection"> | null => {
  const element = elementOf(event.target);
  if (element === null) {
    return null;
  }
  if (isEditableContextMenuTarget(element)) {
    return "editable";
  }
  if (isSelectedTextContextMenuTarget(element)) {
    return "selection";
  }
  return null;
};
