import { describe, expect, test } from "bun:test";

import { parseAddress } from "./parse.js";

describe("parseAddress", () => {
  test("treats null numeric address fields as missing", () => {
    const address = parseAddress({
      cisloDomovni: null,
      cisloOrientacni: null,
      psc: null,
      pscTxt: "110 00",
    });

    expect(address.houseNumber).toBeNull();
    expect(address.orientationNumber).toBeNull();
    expect(address.postalCode).toBe("110 00");
  });
});
