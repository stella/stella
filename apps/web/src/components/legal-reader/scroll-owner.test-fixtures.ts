/**
 * A text has one scroll owner: a card, note or quotation inside it grows the
 * text instead of scrolling on its own, because a scroller inside a scroller
 * traps the wheel and hides content behind a second scrollbar (the rule
 * `InspectorContent` states for panes). Tests of any surface that draws
 * inside a reader assert it with this.
 */

/** A utility class that makes an element scroll vertically, under any variant. */
const VERTICAL_SCROLL_CLASS = /^(?:[\w-]+:)*overflow(?:-y)?-(?:auto|scroll)$/u;

/** Whether an `overflow-y` value lets the element scroll its content. */
const scrollsVertically = (overflowY: string): boolean =>
  overflowY === "auto" || overflowY === "overlay" || overflowY === "scroll";

/**
 * Every element in `root`'s subtree, `root` included, that scrolls vertically
 * on its own: by computed style where styles apply, and by utility class
 * where they do not (a DOM test runs without the stylesheet).
 */
export const verticalScrollContainers = (root: Element): Element[] =>
  [root, ...root.querySelectorAll("*")].filter(
    (element) =>
      scrollsVertically(getComputedStyle(element).overflowY) ||
      [...element.classList].some((token) => VERTICAL_SCROLL_CLASS.test(token)),
  );
