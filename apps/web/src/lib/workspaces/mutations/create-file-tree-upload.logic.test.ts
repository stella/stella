import { describe, expect, test } from "bun:test";

import { UPLOAD_DOCUMENT_MAX_BYTES } from "@stll/api-contract/limits";

import {
  buildDroppedFolderUploadPlan,
  folderReservableFiles,
} from "@/lib/workspaces/mutations/create-file-tree-upload.logic";

describe("dropped folder upload planning", () => {
  test("creates directories before assigning files to leaf parents", () => {
    const directFile = new File(["direct"], "loose.eml");
    const nestedFile = new File(["nested"], "a.eml");

    const plan = buildDroppedFolderUploadPlan({
      directoryPaths: [["samples", "empty"]],
      files: [
        { file: directFile, pathSegments: ["loose.eml"] },
        { file: nestedFile, pathSegments: ["samples", "eml", "a.eml"] },
      ],
    });

    const samples = plan.directories.at(0);
    const empty = plan.directories.at(1);
    const eml = plan.directories.at(2);
    const direct = plan.files.at(0);
    const nested = plan.files.at(1);

    if (!samples || !empty || !eml || !direct || !nested) {
      throw new Error("Expected upload plan to include directories and files");
    }

    expect(samples).toMatchObject({
      name: "samples",
      parentKey: null,
    });
    expect(empty).toMatchObject({
      name: "empty",
      parentKey: samples.key,
    });
    expect(eml).toMatchObject({
      name: "eml",
      parentKey: samples.key,
    });
    expect(direct).toEqual({ file: directFile, parentKey: null });
    expect(nested).toEqual({ file: nestedFile, parentKey: eml.key });
  });

  test("dedupes directory paths that are implied by multiple files", () => {
    const first = new File(["first"], "one.eml");
    const second = new File(["second"], "two.eml");

    const plan = buildDroppedFolderUploadPlan({
      directoryPaths: [],
      files: [
        { file: first, pathSegments: ["samples", "eml", "one.eml"] },
        { file: second, pathSegments: ["samples", "eml", "two.eml"] },
      ],
    });

    expect(plan.directories.map(({ name }) => name)).toEqual([
      "samples",
      "eml",
    ]);
    const firstPlacement = plan.files.at(0);
    if (!firstPlacement) {
      throw new Error("Expected upload plan to include files");
    }
    expect(
      plan.files.every(
        ({ parentKey }) => parentKey === firstPlacement.parentKey,
      ),
    ).toBe(true);
  });

  test.each([
    { name: "An empty file", refused: new File([], "refused.txt") },
    {
      name: "An oversize file",
      refused: Object.defineProperty(new File(["x"], "refused.txt"), "size", {
        value: UPLOAD_DOCUMENT_MAX_BYTES + 1,
      }),
    },
  ])(
    "$name stays out of the folder reservation and keeps the others' keys",
    ({ refused }) => {
      const first = new File(["first"], "first.txt");
      const last = new File(["x"], "last.txt");

      const plan = buildDroppedFolderUploadPlan({
        directoryPaths: [],
        files: [
          { file: first, pathSegments: ["docs", "first.txt"] },
          { file: refused, pathSegments: ["docs", "refused.txt"] },
          { file: last, pathSegments: ["last.txt"] },
        ],
      });

      expect(
        folderReservableFiles(plan).map(({ key, placement }) => ({
          key,
          file: placement.file,
        })),
      ).toEqual([
        { key: "0", file: first },
        { key: "2", file: last },
      ]);
    },
  );
});
