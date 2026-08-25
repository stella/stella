/**
 * Staleness has three null-shaped edges — an unsaved position list, no
 * approved version, no definition at all — and each of them must answer
 * something other than "stale", or a reader would be told to re-run against
 * nothing.
 */

import { describe, expect, test } from "bun:test";

import { resolvePlaybookStaleness } from "@/api/handlers/document-reviews/playbook-staleness";
import { toSafeId } from "@/api/lib/branded-types";
import type { PinnedPlaybook } from "@/api/lib/document-review/run-contract";

const DEFINITION_ID = toSafeId<"playbookDefinition">(
  "99999999-9999-4999-8999-999999999999",
);
const PINNED_VERSION_ID = toSafeId<"playbookDefinitionVersion">(
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
);
const NEWER_VERSION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const pinnedPlaybook = (
  versionId: PinnedPlaybook["versionId"],
): PinnedPlaybook => ({
  definitionId: DEFINITION_ID,
  versionId,
  provenance: versionId === null ? "draft" : "approved",
  definitionSnapshot: {
    name: "Sale and purchase",
    positions: { version: 3, items: [] },
  },
});

describe("resolvePlaybookStaleness", () => {
  test("an ephemeral pin is neither stale nor missing", () => {
    expect(
      resolvePlaybookStaleness({
        pinned: {
          definitionId: null,
          versionId: null,
          provenance: "ephemeral",
          definitionSnapshot: {
            name: "Positions confirmed for this review",
            positions: { version: 3, items: [] },
          },
        },
        latestVersionId: NEWER_VERSION_ID,
        definitionExists: true,
      }),
    ).toEqual({ playbookStale: false, playbookMissing: false });
  });

  test("the pinned approval is still the newest", () => {
    expect(
      resolvePlaybookStaleness({
        pinned: pinnedPlaybook(PINNED_VERSION_ID),
        latestVersionId: PINNED_VERSION_ID,
        definitionExists: true,
      }),
    ).toEqual({ playbookStale: false, playbookMissing: false });
  });

  test("a later approval makes the run stale", () => {
    expect(
      resolvePlaybookStaleness({
        pinned: pinnedPlaybook(PINNED_VERSION_ID),
        latestVersionId: NEWER_VERSION_ID,
        definitionExists: true,
      }),
    ).toEqual({ playbookStale: true, playbookMissing: false });
  });

  // Running a draft is the normal authoring loop; it only becomes stale once
  // an approval exists that the run did not measure against.
  test("a draft pin is stale exactly when an approval exists", () => {
    expect(
      resolvePlaybookStaleness({
        pinned: pinnedPlaybook(null),
        latestVersionId: null,
        definitionExists: true,
      }),
    ).toEqual({ playbookStale: false, playbookMissing: false });
    expect(
      resolvePlaybookStaleness({
        pinned: pinnedPlaybook(null),
        latestVersionId: NEWER_VERSION_ID,
        definitionExists: true,
      }),
    ).toEqual({ playbookStale: true, playbookMissing: false });
  });

  test("a deleted definition reports missing, never stale", () => {
    expect(
      resolvePlaybookStaleness({
        pinned: pinnedPlaybook(PINNED_VERSION_ID),
        latestVersionId: null,
        definitionExists: false,
      }),
    ).toEqual({ playbookStale: false, playbookMissing: true });
  });
});
