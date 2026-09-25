import { describe, expect, test } from "bun:test";

import { downloadAction, downloadOwner } from "./download-guard";

const origins = {
  contained: new Set([
    "https://portal.example.com",
    // A cross-origin frame inside the controlled tab.
    "https://files.example.net",
  ]),
  user: new Set(["https://files.example.org", "https://files.example.net"]),
};
const download = (url: string, referrer = "", finalUrl = url) => ({
  finalUrl,
  referrer,
  url,
});

describe("download owner", () => {
  test("a blob saved by the controlled page or any of its frames is contained", () => {
    expect(
      downloadOwner(download("blob:https://portal.example.com/7f0c"), origins),
    ).toBe("contained");
    // The frame's origin wins even when the user also has that site open.
    expect(
      downloadOwner(download("blob:https://files.example.net/51aa"), origins),
    ).toBe("contained");
  });

  test("a download traced only to the user's tabs is the user's", () => {
    expect(
      downloadOwner(
        download(
          "https://files.example.org/report.pdf",
          "https://files.example.org/",
        ),
        origins,
      ),
    ).toBe("user");
    expect(
      downloadOwner(
        {
          ...download("data:text/plain;base64,AAAA"),
          byExtensionId: "other-extension",
        },
        origins,
      ),
    ).toBe("user");
  });

  test("a download no open frame accounts for is unknown", () => {
    for (const url of [
      "data:text/plain;base64,AAAA",
      "blob:null/1c2d",
      "blob:https://gone.example.com/9e8f",
    ]) {
      expect(downloadOwner(download(url), origins)).toBe("unknown");
    }
    expect(
      downloadOwner(
        download("data:text/plain;base64,AAAA", "https://portal.example.com/"),
        origins,
      ),
    ).toBe("contained");
  });
});

describe("download action", () => {
  test("only a contained frame's finished file is ever deleted", () => {
    expect(downloadAction("contained", "complete")).toBe("cancel-and-delete");
    expect(downloadAction("contained", "in_progress")).toBe(
      "cancel-and-delete",
    );
    expect(downloadAction("unknown", "in_progress")).toBe("cancel");
    expect(downloadAction("unknown", "complete")).toBe("allow");
    expect(downloadAction("user", "in_progress")).toBe("allow");
  });
});
