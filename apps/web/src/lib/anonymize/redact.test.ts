import { deanonymise, redactText } from "./redact";
import type { Entity } from "./types";
import { DETECTION_SOURCES } from "./types";

const entity = (
  start: number,
  end: number,
  label: string,
  text: string,
): Entity => ({
  start,
  end,
  label,
  text,
  score: 1,
  source: DETECTION_SOURCES.REGEX,
});

describe("redactText()", () => {
  it("returns original text when no entities", () => {
    const r = redactText("hello world", []);
    expect(r.redactedText).toBe("hello world");
    expect(r.entityCount).toBe(0);
  });

  it("replaces entity with numbered placeholder", () => {
    const text = "call Jan Novák today";
    const r = redactText(text, [entity(5, 14, "person", "Jan Novák")]);
    expect(r.redactedText).toBe("call [PERSON_1] today");
    expect(r.entityCount).toBe(1);
  });

  it("uses consistent placeholders for same text", () => {
    const text = "Jan Novák met Jan Novák";
    const entities = [
      entity(0, 9, "person", "Jan Novák"),
      entity(14, 23, "person", "Jan Novák"),
    ];
    const r = redactText(text, entities);
    expect(r.redactedText).toBe("[PERSON_1] met [PERSON_1]");
  });

  it("assigns different numbers to different people", () => {
    const text = "Jan Novák and Marie Nová";
    const entities = [
      entity(0, 9, "person", "Jan Novák"),
      entity(14, 24, "person", "Marie Nová"),
    ];
    const r = redactText(text, entities);
    expect(r.redactedText).toContain("[PERSON_1]");
    expect(r.redactedText).toContain("[PERSON_2]");
  });

  it("handles multi-word labels", () => {
    const text = "email: jan@example.com";
    const r = redactText(text, [
      entity(7, 22, "email address", "jan@example.com"),
    ]);
    expect(r.redactedText).toBe("email: [EMAIL_ADDRESS_1]");
  });

  it("skips overlapping spans (keeps first)", () => {
    const text = "abcdefghij";
    const entities = [
      entity(2, 6, "person", "cdef"),
      entity(4, 8, "person", "efgh"),
    ];
    const r = redactText(text, entities);
    expect(r.entityCount).toBe(1);
  });

  describe("entity normalization", () => {
    it("normalizes whitespace in person names", () => {
      const text = "Jan  Novák and Jan Novák";
      const entities = [
        entity(0, 10, "person", "Jan  Novák"),
        entity(15, 24, "person", "Jan Novák"),
      ];
      const r = redactText(text, entities);
      expect(r.redactedText).toBe("[PERSON_1] and [PERSON_1]");
    });

    it("normalizes email casing", () => {
      const text = "Jan@Example.COM and jan@example.com";
      //            0              15  20             34
      const entities = [
        entity(0, 15, "email address", "Jan@Example.COM"),
        entity(20, 35, "email address", "jan@example.com"),
      ];
      const r = redactText(text, entities);
      expect(r.redactedText).toBe("[EMAIL_ADDRESS_1] and [EMAIL_ADDRESS_1]");
    });

    it("normalizes phone formatting", () => {
      const text = "+420777123456 or +420 777 123 456";
      //            0            13   17               33
      const entities = [
        entity(0, 13, "phone number", "+420777123456"),
        entity(17, 33, "phone number", "+420 777 123 456"),
      ];
      const r = redactText(text, entities);
      expect(r.redactedText).toBe("[PHONE_NUMBER_1] or [PHONE_NUMBER_1]");
    });

    it("normalizes IBAN formatting", () => {
      const text = "CZ6501000000001234567890 vs CZ65 0100 0000 0012 3456 7890";
      const entities = [
        entity(0, 24, "iban", "CZ6501000000001234567890"),
        entity(28, 57, "iban", "CZ65 0100 0000 0012 3456 7890"),
      ];
      const r = redactText(text, entities);
      expect(r.redactedText).toBe("[IBAN_1] vs [IBAN_1]");
    });
  });

  describe("redaction map", () => {
    it("builds reverse map from placeholder to original", () => {
      const text = "Jan Novák";
      const r = redactText(text, [entity(0, 9, "person", "Jan Novák")]);
      expect(r.redactionMap.get("[PERSON_1]")).toBe("Jan Novák");
    });
  });
});

describe("deanonymise()", () => {
  it("reverses redaction using the map", () => {
    const map = new Map([["[PERSON_1]", "Jan Novák"]]);
    const result = deanonymise("smlouva s [PERSON_1]", map);
    expect(result).toBe("smlouva s Jan Novák");
  });

  it("replaces multiple occurrences", () => {
    const map = new Map([["[PERSON_1]", "Jan"]]);
    const result = deanonymise("[PERSON_1] a [PERSON_1]", map);
    expect(result).toBe("Jan a Jan");
  });
});
