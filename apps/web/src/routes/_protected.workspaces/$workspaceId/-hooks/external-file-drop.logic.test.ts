import { describe, expect, test } from "bun:test";

import {
  collectDroppedFileTree,
  type DroppedDataTransferItem,
} from "@/routes/_protected.workspaces/$workspaceId/-hooks/external-file-drop.logic";

type TestEntry = TestFileEntry | TestDirectoryEntry;

class TestFileEntry {
  readonly isFile = true;
  readonly name: string;
  private readonly fileValue: File;

  constructor(name: string, fileValue?: File) {
    this.name = name;
    this.fileValue =
      fileValue ?? new File(["test"], name, { type: "text/plain" });
  }

  file(successCallback: (file: File) => void) {
    successCallback(this.fileValue);
  }
}

class TestDirectoryEntry {
  readonly isDirectory = true;
  readonly name: string;
  private readonly batches: TestEntry[][];

  constructor(name: string, batches: TestEntry[][]) {
    this.name = name;
    this.batches = batches;
  }

  createReader() {
    const unreadBatches = [...this.batches];
    return {
      readEntries: (successCallback: (entries: TestEntry[]) => void) => {
        successCallback(unreadBatches.shift() ?? []);
      },
    };
  }
}

const itemForEntry = (entry: TestEntry): DroppedDataTransferItem => ({
  kind: "file",
  getAsFile: () => null,
  webkitGetAsEntry: () => entry,
});

const itemForFile = (file: File): DroppedDataTransferItem => ({
  kind: "file",
  getAsFile: () => file,
});

describe("external folder drops", () => {
  test("reads dropped folders recursively and preserves empty directories", async () => {
    const rootFile = new File(["root"], "root.eml", {
      type: "message/rfc822",
    });
    const nestedFile = new File(["nested"], "child.msg", {
      type: "application/vnd.ms-outlook",
    });
    const root = new TestDirectoryEntry("stella-email-samples", [
      [new TestFileEntry("root.eml", rootFile)],
      [
        new TestDirectoryEntry("eml", [
          [new TestFileEntry("child.msg", nestedFile)],
        ]),
        new TestDirectoryEntry("empty", []),
      ],
    ]);

    const tree = await collectDroppedFileTree({
      items: [itemForEntry(root)],
    });

    expect(tree.directoryPaths).toEqual([
      ["stella-email-samples"],
      ["stella-email-samples", "eml"],
      ["stella-email-samples", "empty"],
    ]);
    expect(tree.files.map(({ pathSegments }) => pathSegments)).toEqual([
      ["stella-email-samples", "root.eml"],
      ["stella-email-samples", "eml", "child.msg"],
    ]);
    expect(tree.files.map(({ file }) => file)).toEqual([rootFile, nestedFile]);
  });

  test("keeps direct file drops at the target folder", async () => {
    const file = new File(["direct"], "loose.eml", {
      type: "message/rfc822",
    });

    const tree = await collectDroppedFileTree({
      items: [
        itemForFile(file),
        {
          kind: "string",
          getAsFile: () => null,
        },
      ],
    });

    expect(tree.directoryPaths).toEqual([]);
    expect(tree.files).toEqual([{ file, pathSegments: ["loose.eml"] }]);
  });
});
