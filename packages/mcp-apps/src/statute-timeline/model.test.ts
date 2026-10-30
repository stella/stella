import { describe, expect, test } from "bun:test";

import {
  compareAdjacentVersions,
  isCurrentVersion,
  mergeHistory,
  timelineWindows,
  versionWording,
} from "./model";
import type { ProvisionVersion, StatuteTimelineHistory } from "./parse";
import { parseStatuteTimelineHistory } from "./parse";

type FoundVersion = Extract<ProvisionVersion, { status: "found" }>;

const version = (overrides: Partial<FoundVersion> = {}): FoundVersion => ({
  url: null,
  documentId: "version-1",
  resourceName: "resource-1",
  versionValidFrom: "2024-01-01",
  versionValidTo: null,
  expressionKind: "consolidation",
  windowDisposition: "effective",
  windowDispositionBasis: null,
  status: "found",
  nextTextCursor: null,
  text: "Current wording",
  truncated: false,
  ...overrides,
});

const DEFAULT_SUBJECT = { eli: "eli:example", anchor: "article-1" };

const history = (
  items: ProvisionVersion[],
  subject = DEFAULT_SUBJECT,
): StatuteTimelineHistory => ({
  ...subject,
  items,
  nextCursor: null,
});

describe("statute timeline model", () => {
  test("keeps null version bounds open and clips them to the displayed domain", () => {
    const windows = timelineWindows(
      [
        version({ versionValidFrom: null, versionValidTo: "2024-06-01" }),
        version({
          documentId: "version-2",
          versionValidFrom: "2024-06-01",
          versionValidTo: null,
        }),
      ],
      "2024-07-01",
    );

    expect(windows.rows[0]).toMatchObject({ openStart: true, openEnd: false });
    expect(windows.rows[1]).toMatchObject({ openStart: false, openEnd: true });
    expect(windows.rows[0]?.start).toEqual(windows.domain[0]);
    expect(windows.rows[1]?.end).toEqual(windows.domain[1]);
  });

  test("marks a version current only inside an effective half-open window", () => {
    const bounded = version({
      versionValidFrom: "2024-01-01",
      versionValidTo: "2025-01-01",
    });
    expect(isCurrentVersion(bounded, "2024-01-01")).toBe(true);
    expect(isCurrentVersion(bounded, "2025-01-01")).toBe(false);
    expect(
      isCurrentVersion(
        version({ versionValidFrom: null, versionValidTo: "2024-06-01" }),
        "2024-01-01",
      ),
    ).toBe(true);
    expect(
      isCurrentVersion(
        version({ versionValidFrom: "2024-01-01", versionValidTo: null }),
        "2026-01-01",
      ),
    ).toBe(true);
    expect(
      isCurrentVersion(
        version({ windowDisposition: "withdrawn" }),
        "2024-06-01",
      ),
    ).toBe(false);
    expect(
      isCurrentVersion(
        version({ expressionKind: "promulgated" }),
        "2024-06-01",
      ),
    ).toBe(false);
    const gap = [
      version({ versionValidTo: "2024-02-01" }),
      version({
        documentId: "version-2",
        versionValidFrom: "2024-03-01",
      }),
    ].filter((candidate) => isCurrentVersion(candidate, "2024-02-15"));
    expect(gap).toEqual([]);
  });

  test("parses found, withheld and truncated wording using the exact projection", () => {
    const withheldVersion = {
      url: null,
      documentId: "version-2",
      resourceName: "resource-2",
      versionValidFrom: "2023-01-01",
      versionValidTo: "2024-01-01",
      expressionKind: "consolidation",
      windowDisposition: "effective",
      windowDispositionBasis: null,
      status: "text_withheld",
      message: "Wording unavailable",
    } as const satisfies Extract<ProvisionVersion, { status: "text_withheld" }>;
    const payload = {
      eli: "eli:example",
      anchor: "article-1",
      items: [
        version({ truncated: true, nextTextCursor: "wording-next-page" }),
        withheldVersion,
      ],
      nextCursor: "cursor-next",
    } as const satisfies StatuteTimelineHistory;

    const parsed = parseStatuteTimelineHistory(payload);
    expect(parsed).toEqual(payload);
    expect(
      parseStatuteTimelineHistory({ ...payload, unexpected: true }),
    ).toBeUndefined();
    const first = parsed?.items.at(0);
    if (first?.status !== "found") {
      throw new Error("Expected found provision wording");
    }
    expect(versionWording(first)).toEqual({
      type: "wording",
      text: "Current wording",
      truncated: true,
    });
    const second = parsed?.items.at(1);
    if (second?.status !== "text_withheld") {
      throw new Error("Expected withheld provision wording");
    }
    expect(versionWording(second)).toEqual({
      type: "withheld",
      message: "Wording unavailable",
    });
  });

  test("merges pages by document id and replaces history when its subject changes", () => {
    const original = history([
      version(),
      version({ documentId: "version-2", text: "Older wording" }),
    ]);
    const page = history([
      version({ text: "Updated wording" }),
      version({ documentId: "version-3", text: "Newest wording" }),
    ]);
    const merged = mergeHistory(original, page);

    expect(merged.items.map(({ documentId }) => documentId)).toEqual([
      "version-1",
      "version-2",
      "version-3",
    ]);
    const first = merged.items.at(0);
    expect(first?.status).toBe("found");
    if (first?.status !== "found") {
      throw new Error("Expected merged found wording");
    }
    expect(first.text).toBe("Updated wording");
    expect(merged.nextCursor).toBe(page.nextCursor);

    const changedSubject = history(
      [version({ documentId: "other-subject-version" })],
      {
        eli: "eli:other",
        anchor: "article-1",
      },
    );
    expect(mergeHistory(original, changedSubject)).toBe(changedSubject);
  });

  test.each([260, 3000])(
    "compares %i repeated words as a bounded replacement without losing either wording",
    (count) => {
      const older = version({ documentId: "old", text: "a ".repeat(count) });
      const newer = version({ documentId: "new", text: "b ".repeat(count) });
      const comparison = compareAdjacentVersions([newer, older], "new");
      expect(comparison?.segments.every(({ type }) => type !== "equal")).toBe(
        true,
      );
      expect(
        comparison?.segments
          .filter(({ type }) => type === "delete")
          .map(({ text }) => text)
          .join(""),
      ).toBe(older.text);
      expect(
        comparison?.segments
          .filter(({ type }) => type === "insert")
          .map(({ text }) => text)
          .join(""),
      ).toBe(newer.text);
    },
  );

  test("compares adjacent wording only when both versions are found and reports truncation", () => {
    const newer = version({
      documentId: "new",
      text: "A changed phrase",
      truncated: true,
    });
    const older = version({ documentId: "old", text: "An older phrase" });
    const comparison = compareAdjacentVersions([newer, older], "new");
    expect(comparison?.truncated).toBe(true);
    expect(
      comparison?.segments.map(({ type, text }) => ({ type, text })),
    ).toContainEqual({ type: "insert", text: "changed" });

    expect(
      compareAdjacentVersions(
        [
          newer,
          {
            url: null,
            documentId: "withheld",
            resourceName: "resource-withheld",
            versionValidFrom: "2024-01-01",
            versionValidTo: null,
            expressionKind: "consolidation",
            windowDisposition: "effective",
            windowDispositionBasis: null,
            status: "text_withheld",
            message: "Unavailable",
          } satisfies Extract<ProvisionVersion, { status: "text_withheld" }>,
        ],
        "new",
      ),
    ).toBeNull();
    expect(compareAdjacentVersions([newer], "missing")).toBeNull();
  });
});
