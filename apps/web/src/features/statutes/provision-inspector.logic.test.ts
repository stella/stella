import { describe, expect, test } from "bun:test";

import { stripDiacritics } from "@stll/text-normalize";

import {
  createProvisionViewTab,
  filterCitingDecisions,
  isProvisionViewPayload,
  provisionTabId,
  submitsOnEnter,
} from "@/features/statutes/provision-inspector.logic";
import type { ProvisionViewPayload } from "@/features/statutes/provision-inspector.logic";

// Production-shaped: the ids are the ones the reader actually holds — a
// consolidation's uuid and the anchor the heading renderer emits — so a guard
// that keys off their shape is exercised rather than stepped around.
const payload = {
  anchorId: "paragraf-47",
  documentId: "0198f4c1-2b3d-7a41-9c88-4a1c0e2f5d6b",
  eli: "/eli/cz/sb/2012/89",
  jurisdiction: "CZE",
  provisionLabel: "§ 47",
  statuteTitle: "Občanský zákoník",
  versionCount: 3,
  versionValidFrom: "2024-01-01",
} satisfies ProvisionViewPayload;

describe("isProvisionViewPayload", () => {
  test("accepts the payload the reader opens a provision with", () => {
    expect(isProvisionViewPayload(payload)).toBe(true);
    // An undated consolidation is a real state, not a malformed payload.
    expect(isProvisionViewPayload({ ...payload, versionValidFrom: null })).toBe(
      true,
    );
  });

  test("rejects a payload missing any field the view addresses a read by", () => {
    for (const field of Object.keys(payload)) {
      const rest = Object.fromEntries(
        Object.entries(payload).filter(([key]) => key !== field),
      );

      expect(isProvisionViewPayload(rest)).toBe(false);
    }
  });

  test("rejects the empty identifiers a read cannot be addressed by", () => {
    // The tab is keyed by these, and an empty one would key every provision
    // of every act to the same tab.
    for (const field of ["anchorId", "documentId", "eli", "jurisdiction"]) {
      expect(isProvisionViewPayload({ ...payload, [field]: "" })).toBe(false);
    }
  });

  test("rejects a version count that cannot describe a consolidation", () => {
    expect(isProvisionViewPayload({ ...payload, versionCount: 0 })).toBe(false);
    expect(isProvisionViewPayload({ ...payload, versionCount: 1.5 })).toBe(
      false,
    );
    expect(isProvisionViewPayload({ ...payload, versionCount: "3" })).toBe(
      false,
    );
  });

  test("rejects values that are not a payload at all", () => {
    // The registry runs this over whatever a peer browser tab synced in.
    for (const value of [null, undefined, "provision", 47, []]) {
      expect(isProvisionViewPayload(value)).toBe(false);
    }
  });

  test("accepts a subdivision to land on and refuses an empty one", () => {
    expect(
      isProvisionViewPayload({
        ...payload,
        highlightAnchorId: "paragraf-47-odst_2",
      }),
    ).toBe(true);
    expect(isProvisionViewPayload({ ...payload, highlightAnchorId: "" })).toBe(
      false,
    );
  });
});

describe("provisionTabId", () => {
  test("the same provision of the same consolidation is the same tab", () => {
    // Everything but the two keys differs, which is what a second opening
    // looks like after a version switch relabelled the tab.
    const reopened = {
      ...payload,
      provisionLabel: "§ 47 (rewritten)",
      statuteTitle: "Civil Code",
      versionCount: 4,
      versionValidFrom: null,
    } satisfies ProvisionViewPayload;

    expect(provisionTabId(reopened)).toBe(provisionTabId(payload));
    expect(createProvisionViewTab(reopened).id).toBe(
      createProvisionViewTab(payload).id,
    );
  });

  test("another provision, or the same one in another consolidation, is another tab", () => {
    expect(provisionTabId({ ...payload, anchorId: "paragraf-48" })).not.toBe(
      provisionTabId(payload),
    );
    expect(
      provisionTabId({
        ...payload,
        documentId: "0198f4c1-2b3d-7a41-9c88-4a1c0e2f5d6c",
      }),
    ).not.toBe(provisionTabId(payload));
  });
});

describe("submitsOnEnter", () => {
  test("Enter sends the question", () => {
    expect(
      submitsOnEnter({ isComposing: false, key: "Enter", shiftKey: false }),
    ).toBe(true);
  });

  test("Enter while an IME composes confirms the candidate instead", () => {
    // Japanese, Chinese and Korean input ends a candidate with Enter. Sending
    // there would post a half-written question and clear the box.
    expect(
      submitsOnEnter({ isComposing: true, key: "Enter", shiftKey: false }),
    ).toBe(false);
  });

  test("Shift+Enter opens a line", () => {
    expect(
      submitsOnEnter({ isComposing: false, key: "Enter", shiftKey: true }),
    ).toBe(false);
  });

  test("another key is not a send", () => {
    for (const key of ["a", "Escape", "Tab", " "]) {
      expect(submitsOnEnter({ isComposing: false, key, shiftKey: false })).toBe(
        false,
      );
    }
  });
});

const supremeCourtDecision = {
  caseNumber: "22 Cdo 3819/2019",
  court: "Nejvyšší soud",
  sentenceText: "Zastoupení členem domácnosti podle § 47 se řídí…",
};

const constitutionalCourtDecision = {
  caseNumber: "II. ÚS 1234/20",
  court: "Ústavní soud",
  sentenceText: "Svéprávnost lze omezit jen v zájmu člověka.",
};

const decisions = [supremeCourtDecision, constitutionalCourtDecision];

describe("filterCitingDecisions", () => {
  test("an unfiltered list is the loaded list", () => {
    expect(filterCitingDecisions(decisions, "   ")).toEqual(decisions);
  });

  test("a query typed without diacritics still finds the decision", () => {
    // Without this assertion the case would pass on plain substring matching
    // and prove nothing about folding.
    expect(stripDiacritics("Nejvyssi")).not.toBe("Nejvyšší");
    expect(filterCitingDecisions(decisions, "nejvyssi")).toEqual([
      supremeCourtDecision,
    ]);
  });

  test("a query typed with diacritics finds a row stored without them", () => {
    const rows = [
      { caseNumber: "Pl. US 1/21", court: "Ustavni soud", sentenceText: "" },
    ];

    expect(filterCitingDecisions(rows, "Ústavní")).toEqual(rows);
  });

  test("the cited sentence and the case number are searched too", () => {
    expect(filterCitingDecisions(decisions, "3819")).toEqual([
      supremeCourtDecision,
    ]);
    expect(filterCitingDecisions(decisions, "svéprávnost")).toEqual([
      constitutionalCourtDecision,
    ]);
    expect(filterCitingDecisions(decisions, "no such court")).toEqual([]);
  });

  test("a citation without an excerpt remains searchable by its metadata", () => {
    const rows = [
      {
        caseNumber: "4 As 3/2008",
        court: "Nejvyšší správní soud",
        sentenceText: null,
      },
    ];

    expect(filterCitingDecisions(rows, "správní")).toEqual(rows);
    expect(filterCitingDecisions(rows, "null")).toEqual([]);
  });
});
