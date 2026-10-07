const MESSAGE_SELECTOR = "[data-chat-message-id]";

const isElement = (node: Node | null): node is Element =>
  node?.nodeType === Node.ELEMENT_NODE;

const isText = (node: Node): node is Text => node.nodeType === Node.TEXT_NODE;

const messageOf = (node: Node | null, root: HTMLElement) => {
  const element = isElement(node) ? node : node?.parentElement;
  const message = element?.closest(MESSAGE_SELECTOR);
  return message !== undefined && message !== null && root.contains(message)
    ? message
    : null;
};

const excludesCopy = (element: Element) => {
  if (
    element.closest("[data-chat-copy-exclude]") !== null ||
    element.hasAttribute("hidden") ||
    element.getAttribute("aria-hidden") === "true" ||
    element.classList.contains("sr-only")
  ) {
    return true;
  }
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  const clip = style?.getPropertyValue("clip").replaceAll(/\s/gu, "");
  return (
    style?.display === "none" ||
    style?.visibility === "hidden" ||
    style?.visibility === "collapse" ||
    style?.userSelect === "none" ||
    // Screen-reader-only content is accessible, but is not visible copy.
    style?.clipPath === "inset(50%)" ||
    clip === "rect(0px,0px,0px,0px)" ||
    clip === "rect(0,0,0,0)"
  );
};

const trailingBreakCount = (text: string): number => {
  let start = text.length;
  while (start > 0 && text.charAt(start - 1) === "\n") {
    start -= 1;
  }
  return text.length - start;
};

type SerializeChatSelectionOptions = {
  selection: Selection;
  root: HTMLElement;
};

/** Clipboard HTML is built from selected text, never from transcript DOM.
 * Browser-generated HTML can contain ancestors and unrelated page content. */
export const serializeChatSelection = ({
  selection,
  root,
}: SerializeChatSelectionOptions) => {
  if (
    selection.isCollapsed ||
    selection.rangeCount !== 1 ||
    messageOf(selection.anchorNode, root) === null ||
    messageOf(selection.focusNode, root) === null
  ) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const state = { excluded: false, trailingSelectedBreaks: 0 };
  const read = (node: Node): string => {
    if (!range.intersectsNode(node)) {
      return "";
    }
    if (isElement(node) && excludesCopy(node)) {
      state.excluded = true;
      return "";
    }
    if (isText(node)) {
      const start = node === range.startContainer ? range.startOffset : 0;
      const end = node === range.endContainer ? range.endOffset : node.length;
      const text = node.data.slice(start, end);
      if (text !== "") {
        state.trailingSelectedBreaks = trailingBreakCount(text);
      }
      return text;
    }
    let text = "";
    for (const child of node.childNodes) {
      if (
        isElement(node) &&
        node.tagName === "DETAILS" &&
        !node.hasAttribute("open") &&
        (!isElement(child) || child.tagName !== "SUMMARY")
      ) {
        state.excluded ||= range.intersectsNode(child);
        continue;
      }
      text += read(child);
    }
    if (!isElement(node)) {
      return text;
    }
    if (node.tagName === "BR") {
      state.trailingSelectedBreaks += 1;
      return "\n";
    }
    const display =
      node.ownerDocument.defaultView?.getComputedStyle(node).display;
    return text !== "" &&
      !text.endsWith("\n") &&
      (display === "block" || display === "flex")
      ? `${text}\n`
      : text;
  };
  const filteredText = read(root);
  // Keep the browser's exact whitespace and Unicode when nothing is excluded.
  const text = state.excluded
    ? filteredText.slice(
        0,
        filteredText.length - trailingBreakCount(filteredText),
      ) + "\n".repeat(state.trailingSelectedBreaks)
    : selection.toString();
  const html = root.ownerDocument.createElement("pre");
  html.textContent = text;
  return { text, html: html.outerHTML };
};

export const copyChatSelection = (event: ClipboardEvent, root: HTMLElement) => {
  const selection = root.ownerDocument.getSelection();
  if (
    event.defaultPrevented ||
    event.clipboardData === null ||
    selection === null
  ) {
    return;
  }
  const content = serializeChatSelection({ selection, root });
  if (content === null) {
    return;
  }
  event.clipboardData.setData("text/plain", content.text);
  event.clipboardData.setData("text/html", content.html);
  event.preventDefault();
};
