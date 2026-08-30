import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { guideAnchor } from "@/features/guides/guide-anchor";
import {
  GUIDE_ANCHORS,
  type GuideAnchorId,
  PENDING_GUIDE_ANCHOR_IDS,
} from "@/features/guides/guide-anchors";
import { isGuideTourAvailable } from "@/features/guides/guide-availability";
import { resolveGuideWorkspaceViewId } from "@/features/guides/guide-route";
import { GUIDE_TOURS } from "@/features/guides/guide-tours";
import { GUIDE_TOUR_IDS } from "@/features/guides/guide-types";
import {
  countResolvedTours,
  parseGuideProgress,
} from "@/features/guides/use-onboarding-progress";

// apps/web/src — the real app surface. Registrations must live here, NOT inside
// the guides slice, so an example in a comment or the registry itself can never
// masquerade as a live registration.
const WEB_SRC_DIR = path.resolve(import.meta.dir, "../..");
const GUIDES_SLICE_SEGMENT = `${path.sep}features${path.sep}guides${path.sep}`;
const anchorIdByKey = new Map<string, GuideAnchorId>(
  Object.entries(GUIDE_ANCHORS),
);

const anchorIdsInSource = (
  source: string,
  fileName: string,
): ReadonlySet<GuideAnchorId> => {
  const ids = new Set<GuideAnchorId>();
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "guideAnchor"
    ) {
      const argument = node.arguments.at(0);
      if (
        argument &&
        ts.isPropertyAccessExpression(argument) &&
        ts.isIdentifier(argument.expression) &&
        argument.expression.text === "GUIDE_ANCHORS"
      ) {
        const id = anchorIdByKey.get(argument.name.text);
        if (id) {
          ids.add(id);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return ids;
};

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
    for (const id of anchorIdsInSource(source, file)) {
      registered.add(id);
    }
  }
  return registered;
})();

const ALL_ANCHOR_IDS: readonly GuideAnchorId[] = Object.values(GUIDE_ANCHORS);
const PENDING_ANCHOR_IDS: ReadonlySet<GuideAnchorId> = new Set(
  PENDING_GUIDE_ANCHOR_IDS,
);

describe("guide anchor registration", () => {
  test("shared surfaces opt in before registering an anchor", () => {
    expect(guideAnchor(GUIDE_ANCHORS.chatComposer, false)).toEqual({});
    expect(guideAnchor(GUIDE_ANCHORS.chatComposer, true)).toEqual({
      "data-guide-anchor": GUIDE_ANCHORS.chatComposer,
    });
  });

  test("ignores anchor-like text outside executable calls", () => {
    const source = `
      // guideAnchor(GUIDE_ANCHORS.chatComposer)
      const example = "guideAnchor(GUIDE_ANCHORS.chatSend)";
      const props = guideAnchor(GUIDE_ANCHORS.chatToolsButton, enabled);
    `;
    expect([...anchorIdsInSource(source, "fixture.tsx")]).toEqual([
      GUIDE_ANCHORS.chatToolsButton,
    ]);
  });

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

  test("anchor values are unique", () => {
    expect(new Set(ALL_ANCHOR_IDS).size).toBe(ALL_ANCHOR_IDS.length);
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

  test("every published tour is fully wired end to end", () => {
    expect(PENDING_GUIDE_ANCHOR_IDS).toEqual([]);
    for (const tour of GUIDE_TOURS) {
      for (const step of tour.steps) {
        expect(registeredAnchorIds.has(step.anchor)).toBe(true);
      }
    }
  });

  test("the registry covers every tour id exactly once", () => {
    expect(GUIDE_TOURS.map((tour) => tour.id)).toEqual(
      Object.values(GUIDE_TOUR_IDS),
    );
  });

  test("every tour can leave the global drawer for its first surface", () => {
    for (const tour of GUIDE_TOURS) {
      const firstStep = tour.steps.at(0);
      expect(firstStep && "route" in firstStep).toBe(true);
    }
  });

  test("every local transition has a registered way back and a next step", () => {
    for (const tour of GUIDE_TOURS) {
      for (const [index, step] of tour.steps.entries()) {
        if (
          !("interaction" in step) ||
          step.interaction.kind !== "transition"
        ) {
          continue;
        }
        expect(registeredAnchorIds.has(step.interaction.reverseAnchor)).toBe(
          true,
        );
        expect(tour.steps.at(index + 1)).toBeDefined();
      }
    }
  });

  test("matter tours select an unfiltered table instead of the first table", () => {
    expect(
      resolveGuideWorkspaceViewId(
        [
          {
            id: "filtered-table-view",
            name: "Filtered",
            position: 0,
            version: 1,
            createdAt: "2026-01-01T00:00:00.000Z",
            layout: {
              calculations: [],
              columnOrder: [],
              columnPinning: [],
              hiddenProperties: [],
              sorts: [],
              type: "table",
              version: 1,
              filters: [
                {
                  operand: { type: "kind" },
                  op: "is_not_empty",
                  type: "predicate",
                },
              ],
            },
          },
          {
            id: "unfiltered-table-view",
            name: "All documents",
            position: 1,
            version: 1,
            createdAt: "2026-01-01T00:00:00.000Z",
            layout: {
              calculations: [],
              columnOrder: [],
              columnPinning: [],
              filters: [],
              hiddenProperties: [],
              sorts: [],
              type: "table",
              version: 1,
            },
          },
        ],
        "unfiltered-table",
      ),
    ).toBe("unfiltered-table-view");
    expect(
      resolveGuideWorkspaceViewId(
        [
          {
            id: "filtered-table-view",
            name: "Filtered",
            position: 0,
            version: 1,
            createdAt: "2026-01-01T00:00:00.000Z",
            layout: {
              calculations: [],
              columnOrder: [],
              columnPinning: [],
              hiddenProperties: [],
              sorts: [],
              type: "table",
              version: 1,
              filters: [
                {
                  operand: { type: "kind" },
                  op: "is_not_empty",
                  type: "predicate",
                },
              ],
            },
          },
        ],
        "unfiltered-table",
      ),
    ).toBeNull();
  });

  test("unavailable or unauthorized destinations stay out of the checklist", () => {
    const unavailable = {
      canUseChat: false,
      canCreateDocument: false,
      canCreateProperty: false,
      documentsAvailable: false,
      tabularReviewAvailable: false,
      playbooksAvailable: false,
      workflowsAvailable: false,
      canCreatePlaybook: false,
      canCreateWorkflow: false,
    };
    expect(isGuideTourAvailable(GUIDE_TOUR_IDS.chat, unavailable)).toBe(false);
    expect(isGuideTourAvailable(GUIDE_TOUR_IDS.documents, unavailable)).toBe(
      false,
    );
    expect(
      isGuideTourAvailable(GUIDE_TOUR_IDS.tabularReview, unavailable),
    ).toBe(false);
    expect(
      isGuideTourAvailable(GUIDE_TOUR_IDS.documents, {
        ...unavailable,
        documentsAvailable: true,
      }),
    ).toBe(false);
    expect(
      isGuideTourAvailable(GUIDE_TOUR_IDS.documents, {
        ...unavailable,
        canCreateDocument: true,
        documentsAvailable: true,
      }),
    ).toBe(true);
    expect(
      isGuideTourAvailable(GUIDE_TOUR_IDS.tabularReview, {
        ...unavailable,
        tabularReviewAvailable: true,
      }),
    ).toBe(false);
    expect(
      isGuideTourAvailable(GUIDE_TOUR_IDS.tabularReview, {
        ...unavailable,
        canCreateProperty: true,
        tabularReviewAvailable: true,
      }),
    ).toBe(true);
    expect(
      isGuideTourAvailable(GUIDE_TOUR_IDS.chat, {
        ...unavailable,
        canUseChat: true,
      }),
    ).toBe(true);
    expect(isGuideTourAvailable(GUIDE_TOUR_IDS.playbooks, unavailable)).toBe(
      false,
    );
    expect(
      isGuideTourAvailable(GUIDE_TOUR_IDS.playbooks, {
        ...unavailable,
        playbooksAvailable: true,
      }),
    ).toBe(false);
    expect(
      isGuideTourAvailable(GUIDE_TOUR_IDS.workflows, {
        ...unavailable,
        workflowsAvailable: true,
      }),
    ).toBe(false);
    expect(
      isGuideTourAvailable(GUIDE_TOUR_IDS.playbooks, {
        ...unavailable,
        playbooksAvailable: true,
        canCreatePlaybook: true,
      }),
    ).toBe(true);
    expect(
      isGuideTourAvailable(GUIDE_TOUR_IDS.workflows, {
        ...unavailable,
        workflowsAvailable: true,
        canCreateWorkflow: true,
      }),
    ).toBe(true);
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

  test("an entry it cannot read never costs the entries it can", () => {
    // The blob is written by whichever build ran last, so a status or tour id
    // from a newer release must cost that one entry and nothing else. Reading
    // the map as empty would not be caution: the next write persists whatever
    // was read, so a strict parse here is silent, permanent data loss.
    expect(
      parseGuideProgress(
        '{"chat":"completed","documents":"dismissed","time-travel":"skipped","playbooks":"skipped"}',
      ),
    ).toEqual({ chat: "completed", playbooks: "skipped" });
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
