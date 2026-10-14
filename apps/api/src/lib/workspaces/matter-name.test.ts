import { describe, expect, test } from "bun:test";

import { nextAvailableMatterName } from "@/api/lib/workspaces/matter-name";

describe("nextAvailableMatterName", () => {
  test("keeps a name no matter uses", () => {
    expect(nextAvailableMatterName("Acme", [])).toBe("Acme");
  });

  test("numbers the first copy (2)", () => {
    expect(nextAvailableMatterName("Acme", ["Acme"])).toBe("Acme (2)");
  });

  test("takes the number after the highest existing copy", () => {
    expect(
      nextAvailableMatterName("Acme", ["Acme", "Acme (2)", "Acme (4)"]),
    ).toBe("Acme (5)");
  });

  test("ignores names that only start with the entered name", () => {
    expect(nextAvailableMatterName("Acme", ["Acme Corp", "Acmeco"])).toBe(
      "Acme",
    );
    expect(nextAvailableMatterName("Acme", ["Acme", "Acme Corp (7)"])).toBe(
      "Acme (2)",
    );
  });

  test("passes a copy number beyond the safe integer range exactly", () => {
    expect(
      nextAvailableMatterName("Acme", ["Acme", "Acme (9007199254740992)"]),
    ).toBe("Acme (9007199254740993)");
  });

  test("keeps the name when only numbered copies exist", () => {
    expect(nextAvailableMatterName("Acme", ["Acme (2)"])).toBe("Acme");
  });

  test("matches case-insensitively but keeps accents distinct", () => {
    expect(nextAvailableMatterName("acme", ["ACME"])).toBe("acme (2)");
    expect(nextAvailableMatterName("Novák", ["Novak"])).toBe("Novák");
    expect(nextAvailableMatterName("Novák", ["NOVÁK (3)", "novák"])).toBe(
      "Novák (4)",
    );
  });
});
