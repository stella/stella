import { describe, expect, it } from "bun:test";

import { detectRegexPii } from "./regex-patterns";

const entitiesOf = (text: string) => detectRegexPii(text);

const labelsIn = (text: string) => entitiesOf(text).map((e) => e.label);

const textsIn = (text: string) => entitiesOf(text).map((e) => e.text);

describe("detectRegexPii()", () => {
  describe("iBAN", () => {
    it("detects standard Czech IBAN", () => {
      const r = entitiesOf("Účet: CZ65 0100 0000 0012 3456 7890");
      expect(r).toHaveLength(1);
      expect(r[0].label).toBe("iban");
      expect(r[0].score).toBe(1);
    });

    it("detects German IBAN without spaces", () => {
      const r = entitiesOf("DE89370400440532013000");
      expect(r.some((e) => e.label === "iban")).toBeTruthy();
    });
  });

  describe("email address", () => {
    it("detects plain email", () => {
      expect(textsIn("write to jan.novak@firma.cz")).toContain(
        "jan.novak@firma.cz",
      );
    });

    it("detects email with plus addressing", () => {
      expect(textsIn("use test+tag@example.com please")).toContain(
        "test+tag@example.com",
      );
    });
  });

  describe("phone number", () => {
    it("detects Czech mobile", () => {
      const r = entitiesOf("tel. +420 777 123 456");
      expect(r.some((e) => e.label === "phone number")).toBeTruthy();
    });

    it("detects German landline", () => {
      const r = entitiesOf("Telefon: +49 89 1234567");
      expect(r.some((e) => e.label === "phone number")).toBeTruthy();
    });

    it("ignores short numeric sequences", () => {
      const r = entitiesOf("§ 12");
      expect(r.filter((e) => e.label === "phone number")).toHaveLength(0);
    });
  });

  describe("credit card", () => {
    it("detects Visa pattern", () => {
      const r = entitiesOf("Card: 4111 1111 1111 1111");
      expect(r.some((e) => e.label === "credit card number")).toBeTruthy();
    });
  });

  describe("czech birth number", () => {
    it("detects rodné číslo format", () => {
      const r = entitiesOf("r.č.: 780315/1234");
      expect(r.some((e) => e.label === "czech birth number")).toBeTruthy();
    });
  });

  describe("dates", () => {
    it("detects DD.MM.YYYY", () => {
      expect(labelsIn("dne 15.03.2025")).toContain("date");
    });

    it("detects ISO format", () => {
      expect(labelsIn("datum: 2025-03-15")).toContain("date");
    });

    it("detects Czech spaced date", () => {
      const r = entitiesOf("dne 1. 3. 2025");
      expect(r.some((e) => e.label === "date")).toBeTruthy();
      expect(r[0].text).toBe("1. 3. 2025");
    });

    it("detects Czech written-out month", () => {
      const r = entitiesOf("dne 1. března 2025");
      expect(r.some((e) => e.label === "date")).toBeTruthy();
    });

    it("detects German written-out month", () => {
      const r = entitiesOf("am 15. Januar 2025");
      expect(r.some((e) => e.label === "date")).toBeTruthy();
    });
  });

  describe("iPv4", () => {
    it("detects valid IPv4", () => {
      const r = entitiesOf("server 192.168.1.1 is down");
      expect(r[0].label).toBe("ip address");
    });
  });

  describe("titled person names", () => {
    it("detects Ing. + name", () => {
      const r = entitiesOf("podepsal Ing. Jan Novák zde");
      expect(r.some((e) => e.label === "person")).toBeTruthy();
      expect(r.find((e) => e.label === "person")?.text).toBe("Ing. Jan Novák");
    });

    it("detects JUDr. with post-nominal", () => {
      const r = entitiesOf("zastoupena JUDr. Marie Dvořáková, Ph.D.");
      const person = r.find((e) => e.label === "person");
      expect(person).toBeDefined();
      expect(person?.text).toContain("JUDr.");
      expect(person?.text).toContain("Ph.D.");
    });

    it("detects stacked titles", () => {
      const r = entitiesOf("přednáší prof. MUDr. Karel Horák");
      const person = r.find((e) => e.label === "person");
      expect(person?.text).toBe("prof. MUDr. Karel Horák");
    });

    it("detects German Dr. med.", () => {
      const r = entitiesOf("Arzt: Dr. med. Heinrich Müller");
      const person = r.find((e) => e.label === "person");
      expect(person).toBeDefined();
      expect(person?.text).toContain("Heinrich Müller");
    });

    it("detects PaedDr. with Czech diacritics", () => {
      const r = entitiesOf("ředitel PaedDr. František Šťastný");
      expect(r.find((e) => e.label === "person")?.text).toBe(
        "PaedDr. František Šťastný",
      );
    });

    it("scores titled persons at 0.95", () => {
      const r = entitiesOf("Mgr. Pavel Černý");
      expect(r[0].score).toBe(0.95);
    });

    it("does not match title alone without name", () => {
      const r = entitiesOf("viz Ing. na stránce 5");
      expect(r.filter((e) => e.label === "person")).toHaveLength(0);
    });
  });

  describe("offset correctness", () => {
    it("reports correct start/end positions", () => {
      const text = "kontakt: jan@example.com a dále";
      const r = entitiesOf(text);
      const email = r.find((e) => e.label === "email address");
      expect(email).toBeDefined();
      expect(text.slice(email?.start, email?.end)).toBe("jan@example.com");
    });
  });

  describe("multiple entities in one text", () => {
    it("finds all PII types in a block", () => {
      const text = [
        "Ing. Jan Novák, r.č.: 780315/1234,",
        "email: jan@firma.cz, tel. +420 777 111 222,",
        "IBAN: CZ65 0100 0000 0012 3456 7890",
      ].join("\n");
      const labels = labelsIn(text);
      expect(labels).toContain("person");
      expect(labels).toContain("czech birth number");
      expect(labels).toContain("email address");
      expect(labels).toContain("iban");
    });
  });
});
