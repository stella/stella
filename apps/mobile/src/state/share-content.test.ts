import { describe, expect, test } from "bun:test";

import { linkShareContent } from "./share-content";

const URL = "https://my.stll.app/law/cz/decision/1-as-64-2025";

describe("sharing a link", () => {
  test("iOS shares the link once, as a URL", () => {
    expect(linkShareContent(URL, "ios")).toEqual({ url: URL });
  });

  test("Android shares it as the message, the one field it reads", () => {
    expect(linkShareContent(URL, "android")).toEqual({ message: URL });
  });
});
