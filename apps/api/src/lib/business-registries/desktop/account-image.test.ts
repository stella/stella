import { describe, expect, test } from "bun:test";

import {
  DESKTOP_ACCOUNT_IMAGE_MAX_LENGTH,
  desktopAccountImage,
  desktopVerifiedAccount,
} from "@/api/lib/business-registries/desktop/account-image";

// A 1×1 PNG.
const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";

describe("the picture the desktop is sent", () => {
  test("an https URL or a raster data URL passes", () => {
    expect(
      desktopAccountImage("https://images.example.test/members/42.png?s=96"),
    ).toBe("https://images.example.test/members/42.png?s=96");
    expect(desktopAccountImage(PNG_DATA_URL)).toBe(PNG_DATA_URL);
  });

  test("anything the desktop could not load safely is no picture", () => {
    for (const image of [
      null,
      undefined,
      "",
      "http://images.example.test/42.png",
      "https://member:secret@images.example.test/42.png",
      "file:///srv/pictures/42.png",
      "ftp://images.example.test/42.png",
      "data:image/svg+xml;base64,PHN2Zy8+",
      "data:text/html;base64,PGh0bWw+",
      `${PNG_DATA_URL}" onerror="alert(1)`,
      "not a url",
      `data:image/png;base64,${"A".repeat(DESKTOP_ACCOUNT_IMAGE_MAX_LENGTH)}`,
    ]) {
      expect([image, desktopAccountImage(image)]).toEqual([image, null]);
    }
  });

  test("the verification keeps the picture beside the saved account, never in it", () => {
    const verified = desktopVerifiedAccount(
      {
        email: "eliska.novakova@example.test",
        image: PNG_DATA_URL,
        name: "Eliška Nováková",
      },
      "2026-11-23T12:00:00Z",
    );
    expect(verified).toEqual({
      account: {
        email: "eliska.novakova@example.test",
        name: "Eliška Nováková",
        verifiedAt: "2026-11-23T12:00:00Z",
      },
      accountImage: PNG_DATA_URL,
    });
    expect(Object.keys(verified.account).toSorted()).toEqual([
      "email",
      "name",
      "verifiedAt",
    ]);
    expect(
      desktopVerifiedAccount(
        { email: "member@example.test", image: null, name: "Member" },
        "2026-11-23T12:00:00Z",
      ).accountImage,
    ).toBeNull();
  });
});
