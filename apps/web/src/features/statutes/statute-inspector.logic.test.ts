import { describe, expect, test } from "bun:test";

import {
  createStatuteViewTab,
  isStatuteViewPayload,
  STATUTE_VIEW,
  statuteTabId,
} from "@/features/statutes/statute-inspector.logic";
import type { StatuteViewPayload } from "@/features/statutes/statute-inspector.logic";

// Production-shaped: a consolidation's uuid, the work identifier its
// citations are filed under, and the stored address segment, as the citation
// resolver hands them over.
const payload = {
  country: "CZE",
  documentId: "0198f4c1-2b3d-7a41-9c88-4a1c0e2f5d6b",
  eli: "/eli/cz/sb/2004/326",
  slug: "326-2004-sb-o-rostlinolekarske-peci",
  statuteTitle: "Zákon o rostlinolékařské péči",
  versionValidFrom: "2024-01-01",
} satisfies StatuteViewPayload;

const target = {
  country: payload.country,
  documentId: payload.documentId,
  eli: payload.eli,
  slug: payload.slug,
  statuteTitle: payload.statuteTitle,
  versionValidFrom: payload.versionValidFrom,
};

describe("isStatuteViewPayload", () => {
  test("accepts the payload a work-level citation opens an act with", () => {
    expect(isStatuteViewPayload(payload)).toBe(true);
    // A document the backfill has reached neither for a slug nor for a
    // dated consolidation is a real state, not a malformed payload.
    expect(
      isStatuteViewPayload({
        ...payload,
        eli: null,
        slug: null,
        versionValidFrom: null,
      }),
    ).toBe(true);
  });

  test("rejects a payload missing any field the view addresses a read by", () => {
    for (const field of Object.keys(payload)) {
      const rest = Object.fromEntries(
        Object.entries(payload).filter(([key]) => key !== field),
      );

      expect(isStatuteViewPayload(rest)).toBe(false);
    }
  });

  test("rejects the empty identifiers a read cannot be addressed by", () => {
    // The tab is keyed by the document and named by the title; an empty one
    // would key every act to the same tab, or leave it unnamed in the rail.
    for (const field of ["country", "documentId", "statuteTitle"]) {
      expect(isStatuteViewPayload({ ...payload, [field]: "" })).toBe(false);
    }
  });

  test("rejects an address segment that is neither stated nor absent", () => {
    for (const field of ["eli", "slug", "versionValidFrom"]) {
      expect(isStatuteViewPayload({ ...payload, [field]: 2004 })).toBe(false);
      expect(isStatuteViewPayload({ ...payload, [field]: undefined })).toBe(
        false,
      );
    }
  });

  test("rejects values that are not a payload at all", () => {
    // The registry runs this over whatever a peer browser tab synced in.
    for (const value of [null, undefined, "statute", 326, []]) {
      expect(isStatuteViewPayload(value)).toBe(false);
    }
  });
});

describe("createStatuteViewTab", () => {
  test("carries the citation's address into a payload the view validates", () => {
    const tab = createStatuteViewTab(target);

    expect(tab.type).toBe(STATUTE_VIEW);
    expect(tab.label).toBe(payload.statuteTitle);
    expect(tab.payload).toEqual(payload);
    expect(isStatuteViewPayload(tab.payload)).toBe(true);
  });

  test("a citation stating no version or segment carries nulls, not gaps", () => {
    const tab = createStatuteViewTab({
      country: payload.country,
      documentId: payload.documentId,
      statuteTitle: payload.statuteTitle,
    });

    expect(tab.payload.eli).toBeNull();
    expect(tab.payload.slug).toBeNull();
    expect(tab.payload.versionValidFrom).toBeNull();
    expect(isStatuteViewPayload(tab.payload)).toBe(true);
  });

  test("the same consolidation is the same tab, another one is its own", () => {
    const relabelled = {
      ...target,
      slug: null,
      statuteTitle: "Plant Health Act",
    };

    expect(createStatuteViewTab(relabelled).id).toBe(
      createStatuteViewTab(target).id,
    );
    expect(statuteTabId("0198f4c1-2b3d-7a41-9c88-000000000000")).not.toBe(
      statuteTabId(payload.documentId),
    );
  });
});
