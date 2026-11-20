import { describe, expect, test } from "bun:test";

import type { CreateFileEntitiesInput } from "@/lib/workspaces/mutations/create-file-entities-input.logic";
import {
  afterDuplicateChoice,
  DUPLICATE_CHECK,
  hasUploadInputItems,
  REFERENCE_CHECK,
  withoutUploadInputFiles,
  withUploadInputFileReplacements,
} from "@/lib/workspaces/mutations/create-file-entities-input.logic";

const file = (name: string): File => new File([name], name);

describe("the upload left after the duplicate prompt", () => {
  test("skips the duplicates not chosen and keeps every other file", () => {
    const duplicate = file("contract.pdf");
    const uploadedAnyway = file("contract copy.pdf");
    const fresh = file("fresh.pdf");

    const remaining = afterDuplicateChoice({
      input: { files: [duplicate, fresh, uploadedAnyway], parentId: "folder" },
      duplicateFiles: [duplicate, uploadedAnyway],
      uploadAnywayFiles: [uploadedAnyway],
    });

    expect(remaining).toEqual({
      files: [fresh, uploadedAnyway],
      parentId: "folder",
      referenceCheck: REFERENCE_CHECK.skip,
      duplicateCheck: DUPLICATE_CHECK.skip,
    });
  });

  test("a dismissed prompt skips the duplicates and uploads the rest", () => {
    const duplicate = file("contract.pdf");
    const fresh = file("fresh.pdf");

    const remaining = afterDuplicateChoice({
      input: { files: [duplicate, fresh] },
      duplicateFiles: [duplicate],
      uploadAnywayFiles: [],
    });

    expect("files" in remaining && remaining.files).toEqual([fresh]);
  });

  test("a batch of only skipped duplicates uploads nothing", () => {
    const duplicate = file("contract.pdf");

    expect(
      hasUploadInputItems(
        afterDuplicateChoice({
          input: { files: [duplicate] },
          duplicateFiles: [duplicate],
          uploadAnywayFiles: [],
        }),
      ),
    ).toBe(false);
  });
});

describe("a dropped folder after some files are left out", () => {
  const tree = (
    files: { file: File; pathSegments: string[] }[],
    directoryPaths: string[][],
  ): CreateFileEntitiesInput => ({
    tree: { files, directoryPaths },
    parentId: null,
  });

  test("re-dropping a folder whose files are all skipped creates nothing", () => {
    const a = file("a.pdf");
    const b = file("b.pdf");
    const input = tree(
      [
        { file: a, pathSegments: ["Pleadings", "a.pdf"] },
        { file: b, pathSegments: ["Pleadings", "2026", "b.pdf"] },
      ],
      [["Pleadings"], ["Pleadings", "2026"], ["Pleadings", "2026", "empty"]],
    );

    const remaining = withoutUploadInputFiles(input, new Set([a, b]));

    expect(hasUploadInputItems(remaining)).toBe(false);
  });

  test("keeps the directories a kept file still lands in", () => {
    const skipped = file("old.pdf");
    const kept = file("new.pdf");
    const input = tree(
      [
        { file: skipped, pathSegments: ["Pleadings", "Old", "old.pdf"] },
        { file: kept, pathSegments: ["Pleadings", "New", "new.pdf"] },
      ],
      [
        ["Pleadings"],
        ["Pleadings", "Old"],
        ["Pleadings", "Old", "Drafts"],
        ["Pleadings", "New"],
        ["Pleadings", "Empty"],
      ],
    );

    const remaining = withoutUploadInputFiles(input, new Set([skipped]));

    expect("tree" in remaining && remaining.tree).toEqual({
      files: [{ file: kept, pathSegments: ["Pleadings", "New", "new.pdf"] }],
      // The folder the drop already held empty stays; the one emptied by the
      // skip goes, with everything inside it.
      directoryPaths: [
        ["Pleadings"],
        ["Pleadings", "New"],
        ["Pleadings", "Empty"],
      ],
    });
  });

  test("a folder dropped empty is still created", () => {
    const input = tree([], [["Empty"]]);

    const remaining = withoutUploadInputFiles(input, new Set());

    expect("tree" in remaining && remaining.tree.directoryPaths).toEqual([
      ["Empty"],
    ]);
  });
});

test("replacing files keeps the caller's checks", () => {
  const original = file("template.docx");
  const replacement = file("template-filled.docx");

  expect(
    withUploadInputFileReplacements(
      {
        files: [original],
        parentId: null,
        referenceCheck: REFERENCE_CHECK.skip,
        duplicateCheck: DUPLICATE_CHECK.skip,
      },
      new Map([[original, replacement]]),
    ),
  ).toEqual({
    files: [replacement],
    parentId: null,
    referenceCheck: REFERENCE_CHECK.skip,
    duplicateCheck: DUPLICATE_CHECK.skip,
  });
});
