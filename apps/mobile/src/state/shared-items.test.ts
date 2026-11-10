import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  isShareId,
  parseShareManifest,
  SHARE_STALE_AFTER_MS,
  sharedDraftText,
  shareDestinations,
  sharedPickedFiles,
  staleInboxEntries,
} from "./shared-items";
import type { SharedItem } from "./shared-items";

const FOLDER =
  "file:///group/ShareInbox/1762772400000-6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b/";
const NOW = 1_762_772_400_000;

const shareName = (createdAt: number) =>
  `${String(createdAt)}-6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b`;

const manifest = (items: readonly unknown[]) => JSON.stringify({ items });

const parsed = (text: string) => {
  const result = parseShareManifest(text, FOLDER);
  return result.isOk() ? result.value : result.error._tag;
};

describe("a share's name", () => {
  test("names a share only as the extension writes it", () => {
    expect(isShareId(shareName(NOW))).toBe(true);
    expect(isShareId("../Library")).toBe(false);
    expect(isShareId(`${shareName(NOW)}/..`)).toBe(false);
    expect(isShareId(shareName(NOW).toUpperCase())).toBe(false);
    expect(isShareId(undefined)).toBe(false);
  });

  test("no accepted name reaches outside its folder", () => {
    assertProperty(
      "no accepted name reaches outside its folder",
      fc.property(fc.string(), (value) => {
        if (isShareId(value)) {
          expect(value).not.toMatch(/[/\\]|\.\./u);
        }
      }),
    );
  });
});

describe("the inbox sweep", () => {
  test("deletes shares past the hour and anything not a share, never the one opened", () => {
    const fresh = shareName(NOW - 60_000);
    const stale = shareName(NOW - SHARE_STALE_AFTER_MS);
    const opened = shareName(NOW - 2 * SHARE_STALE_AFTER_MS);
    expect(
      staleInboxEntries({
        keep: opened,
        names: [fresh, stale, opened, "stray.tmp"],
        now: NOW,
      }),
    ).toEqual([stale, "stray.tmp"]);
  });

  test("a share is deleted exactly once it is an hour old", () => {
    assertProperty(
      "a share is deleted exactly once it is an hour old",
      fc.property(
        fc.integer({ min: 0, max: 10 * SHARE_STALE_AFTER_MS }),
        (age) => {
          const name = shareName(NOW - age);
          expect(
            staleInboxEntries({ keep: undefined, names: [name], now: NOW }),
          ).toEqual(age >= SHARE_STALE_AFTER_MS ? [name] : []);
        },
      ),
    );
  });
});

describe("a share's manifest", () => {
  test("lists files inside the share's folder, links and text, in order", () => {
    expect(
      parsed(
        manifest([
          {
            type: "file",
            file: "0.pdf",
            name: "Lease.pdf",
            mimeType: "application/pdf",
          },
          { type: "link", url: "https://example.com/judgment" },
          { type: "text", text: "Clause 4.2" },
        ]),
      ),
    ).toEqual([
      {
        type: "file",
        id: "0",
        uri: `${FOLDER}0.pdf`,
        name: "Lease.pdf",
        mimeType: "application/pdf",
      },
      { type: "link", id: "1", url: "https://example.com/judgment" },
      { type: "text", id: "2", text: "Clause 4.2" },
    ]);
  });

  test("addresses a file inside a folder named without its trailing slash", () => {
    const result = parseShareManifest(
      manifest([
        { type: "file", file: "3", name: "Notes", mimeType: "text/plain" },
      ]),
      FOLDER.slice(0, -1),
    );
    expect(result.isOk() ? result.value.at(0) : undefined).toMatchObject({
      uri: `${FOLDER}3`,
    });
  });

  test("refuses a file named as a path, an empty share and anything not JSON", () => {
    for (const file of ["../secret.pdf", "/etc/hosts", "0/1.pdf", "a.pdf"]) {
      expect(
        parsed(
          manifest([
            { type: "file", file, name: "x.pdf", mimeType: "application/pdf" },
          ]),
        ),
      ).toBe("SharedItemsError");
    }
    expect(parsed(manifest([]))).toBe("SharedItemsError");
    expect(parsed("{")).toBe("SharedItemsError");
    expect(parsed(manifest([{ type: "link", url: "not a url" }]))).toBe(
      "SharedItemsError",
    );
  });

  test("every file it accepts stays inside the share's folder", () => {
    assertProperty(
      "every file it accepts stays inside the share's folder",
      fc.property(fc.string(), (file) => {
        const result = parseShareManifest(
          manifest([{ type: "file", file, name: "x", mimeType: "text/plain" }]),
          FOLDER,
        );
        if (result.isOk()) {
          const uri = result.value.at(0);
          expect(uri?.type === "file" ? uri.uri : "").toBe(`${FOLDER}${file}`);
          expect(file).toMatch(/^[\da-z.]+$/u);
          expect(file).not.toContain("..");
        }
      }),
    );
  });
});

const FILE: SharedItem = {
  type: "file",
  id: "0",
  uri: `${FOLDER}0.pdf`,
  name: "Lease.pdf",
  mimeType: "application/pdf",
};
const LINK: SharedItem = {
  type: "link",
  id: "1",
  url: "https://example.com/judgment",
};
const TEXT: SharedItem = { type: "text", id: "2", text: "  Clause 4.2\n" };

describe("where a share goes", () => {
  test("a matter is offered only for files; a conversation always", () => {
    expect(shareDestinations([FILE, LINK])).toEqual(["matter", "chat"]);
    expect(shareDestinations([LINK, TEXT])).toEqual(["chat"]);
  });

  test("a conversation takes links and text as the draft and files as attachments", () => {
    expect(sharedDraftText([FILE, LINK, TEXT])).toBe(
      "https://example.com/judgment\n\nClause 4.2",
    );
    expect(sharedDraftText([FILE])).toBe("");
    expect(sharedPickedFiles([LINK, FILE, TEXT])).toEqual([
      { uri: `${FOLDER}0.pdf`, name: "Lease.pdf", mimeType: "application/pdf" },
    ]);
  });
});
