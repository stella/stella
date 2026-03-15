import { describe, expect, it } from "bun:test";

import { detectTriggerPhrases } from "./trigger-phrases";

const find = (text: string) => detectTriggerPhrases(text);

const findLabel = (text: string, label: string) =>
  find(text).filter((e) => e.label === label);

describe("detectTriggerPhrases()", () => {
  describe("czech triggers", () => {
    it("extracts address after bytem:", () => {
      const r = findLabel("trvale bytem Lipová 42, Praha 1", "address");
      expect(r).toHaveLength(1);
      expect(r[0]?.text).toBe("Lipová 42");
    });

    it("extracts address after sídlem:", () => {
      const r = findLabel("se sídlem: Václavské nám. 15, Praha", "address");
      expect(r.length).toBeGreaterThanOrEqual(1);
      expect(r[0]?.text).toBe("Václavské nám. 15");
    });

    it("extracts date after nar.:", () => {
      const r = findLabel("nar.: 15.03.1978, trvale", "date");
      expect(r).toHaveLength(1);
      expect(r[0]?.text).toBe("15.03.1978,");
    });

    it("extracts birth number after r.č.:", () => {
      const r = findLabel("r.č.: 780315/1234", "czech birth number");
      expect(r).toHaveLength(1);
      expect(r[0]?.text).toBe("780315/1234");
    });

    it("extracts IČO value", () => {
      const r = findLabel("IČO: 12345678", "registration number");
      expect(r).toHaveLength(1);
      expect(r[0]?.text).toBe("12345678");
    });

    it("extracts DIČ value", () => {
      const r = findLabel("DIČ: CZ12345678", "tax identification number");
      expect(r).toHaveLength(1);
      expect(r[0]?.text).toBe("CZ12345678");
    });

    it("extracts person after zastoupen:", () => {
      const r = findLabel("zastoupen: Jan Novák, jednatel", "person");
      expect(r).toHaveLength(1);
      expect(r[0]?.text).toBe("Jan Novák");
    });

    it("extracts account number after č.ú.:", () => {
      const r = findLabel("č.ú.: 123456789/0100", "bank account number");
      expect(r).toHaveLength(1);
    });
  });

  describe("german triggers", () => {
    it("extracts address after wohnhaft in", () => {
      const r = findLabel("wohnhaft in Mozartstraße 18, München", "address");
      expect(r).toHaveLength(1);
      expect(r[0]?.text).toBe("Mozartstraße 18");
    });

    it("extracts date after geboren am", () => {
      const r = findLabel("geboren am 22.06.1965", "date");
      expect(r).toHaveLength(1);
    });

    it("extracts tax number after Steuernummer:", () => {
      const r = findLabel(
        "Steuernummer: 143/241/12345",
        "tax identification number",
      );
      expect(r).toHaveLength(1);
    });

    it("extracts person after Geschäftsführer:", () => {
      const r = findLabel("Geschäftsführer: Anna Bauer, vertretend", "person");
      expect(r).toHaveLength(1);
      expect(r[0]?.text).toBe("Anna Bauer");
    });

    it("extracts registration after Handelsregister:", () => {
      const r = findLabel(
        "eingetragen im Handelsregister: HRB 123456\nnächster",
        "registration number",
      );
      expect(r.length).toBeGreaterThanOrEqual(1);
      expect(r.some((e) => e.text.includes("HRB 123456"))).toBeTruthy();
    });
  });

  describe("scoring and source", () => {
    it("assigns score 0.95 to all trigger matches", () => {
      const r = find("IČO: 12345678");
      expect(r[0]?.score).toBe(0.95);
    });

    it("sets source to trigger", () => {
      const r = find("IČO: 12345678");
      expect(r[0]?.source).toBe("trigger");
    });
  });

  describe("case insensitivity", () => {
    it("matches triggers regardless of case", () => {
      const lower = find("ičo: 12345678");
      const upper = find("IČO: 12345678");
      expect(lower).toHaveLength(upper.length);
    });
  });

  describe("multiple triggers in one text", () => {
    it("finds all trigger matches", () => {
      const text = [
        "IČO: 12345678, DIČ: CZ12345678,",
        "sídlem: Lipová 42, Praha",
      ].join("\n");
      const labels = find(text).map((e) => e.label);
      expect(labels).toContain("registration number");
      expect(labels).toContain("tax identification number");
      expect(labels).toContain("address");
    });
  });

  describe("no false positives on empty values", () => {
    it("skips trigger with no following content", () => {
      const r = find("IČO:");
      expect(r).toHaveLength(0);
    });
  });
});
