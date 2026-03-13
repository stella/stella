import { filterFalsePositives } from "./false-positive-filter";
import type { Entity } from "./types";
import { DETECTION_SOURCES } from "./types";

const entity = (text: string, label = "person"): Entity => ({
  start: 0,
  end: text.length,
  label,
  text,
  score: 0.9,
  source: DETECTION_SOURCES.NER,
});

describe("filterFalsePositives()", () => {
  it("keeps legitimate person names", () => {
    const r = filterFalsePositives([entity("Jan Novák")]);
    expect(r).toHaveLength(1);
  });

  it("removes template placeholders with dots", () => {
    const r = filterFalsePositives([entity(".....")]);
    expect(r).toHaveLength(0);
  });

  it("removes template placeholders with underscores", () => {
    const r = filterFalsePositives([entity("_____")]);
    expect(r).toHaveLength(0);
  });

  it("removes bracketed placeholders", () => {
    const r = filterFalsePositives([entity("[name]")]);
    expect(r).toHaveLength(0);
  });

  it("removes section numbers", () => {
    const r = filterFalsePositives([entity("§ 12", "person")]);
    expect(r).toHaveLength(0);
  });

  it("removes dotted clause numbers", () => {
    const r = filterFalsePositives([entity("3.2.1", "person")]);
    expect(r).toHaveLength(0);
  });

  it("removes standalone years", () => {
    const r = filterFalsePositives([entity("2025", "date")]);
    expect(r).toHaveLength(0);
  });

  it("removes generic English roles as person", () => {
    const roles = ["Employee", "Buyer", "Seller", "Tenant"];
    for (const role of roles) {
      const r = filterFalsePositives([entity(role)]);
      expect(r).toHaveLength(0);
    }
  });

  it("removes generic Czech roles as person", () => {
    const roles = ["kupující", "prodávající", "nájemce"];
    for (const role of roles) {
      const r = filterFalsePositives([entity(role)]);
      expect(r).toHaveLength(0);
    }
  });

  it("removes generic German roles as person", () => {
    const roles = ["Käufer", "Verkäufer", "Mieter"];
    for (const role of roles) {
      const r = filterFalsePositives([entity(role)]);
      expect(r).toHaveLength(0);
    }
  });

  it("does not remove roles when label is not person/org", () => {
    const r = filterFalsePositives([entity("Employee", "email address")]);
    expect(r).toHaveLength(1);
  });

  it("handles mixed entities correctly", () => {
    const input = [
      entity("Jan Novák"),
      entity("Employee"),
      entity("_____"),
      entity("jan@example.com", "email address"),
      entity("2025", "date"),
    ];
    const r = filterFalsePositives(input);
    expect(r.map((e) => e.text)).toStrictEqual([
      "Jan Novák",
      "jan@example.com",
    ]);
  });
});
