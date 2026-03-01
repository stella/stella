/**
 * Character-offset map for OOXML paragraph runs.
 *
 * Maps each `w:t` in a `w:p` to its character offset. Skips
 * `w:del` and descends into `w:ins` (accepted revision view).
 */

import type * as slimdom from "slimdom";

import { isElement, W_NS } from "./ooxml";

export type RunSpan = {
  run: slimdom.Element;
  tNode: slimdom.Element;
  start: number;
  length: number;
};

/** Build a character-offset map for a single `w:p` element. */
export const buildRunMap = (p: slimdom.Element): RunSpan[] => {
  const spans: RunSpan[] = [];
  let offset = 0;

  const collect = (parent: slimdom.Node) => {
    for (const child of parent.childNodes) {
      if (!isElement(child)) {
        continue;
      }

      // Skip deleted and move-source content (accepted view)
      if (child.localName === "del" && child.namespaceURI === W_NS) {
        continue;
      }
      if (child.localName === "moveFrom" && child.namespaceURI === W_NS) {
        continue;
      }

      // Descend into transparent wrappers that contain runs
      if (
        child.namespaceURI === W_NS &&
        (child.localName === "ins" ||
          child.localName === "moveTo" ||
          child.localName === "hyperlink" ||
          child.localName === "smartTag" ||
          child.localName === "fldSimple" ||
          child.localName === "sdtContent")
      ) {
        collect(child);
        continue;
      }

      // w:sdt → descend into its w:sdtContent child
      if (child.localName === "sdt" && child.namespaceURI === W_NS) {
        collect(child);
        continue;
      }

      if (child.localName === "r" && child.namespaceURI === W_NS) {
        for (const rc of child.childNodes) {
          if (!isElement(rc)) {
            continue;
          }
          if (rc.localName === "t" && rc.namespaceURI === W_NS) {
            const text = rc.textContent ?? "";
            if (text.length > 0) {
              spans.push({
                run: child,
                tNode: rc,
                start: offset,
                length: text.length,
              });
              offset += text.length;
            }
          }
        }
      }
    }
  };

  collect(p);
  return spans;
};
