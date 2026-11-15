import type { ReactNode } from "react";

/**
 * Whether React draws nothing for this node: `null`, `undefined`, a boolean,
 * an empty string, or a list of only such nodes. A slot that sits empty
 * (an `icon=""`, a `{flag && value}` that came out `true`, an empty `.map`)
 * is then treated as absent rather than given a box.
 */
export function rendersNothing(node: ReactNode): boolean {
  if (node === null || node === undefined || typeof node === "boolean") {
    return true;
  }
  if (typeof node === "string") {
    return node === "";
  }
  if (Array.isArray(node)) {
    return node.every((child: ReactNode) => rendersNothing(child));
  }
  return false;
}
