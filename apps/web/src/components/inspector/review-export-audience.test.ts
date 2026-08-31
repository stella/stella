/**
 * The two review exports are for two audiences, and the counterparty one must
 * stay the contract.
 *
 * "Send to counterparty" hands over the reviewed document's current version —
 * the reviewer's tracked changes and the notes they typed into it — and the
 * review record must have no path into those bytes. That is a structural
 * claim, not a formatting one, so it is tested at the boundary: what the
 * counterparty path is allowed to be told, and what the module that runs it is
 * allowed to read.
 */

import { describe, expect, test } from "bun:test";

import type { CounterpartyExportTarget } from "@/components/inspector/review-export-menu";

const MENU_SOURCE = await Bun.file(
  new URL("review-export-menu.tsx", import.meta.url),
).text();

/**
 * The module with its comments and its user-facing copy removed.
 *
 * Both legitimately name what the code must not touch — the internal item's
 * own label says "Findings, rationale and references" — so only the
 * identifiers are evidence of what is actually read.
 */
const MENU_IDENTIFIERS = MENU_SOURCE.replaceAll(
  /\/\*[\s\S]*?\*\/|\/\/.*$|"[^"]*"|'[^']*'|`[^`]*`/gmu,
  "",
);

/**
 * Total over the target's fields, so widening it fails typecheck here. A new
 * field is not forbidden — it has to be a fact about the *document*, and
 * adding it means saying so in this list.
 */
const COUNTERPARTY_TARGET_FIELDS = {
  fileFieldId: true,
  fileName: true,
} as const satisfies Record<keyof CounterpartyExportTarget, true>;

/**
 * Names that exist only because a review produced them. None may be read in
 * the export module: the counterparty download is assembled from the document
 * reference alone, so any of these turning up means a review value found a
 * route into the file a counterparty receives.
 */
const REVIEW_ONLY_NAMES = [
  "rationale",
  "recommendation",
  "explanation",
  "negotiation",
  "matchedRef",
  "referenceCitations",
  "citations",
  "verdict",
  "finding",
  "findings",
  "payload",
  "basis",
  "flags",
];

describe("what the counterparty export is told", () => {
  test("only the document: the field it lives on and the name to save it as", () => {
    expect(Object.keys(COUNTERPARTY_TARGET_FIELDS).toSorted()).toEqual([
      "fileFieldId",
      "fileName",
    ]);
  });

  test("the export module reads nothing a review produced", () => {
    const named = REVIEW_ONLY_NAMES.filter((name) =>
      new RegExp(`\\b${name}\\b`, "u").test(MENU_IDENTIFIERS),
    );
    expect(named).toEqual([]);
  });

  // The internal memo is the review record and is reached by run id; the
  // counterparty file is the contract and is reached by field id. Neither may
  // be served through the other's path.
  test("only the internal memo is built from the run", () => {
    expect(MENU_SOURCE).toContain(
      ["document-reviews/runs/", "{runId}/export"].join("$"),
    );
    const start = MENU_SOURCE.indexOf("handleCounterpartyExport = async");
    const counterpartyPath = MENU_SOURCE.slice(
      start,
      MENU_SOURCE.indexOf("return (", start),
    );
    expect(counterpartyPath).toContain("downloadTabOriginalFile");
    expect(counterpartyPath).not.toContain("runId");
  });
});
