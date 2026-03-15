import { describe, expect, it } from "bun:test";

import {
  deanonymise,
  DETECTION_SOURCES,
  exportRedactionKey,
  redactText,
} from "@stella/anonymize";
import type { Entity, OperatorConfig, OperatorType } from "@stella/anonymize";

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

const config = (
  operators: Record<string, string>,
  redactString = "[REDACTED]",
): OperatorConfig => ({
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test helper
  operators: operators as OperatorConfig["operators"],
  redactString,
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
      const entities = [
        entity(0, 15, "email address", "Jan@Example.COM"),
        entity(20, 35, "email address", "jan@example.com"),
      ];
      const r = redactText(text, entities);
      expect(r.redactedText).toBe("[EMAIL_ADDRESS_1] and [EMAIL_ADDRESS_1]");
    });

    it("normalizes phone formatting", () => {
      const text = "+420777123456 or +420 777 123 456";
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

  describe("operatorMap", () => {
    it("records operator type per placeholder", () => {
      const text = "Jan Novák";
      const r = redactText(
        text,
        [entity(0, 9, "person", "Jan Novák")],
        config({ person: "replace" }),
      );
      expect(r.operatorMap.get("[PERSON_1]")).toBe("replace");
    });
  });
});

describe("operator dispatch", () => {
  it("replace operator: identical to default behaviour", () => {
    const text = "call Jan Novák today";
    const r = redactText(
      text,
      [entity(5, 14, "person", "Jan Novák")],
      config({ person: "replace" }),
    );
    expect(r.redactedText).toBe("call [PERSON_1] today");
    expect(r.redactionMap.get("[PERSON_1]")).toBe("Jan Novák");
  });

  it("redact operator: custom string, empty map", () => {
    const text = "call Jan Novák today";
    const r = redactText(
      text,
      [entity(5, 14, "person", "Jan Novák")],
      config({ person: "redact" }),
    );
    expect(r.redactedText).toBe("call [REDACTED] today");
    expect(r.redactionMap.size).toBe(0);
  });

  it("redact operator: uses custom redact string", () => {
    const text = "call Jan Novák today";
    const r = redactText(
      text,
      [entity(5, 14, "person", "Jan Novák")],
      config({ person: "redact" }, "█████"),
    );
    expect(r.redactedText).toBe("call █████ today");
    expect(r.redactionMap.size).toBe(0);
  });

  it("mixed operators: each label uses its operator", () => {
    const text = "Jan Novák has IBAN CZ6508000000192000145399";
    const entities = [
      entity(0, 9, "person", "Jan Novák"),
      entity(19, 43, "iban", "CZ6508000000192000145399"),
    ];
    const r = redactText(
      text,
      entities,
      config({ person: "replace", iban: "redact" }),
    );
    expect(r.redactedText).toBe("[PERSON_1] has IBAN [REDACTED]");
    // Only person has a map entry (replace is reversible)
    expect(r.redactionMap.size).toBe(1);
    expect(r.redactionMap.has("[PERSON_1]")).toBeTruthy();
  });

  it("defaults to replace when label not in config", () => {
    const text = "call Jan Novák today";
    const r = redactText(
      text,
      [entity(5, 14, "person", "Jan Novák")],
      config({}),
    );
    expect(r.redactedText).toBe("call [PERSON_1] today");
    expect(r.redactionMap.size).toBe(1);
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

  it("returns text unchanged with empty map (irreversible-only)", () => {
    const map = new Map<string, string>();
    const result = deanonymise("[REDACTED] data", map);
    expect(result).toBe("[REDACTED] data");
  });
});

describe("exportRedactionKey()", () => {
  it("serialises replace entries with operator metadata", () => {
    const redactionMap = new Map([["[PERSON_1]", "Jan Novák"]]);
    const operatorMap = new Map<string, OperatorType>([
      ["[PERSON_1]", "replace"],
    ]);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSON.parse returns unknown
    const json = JSON.parse(
      exportRedactionKey(redactionMap, operatorMap),
    ) as Record<string, unknown>;
    expect(json).toStrictEqual({
      entries: {
        "[PERSON_1]": {
          original: "Jan Novák",
          operator: "replace",
        },
      },
    });
  });

  it("returns empty entries for fully-redacted documents", () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSON.parse returns unknown
    const json = JSON.parse(exportRedactionKey(new Map(), new Map())) as Record<
      string,
      unknown
    >;
    expect(json).toStrictEqual({ entries: {} });
  });
});
