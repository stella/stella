import { describe, expect, test } from "bun:test";

import { statuteDisplayLabel } from "./statute-display-label";

const types = [
  ["cze", "zákon", "Zákon"],
  ["cze", "vyhláška", "Vyhláška"],
  ["cze", "nařízení vlády", "Nařízení vlády"],
  ["cze", "ústavní zákon", "Ústavní zákon"],
  ["svk", "zákon", "Zákon"],
  ["svk", "vyhláška", "Vyhláška"],
  ["svk", "nariadenie vlády", "Nariadenie vlády"],
  ["svk", "ústavný zákon", "Ústavný zákon"],
] as const;

describe("statute display identity", () => {
  test.each(types)(
    "%s preserves the publisher's %s",
    (country, documentType, type) => {
      const slovak = country === "svk";
      const label = statuteDisplayLabel({
        country,
        documentType,
        eli: slovak
          ? "https://www.slov-lex.sk/eli/sk/zz/2026/274"
          : "https://www.e-sbirka.cz/eli/cz/sb/2012/89",
        title: slovak ? "o meste Košice" : "89/2012 Sb., občanský zákoník",
      });
      expect(label.identity).toBe(
        `${type} č. ${slovak ? "274/2026 Z. z." : "89/2012 Sb."}`,
      );
      expect(label.subject).toBe(
        slovak ? "o meste Košice" : "občanský zákoník",
      );
      expect(label.text).toBe(
        `${type} č. ${slovak ? "274/2026 Z. z. o meste Košice" : "89/2012 Sb., občanský zákoník"}`,
      );
    },
  );

  test.each([
    [
      "SVK",
      "https://www.slov-lex.sk/eli/sk/zz/2026/274",
      "ktorým sa mení zákon č. 338/2000 Z. z.",
      "Zákon č. 274/2026 Z. z. ktorým sa mení zákon č. 338/2000 Z. z.",
    ],
    [
      "CZE",
      "https://www.e-sbirka.cz/eli/cz/sb/2025/120",
      "120/2025 Sb., kterým se mění zákon č. 262/2006 Sb.",
      "Zákon č. 120/2025 Sb., kterým se mění zákon č. 262/2006 Sb.",
    ],
  ])(
    "%s identifies an amending act independently of the amended act",
    (country, eli, title, expected) => {
      expect(
        statuteDisplayLabel({ country, eli, title, documentType: "zákon" })
          .text,
      ).toBe(expected);
    },
  );

  test("retains the historical gazette and source type", () => {
    expect(
      statuteDisplayLabel({
        country: "svk",
        eli: "https://www.slov-lex.sk/eli/sk/zz/1964/40",
        title: "Občiansky zákonník",
        documentType: "zákon",
      }).text,
    ).toBe("Zákon č. 40/1964 Zb. Občiansky zákonník");
  });

  test("does not invent a missing act type or number", () => {
    expect(
      statuteDisplayLabel({
        country: "svk",
        eli: "https://www.slov-lex.sk/eli/sk/zz/2026/274",
        title: "o meste Košice",
      }),
    ).toEqual({
      identity: "274/2026 Z. z.",
      subject: "o meste Košice",
      text: "274/2026 Z. z. o meste Košice",
    });
    expect(
      statuteDisplayLabel({ country: "svk", eli: "unknown", title: "Predmet" }),
    ).toEqual({
      identity: null,
      subject: "Predmet",
      text: "Predmet",
    });
    expect(
      statuteDisplayLabel({
        country: "svk",
        eli: "unknown",
        documentType: "vyhláška",
        title: "o predmete",
      }).text,
    ).toBe("Vyhláška o predmete");
  });

  test("a missing ELI never strips an identity retained in the source title", () => {
    expect(
      statuteDisplayLabel({
        country: "cze",
        eli: "unknown",
        title: "89/2012 Sb., občanský zákoník",
      }),
    ).toEqual({
      identity: null,
      subject: "89/2012 Sb., občanský zákoník",
      text: "89/2012 Sb., občanský zákoník",
    });
  });

  test("a title containing only the act number does not repeat it", () => {
    expect(
      statuteDisplayLabel({
        country: "cze",
        eli: "https://www.e-sbirka.cz/eli/cz/sm/2012/89",
        documentType: "sdělení",
        title: "89/2012 Sb. m. s.",
      }),
    ).toEqual({
      identity: "Sdělení č. 89/2012 Sb. m. s.",
      subject: null,
      text: "Sdělení č. 89/2012 Sb. m. s.",
    });
  });

  test("other jurisdictions retain their publisher title", () => {
    const title = "Regulation (EU) 2016/679";
    expect(
      statuteDisplayLabel({
        country: "EU",
        eli: "https://data.europa.eu/eli/reg/2016/679/oj",
        documentType: "regulation",
        title,
      }),
    ).toEqual({ identity: null, subject: title, text: title });
  });
});
