import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  SHAREPOINT_IMPORT_MAX_ITEMS,
  SHAREPOINT_ITEM_KIND,
  SHAREPOINT_REFUSAL_CODE,
} from "@stll/api-contract/sharepoint";

import {
  deferredSharepointFiles,
  openSharepointDrive,
  openSharepointFolder,
  openSharepointSource,
  SHAREPOINT_PICKER_START,
  sharepointBreadcrumb,
  sharepointBrowseRefusal,
  sharepointFolderId,
  sharepointItemAction,
  type SharepointPickerLocation,
  type SharepointSelectedFile,
  summarizeSharepointImport,
  toggleSharepointFile,
} from "./sharepoint-picker.logic";

const site = { id: "contoso.sharepoint.com,1,2", name: "Litigation" };
const drive = { id: "b!drive", name: "Documents" };
const pleadings = { id: "01PLEADINGS", name: "Pleadings" };
const drafts = { id: "01DRAFTS", name: "Drafts" };

const folderAt = (
  location: SharepointPickerLocation,
): Extract<SharepointPickerLocation, { type: "folder" }> => {
  if (location.type !== "folder") {
    return panic(`Expected a folder, got ${location.type}`);
  }
  return location;
};

const drivesAt = (
  location: SharepointPickerLocation,
): Extract<SharepointPickerLocation, { type: "drives" }> => {
  if (location.type !== "drives") {
    return panic(`Expected drives, got ${location.type}`);
  }
  return location;
};

/** Every place a member can reach: sites, a source, a drive and two folders deep. */
const reachableLocations = (): SharepointPickerLocation[] => {
  const locations: SharepointPickerLocation[] = [SHAREPOINT_PICKER_START];
  for (const source of [
    { type: "site", site } as const,
    { type: "onedrive" } as const,
  ]) {
    const drives = drivesAt(openSharepointSource(source));
    const root = folderAt(openSharepointDrive(drives, drive));
    const first = folderAt(openSharepointFolder(root, pleadings));
    const second = openSharepointFolder(first, drafts);
    locations.push(drives, root, first, second);
  }
  return locations;
};

describe("SharePoint picker breadcrumb", () => {
  test("names every step from the site list to a nested folder", () => {
    const drives = drivesAt(openSharepointSource({ type: "site", site }));
    const nested = folderAt(
      openSharepointFolder(
        folderAt(
          openSharepointFolder(
            folderAt(openSharepointDrive(drives, drive)),
            pleadings,
          ),
        ),
        drafts,
      ),
    );

    expect(sharepointBreadcrumb(nested).map((crumb) => crumb.label)).toEqual([
      { type: "sites" },
      { type: "name", name: "Litigation" },
      { type: "name", name: "Documents" },
      { type: "name", name: "Pleadings" },
      { type: "name", name: "Drafts" },
    ]);
    expect(sharepointFolderId(nested)).toBe(drafts.id);
  });

  test("labels the member's own drive as OneDrive, not by a site name", () => {
    const drives = openSharepointSource({ type: "onedrive" });

    expect(sharepointBreadcrumb(drives).map((crumb) => crumb.label)).toEqual([
      { type: "sites" },
      { type: "onedrive" },
    ]);
  });

  test("the top of a drive has no folder id, so the API lists its root", () => {
    const root = folderAt(
      openSharepointDrive(
        drivesAt(openSharepointSource({ type: "onedrive" })),
        drive,
      ),
    );

    expect(sharepointFolderId(root)).toBeNull();
  });

  test("every crumb leads to the place whose breadcrumb is that prefix", () => {
    for (const location of reachableLocations()) {
      const crumbs = sharepointBreadcrumb(location);

      expect(crumbs.at(-1)?.target).toEqual(location);
      for (const [index, crumb] of crumbs.entries()) {
        expect(sharepointBreadcrumb(crumb.target)).toEqual(
          crumbs.slice(0, index + 1),
        );
      }
      expect(new Set(crumbs.map((crumb) => crumb.key)).size).toBe(
        crumbs.length,
      );
    }
  });
});

describe("SharePoint item actions", () => {
  test("folders open, files are picked, and anything else cannot be imported", () => {
    expect(sharepointItemAction(SHAREPOINT_ITEM_KIND.folder)).toBe("open");
    expect(sharepointItemAction(SHAREPOINT_ITEM_KIND.file)).toBe("select");
    expect(sharepointItemAction(SHAREPOINT_ITEM_KIND.other)).toBe("none");
  });
});

const fileNumbered = (index: number): SharepointSelectedFile => ({
  driveId: drive.id,
  itemId: `01FILE${index}`,
  name: `Statement of claim ${index}.docx`,
});

const selectAll = (files: readonly SharepointSelectedFile[]) => {
  let selection: readonly SharepointSelectedFile[] = [];
  for (const file of files) {
    const change = toggleSharepointFile(selection, file);
    if (change.type !== "changed") {
      return panic(`Unexpected refusal for ${file.itemId}`);
    }
    selection = change.selection;
  }
  return selection;
};

describe("SharePoint selection", () => {
  test("accepts files up to the import limit and refuses one more", () => {
    const full = selectAll(
      Array.from({ length: SHAREPOINT_IMPORT_MAX_ITEMS }, (_, index) =>
        fileNumbered(index),
      ),
    );

    expect(full).toHaveLength(SHAREPOINT_IMPORT_MAX_ITEMS);
    expect(
      toggleSharepointFile(full, fileNumbered(SHAREPOINT_IMPORT_MAX_ITEMS)),
    ).toEqual({ type: "limit-reached" });
  });

  test("a full selection still lets a picked file be removed", () => {
    const full = selectAll(
      Array.from({ length: SHAREPOINT_IMPORT_MAX_ITEMS }, (_, index) =>
        fileNumbered(index),
      ),
    );
    const change = toggleSharepointFile(full, fileNumbered(3));

    expect(change.type).toBe("changed");
    expect(change.type === "changed" && change.selection).toHaveLength(
      SHAREPOINT_IMPORT_MAX_ITEMS - 1,
    );
  });

  test("toggling a file twice restores the selection", () => {
    const selection = selectAll([fileNumbered(1), fileNumbered(2)]);
    const added = toggleSharepointFile(selection, fileNumbered(3));
    const removed =
      added.type === "changed"
        ? toggleSharepointFile(added.selection, fileNumbered(3))
        : added;

    expect(removed).toEqual({ type: "changed", selection });
  });

  test("the same item in another drive is a different file", () => {
    const selection = selectAll([
      fileNumbered(1),
      { ...fileNumbered(1), driveId: "b!other" },
    ]);

    expect(selection).toHaveLength(2);
  });
});

describe("SharePoint import summary", () => {
  test("names each outcome after the picked file, failures included", () => {
    const picked = [fileNumbered(1), fileNumbered(2), fileNumbered(3)];
    const summary = summarizeSharepointImport(picked, [
      {
        driveId: drive.id,
        itemId: "01FILE3",
        status: "failed",
        code: SHAREPOINT_REFUSAL_CODE.fileTooLarge,
      },
      {
        driveId: drive.id,
        itemId: "01FILE1",
        status: "created",
        name: "Statement of claim 1.docx",
      },
      {
        driveId: drive.id,
        itemId: "01FILE2",
        status: "unchanged",
        name: "Statement of claim 2.docx",
      },
    ]);

    expect(summary).toMatchObject({
      created: 1,
      versioned: 0,
      unchanged: 1,
      failed: 1,
    });
    expect(
      summary.outcomes.map(({ name, status }) => ({ name, status })),
    ).toEqual([
      { name: "Statement of claim 1.docx", status: "created" },
      { name: "Statement of claim 2.docx", status: "unchanged" },
      { name: "Statement of claim 3.docx", status: "failed" },
    ]);
    expect(summary.outcomes.at(2)).toMatchObject({
      code: SHAREPOINT_REFUSAL_CODE.fileTooLarge,
    });
  });

  test("a picked file the answer does not mention is unconfirmed, not imported", () => {
    const summary = summarizeSharepointImport(
      [fileNumbered(1), fileNumbered(2)],
      [
        {
          driveId: drive.id,
          itemId: "01FILE1",
          status: "versioned",
          name: "Statement of claim 1.docx",
        },
      ],
    );

    expect(summary.unconfirmed).toBe(1);
    expect(
      summary.created +
        summary.versioned +
        summary.unchanged +
        summary.failed +
        summary.unconfirmed,
    ).toBe(summary.outcomes.length);
  });
});

describe("SharePoint import rounds", () => {
  const picked = [fileNumbered(1), fileNumbered(2), fileNumbered(3)];
  const deferred = (index: number) => ({
    driveId: drive.id,
    itemId: `01FILE${index}`,
    status: "deferred" as const,
  });
  const created = (index: number) => ({
    driveId: drive.id,
    itemId: `01FILE${index}`,
    status: "created" as const,
    name: `Statement of claim ${index}.docx`,
  });

  test("re-sends only the files the last round deferred", () => {
    const firstRound = [created(1), deferred(2), deferred(3)];

    expect(deferredSharepointFiles(picked, firstRound)).toEqual([
      fileNumbered(2),
      fileNumbered(3),
    ]);
  });

  test("a later round's answer replaces a deferral", () => {
    const rounds = [
      created(1),
      deferred(2),
      deferred(3),
      created(2),
      deferred(3),
      created(3),
    ];

    expect(deferredSharepointFiles(picked, rounds)).toEqual([]);
    expect(summarizeSharepointImport(picked, rounds)).toMatchObject({
      created: 3,
      failed: 0,
    });
  });

  test("a file still deferred when the rounds stop is unconfirmed, and earlier results stay", () => {
    const summary = summarizeSharepointImport(picked, [
      created(1),
      created(2),
      deferred(3),
    ]);

    expect(summary).toMatchObject({ created: 2, failed: 0, unconfirmed: 1 });
    expect(summary.outcomes.at(2)).toMatchObject({
      name: "Statement of claim 3.docx",
      status: "unconfirmed",
    });
  });
});

describe("SharePoint browse refusals", () => {
  test("a missing or lost grant asks to connect", () => {
    expect(
      sharepointBrowseRefusal({
        code: SHAREPOINT_REFUSAL_CODE.notConnected,
        retryAfterMs: undefined,
      }),
    ).toEqual({ type: "not-connected" });
    expect(
      sharepointBrowseRefusal({
        code: SHAREPOINT_REFUSAL_CODE.reconnectRequired,
        retryAfterMs: undefined,
      }),
    ).toEqual({ type: "reconnect-required" });
  });

  test("throttling rounds the advised wait up to whole seconds", () => {
    expect(
      sharepointBrowseRefusal({
        code: SHAREPOINT_REFUSAL_CODE.throttled,
        retryAfterMs: 1500,
      }),
    ).toEqual({ type: "throttled", retryAfterSeconds: 2 });
    expect(
      sharepointBrowseRefusal({
        code: SHAREPOINT_REFUSAL_CODE.throttled,
        retryAfterMs: "soon",
      }),
    ).toEqual({ type: "throttled", retryAfterSeconds: null });
  });

  test("any other refusal is a plain failure", () => {
    expect(
      sharepointBrowseRefusal({
        code: SHAREPOINT_REFUSAL_CODE.accessDenied,
        retryAfterMs: undefined,
      }),
    ).toEqual({ type: "other" });
    expect(
      sharepointBrowseRefusal({ code: undefined, retryAfterMs: undefined }),
    ).toEqual({ type: "other" });
  });
});
