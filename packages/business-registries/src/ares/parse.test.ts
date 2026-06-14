import { describe, expect, test } from "bun:test";

import { enrichWithVr, parseAddress, parseResRecord } from "./parse.js";
import type { AresVrResponse } from "./types.js";

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

describe("enrichWithVr", () => {
  test("keeps raw share capital text when the VR value is not numeric", () => {
    const company = parseResRecord({
      ico: "12345678",
      obchodniJmeno: "Example s.r.o.",
      primarniZaznam: true,
    });
    const vr = {
      icoId: "12345678",
      zaznamy: [
        {
          primarniZaznam: true,
          zakladniKapital: [
            {
              vklad: {
                hodnota: "not-a-number",
                typObnos: "KORUNY",
              },
            },
          ],
        },
      ],
    } satisfies AresVrResponse;

    expect(enrichWithVr(company, vr).shareCapital).toBe("not-a-number Kc");
  });
});
