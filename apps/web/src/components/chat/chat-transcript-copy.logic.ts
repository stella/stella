const MESSAGE_SELECTOR = "[data-chat-message-id]";

const messageOf = (node: Node | null, root: HTMLElement) => {
  const element = node instanceof Element ? node : node?.parentElement;
  const message = element?.closest(MESSAGE_SELECTOR);
  return message !== undefined && message !== null && root.contains(message)
    ? message
    : null;
};

const excludesCopy = (element: Element) => {
  if (
    ((element instanceof HTMLElement || element instanceof SVGElement) &&
      Object.hasOwn(element.dataset, "chatCopyExclude")) ||
    element.hasAttribute("hidden") ||
    element.getAttribute("aria-hidden") === "true"
  ) {
    return true;
  }
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return (
    style?.display === "none" ||
    style?.visibility === "hidden" ||
    style?.visibility === "collapse" ||
    style?.userSelect === "none" ||
    // Screen-reader-only content is accessible, but is not visible copy.
    style?.clip === "rect(0px, 0px, 0px, 0px)"
  );
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
  let excluded = false;
  const read = (node: Node): string => {
    if (!range.intersectsNode(node)) {
      return "";
    }
    if (node instanceof Element && excludesCopy(node)) {
      excluded = true;
      return "";
    }
    if (node instanceof Text) {
      const start = node === range.startContainer ? range.startOffset : 0;
      const end = node === range.endContainer ? range.endOffset : node.length;
      return node.data.slice(start, end);
    }
    let text = "";
    for (const child of node.childNodes) {
      if (
        node instanceof HTMLDetailsElement &&
        !node.open &&
        (!(child instanceof Element) || child.tagName !== "SUMMARY")
      ) {
        excluded ||= range.intersectsNode(child);
        continue;
      }
      text += read(child);
    }
    if (!(node instanceof Element)) {
      return text;
    }
    if (node.tagName === "BR") {
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
  const text = excluded
    ? filteredText.replace(/\n+$/u, "")
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
