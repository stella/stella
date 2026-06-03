/**
 * Stamp `data-sdt-*` attributes on a painted block element from the
 * fragment's `sdtGroups` projection.
 *
 * The innermost group drives the boundary chrome and the widget delegation
 * layer; the full outer→inner stack is exposed as a JSON list so a hover
 * surface or addressing API can walk it. The painter side is intentionally
 * passive — CSS draws the boundary based on `data-sdt-boundary`, and the
 * widget layer reads the rest to render interactive triggers.
 */

import type { SdtGroup } from "../layout-engine/types";

export function applySdtDataAttrs(
  el: HTMLElement,
  sdtGroups: readonly SdtGroup[] | undefined,
): void {
  if (!sdtGroups || sdtGroups.length === 0) {
    return;
  }
  el.dataset["sdtBoundary"] = "true";

  const innermost = sdtGroups.at(-1);
  if (innermost) {
    el.dataset["sdtId"] = innermost.id;
    el.dataset["sdtPmPos"] = String(innermost.pmPos);
    el.dataset["sdtType"] = innermost.sdtType;
    if (innermost.position) {
      el.dataset["sdtPosition"] = innermost.position;
    }
    if (innermost.alias) {
      el.dataset["sdtAlias"] = innermost.alias;
    }
    if (innermost.tag) {
      el.dataset["sdtTag"] = innermost.tag;
    }
    if (innermost.sdtId !== undefined) {
      el.dataset["sdtOoxmlId"] = String(innermost.sdtId);
    }
    if (innermost.lock) {
      el.dataset["sdtLock"] = innermost.lock;
    }
    if (innermost.showingPlaceholder) {
      el.dataset["sdtShowingPlaceholder"] = "true";
    }
    if (innermost.checked !== undefined) {
      el.dataset["sdtChecked"] = String(innermost.checked);
    }
    if (innermost.dateFormat) {
      el.dataset["sdtDateFormat"] = innermost.dateFormat;
    }
    if (innermost.listItemsJson) {
      el.dataset["sdtListItems"] = innermost.listItemsJson;
    }
  }

  // Outer→inner stack for callers that need to walk it (addressing API,
  // widget delegation layer).
  el.dataset["sdtStack"] = JSON.stringify(
    sdtGroups.map((g) => ({
      id: g.id,
      sdtType: g.sdtType,
      tag: g.tag ?? null,
      alias: g.alias ?? null,
    })),
  );
}
