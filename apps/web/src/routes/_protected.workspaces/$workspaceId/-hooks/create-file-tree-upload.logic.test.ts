import { describe, expect, test } from "bun:test";

import { buildDroppedFolderUploadPlan } from "@/routes/_protected.workspaces/$workspaceId/-hooks/create-file-tree-upload.logic";

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
});
