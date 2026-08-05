import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  GUIDE_ANCHORS,
  type GuideAnchorId,
  PENDING_GUIDE_ANCHOR_IDS,
} from "@/features/guides/guide-anchors";
import { GUIDE_TOURS } from "@/features/guides/guide-tours";
import {
  countResolvedTours,
  parseGuideProgress,
} from "@/features/guides/use-onboarding-progress";

// apps/web/src — the real app surface. Registrations must live here, NOT inside
// the guides slice, so an example in a comment or the registry itself can never
// masquerade as a live registration.
const WEB_SRC_DIR = path.resolve(import.meta.dir, "../..");
const GUIDES_SLICE_SEGMENT = `${path.sep}features${path.sep}guides${path.sep}`;
const GUIDE_ANCHOR_CALL =
  /\bguideAnchor\(\s*GUIDE_ANCHORS\.([A-Za-z0-9_]+)\s*\)/gu;

const anchorIdByKey = new Map<string, GuideAnchorId>(
  Object.entries(GUIDE_ANCHORS),
);

// Static scan: which anchors are actually marked on a live element somewhere in
// the app (outside the guides slice)? Deleting a component's `guideAnchor`
// call drops its id from this set, failing the registration test below.
const registeredAnchorIds: ReadonlySet<GuideAnchorId> = (() => {
  const registered = new Set<GuideAnchorId>();
  const glob = new Glob("**/*.{ts,tsx}");
  for (const file of glob.scanSync({ absolute: true, cwd: WEB_SRC_DIR })) {
    if (file.includes(GUIDES_SLICE_SEGMENT)) {
      continue;
    }
    const source = readFileSync(file, "utf-8");
    for (const match of source.matchAll(GUIDE_ANCHOR_CALL)) {
      const id = anchorIdByKey.get(match[1] ?? "");
      if (id) {
        registered.add(id);
      }
    }
  }
  return registered;
})();

const ALL_ANCHOR_IDS: readonly GuideAnchorId[] = Object.values(GUIDE_ANCHORS);
const PENDING_ANCHOR_IDS: ReadonlySet<GuideAnchorId> = new Set(
  PENDING_GUIDE_ANCHOR_IDS,
);

describe("guide anchor registration", () => {
  test("every non-pending anchor is registered on a live element", () => {
    const missing = ALL_ANCHOR_IDS.filter(
      (id) => !PENDING_ANCHOR_IDS.has(id) && !registeredAnchorIds.has(id),
    );
    // If this fails, either the anchor lost its `guideAnchor(...)` call (wire
    // it back or delete the anchor + its tour step) or a new anchor still needs
    // registering (add the call, or list it in PENDING_GUIDE_ANCHOR_IDS).
    expect(missing).toEqual([]);
  });

  test("pending anchors are not yet registered", () => {
    // Once a pending anchor is wired, remove it from PENDING_GUIDE_ANCHOR_IDS so
    // the list stays an honest record of what is not yet on the real surface.
    const wiredButStillPending = [...PENDING_ANCHOR_IDS].filter((id) =>
      registeredAnchorIds.has(id),
    );
    expect(wiredButStillPending).toEqual([]);
  });

  test("pending anchor ids are all real anchors", () => {
    const strays = [...PENDING_ANCHOR_IDS].filter(
      (id) => !ALL_ANCHOR_IDS.includes(id),
    );
    expect(strays).toEqual([]);
  });
});

describe("guide tours", () => {
  test("every anchor a non-pending tour step targets is registered", () => {
    const unregistered = GUIDE_TOURS.flatMap((tour) =>
      tour.steps
        .map((step) => step.anchor)
        .filter(
          (anchor) =>
            !PENDING_ANCHOR_IDS.has(anchor) && !registeredAnchorIds.has(anchor),
        ),
    );
    expect(unregistered).toEqual([]);
  });

  test("the chat tour is fully wired end to end", () => {
    const chatTour = GUIDE_TOURS.find((tour) => tour.id === "chat");
    expect(chatTour).toBeDefined();
    for (const step of chatTour?.steps ?? []) {
      expect(registeredAnchorIds.has(step.anchor)).toBe(true);
    }
  });
});

describe("onboarding progress persistence", () => {
  test("parses a stored progress blob and ignores unknown shapes", () => {
    expect(parseGuideProgress('{"chat":"completed"}')).toEqual({
      chat: "completed",
    });
    expect(parseGuideProgress(null)).toEqual({});
    expect(parseGuideProgress("not json")).toEqual({});
    expect(parseGuideProgress('{"chat":"bogus"}')).toEqual({});
  });

  test("counts only resolved tours", () => {
    expect(countResolvedTours(GUIDE_TOURS, {})).toBe(0);
    expect(
      countResolvedTours(GUIDE_TOURS, {
        chat: "completed",
        documents: "skipped",
      }),
    ).toBe(2);
  });
});
