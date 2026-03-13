import { useEffect, useRef } from "react";

import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";

/**
 * Flashes an element when the inspector activates the given entity.
 * Uses an inset box-shadow animation (500ms) and scrolls the element
 * into view. Works in table rows, tree rows, kanban cards, calendar
 * chips, and overview rows.
 */
export const useInspectorFlash = (
  entityId: string,
  ref: React.RefObject<HTMLElement | null>,
) => {
  const isActive = useInspectorStore((s) => {
    if (!s.activeId) {
      return false;
    }
    const tab = s.tabs.find((t) => t.id === s.activeId);
    if (!tab) {
      return false;
    }
    return tab.type === "pdf" ? tab.entityId === entityId : tab.id === entityId;
  });
  const seq = useInspectorStore((s) => s.activationSeq);
  const prevSeq = useRef(seq);

  useEffect(() => {
    const el = ref.current;
    if (el && isActive && seq !== prevSeq.current) {
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });

      const c = "var(--color-primary)";
      const t = "transparent";
      const options: KeyframeAnimationOptions = {
        duration: 500,
        easing: "ease-out",
      };

      // <tr> elements don't render box-shadow; animate
      // each child <td> to form a unified row outline.
      if (el.tagName === "TR") {
        const cells = el.children;
        const last = cells.length - 1;
        for (let i = 0; i <= last; i++) {
          // top + bottom on every cell; left on first,
          // right on last
          const parts = [
            "inset 0 2px 0 0",
            "inset 0 -2px 0 0",
            ...(i === 0 ? ["inset 2px 0 0 0"] : []),
            ...(i === last ? ["inset -2px 0 0 0"] : []),
          ];
          const on = parts.map((p) => `${p} ${c}`).join(", ");
          const off = parts.map((p) => `${p} ${t}`).join(", ");

          const cell = cells[i];
          if (cell instanceof HTMLElement) {
            cell.animate([{ boxShadow: on }, { boxShadow: off }], options);
          }
        }
      } else {
        el.animate(
          [
            { boxShadow: `inset 0 0 0 2px ${c}` },
            { boxShadow: `inset 0 0 0 2px ${t}` },
          ],
          options,
        );
      }
    }
    prevSeq.current = seq;
  }, [isActive, seq, ref]);
};
