import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { discoverTemplate } from "./discover-template";

// ── Helpers ──────────────────────────────────────────────

const makeDocx = async (documentXml: string): Promise<Buffer> => {
  const zip = new JSZip();
  zip.file("word/document.xml", documentXml);
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
</Types>`,
  );
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  return Buffer.from(buf);
};

const WRAP = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body}</w:body></w:document>`;

const P = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

// ── Tests ────────────────────────────────────────────────

describe("discoverTemplate", () => {
  test("plain placeholders inferred as string fields", async () => {
    const xml = WRAP([P("Name: {{name}}"), P("City: {{city}}")].join(""));
    const buf = await makeDocx(xml);
    const result = await discoverTemplate(buf);

    expect(result.placeholders).toEqual([
      { name: "city", count: 1 },
      { name: "name", count: 1 },
    ]);

    const nameField = result.fields.find((f) => f.path === "name");
    expect(nameField).toBeDefined();
    expect(nameField?.kind).toBe("string");

    expect(result.structureErrors).toEqual([]);
  });

  test("conditional infers boolean field", async () => {
    const xml = WRAP(
      [P("{{#if has_guarantor}}"), P("Guarantor clause"), P("{{/if}}")].join(
        "",
      ),
    );
    const buf = await makeDocx(xml);
    const result = await discoverTemplate(buf);

    const field = result.fields.find((f) => f.path === "has_guarantor");
    expect(field).toBeDefined();
    expect(field?.kind).toBe("boolean");
  });

  test("conditional with comparison infers string field", async () => {
    const xml = WRAP(
      [P('{{#if jurisdiction == "CZ"}}'), P("Czech clause"), P("{{/if}}")].join(
        "",
      ),
    );
    const buf = await makeDocx(xml);
    const result = await discoverTemplate(buf);

    const field = result.fields.find((f) => f.path === "jurisdiction");
    expect(field).toBeDefined();
    expect(field?.kind).toBe("string");
  });

  test("loop infers array field with item fields", async () => {
    const xml = WRAP(
      [
        P("{{#each sellers}}"),
        P("{{sellers.name}}, {{sellers.address}}"),
        P("{{/each}}"),
      ].join(""),
    );
    const buf = await makeDocx(xml);
    const result = await discoverTemplate(buf);

    const field = result.fields.find((f) => f.path === "sellers");
    expect(field).toBeDefined();
    expect(field?.kind).toBe("array");
    expect(field?.itemFields).toBeDefined();

    const itemPaths = field?.itemFields?.map((f) => f.path);
    expect(itemPaths).toContain("name");
    expect(itemPaths).toContain("address");
  });

  test("nested object path infers object field", async () => {
    const xml = WRAP(
      [
        P("Company: {{company.name}}"),
        P("ID: {{company.registration_number}}"),
      ].join(""),
    );
    const buf = await makeDocx(xml);
    const result = await discoverTemplate(buf);

    const field = result.fields.find((f) => f.path === "company");
    expect(field).toBeDefined();
    expect(field?.kind).toBe("object");

    // Dotted placeholders should appear in placeholders list
    const names = result.placeholders.map((p) => p.name);
    expect(names).toContain("company.name");
    expect(names).toContain("company.registration_number");
  });

  test("mixed template with conditionals, loops, and placeholders", async () => {
    const xml = WRAP(
      [
        P("Contract: {{contract_date}}"),
        P("{{#if has_guarantor}}"),
        P("Guarantor: {{guarantor_name}}"),
        P("{{/if}}"),
        P("{{#each sellers}}"),
        P("Seller: {{sellers.name}}"),
        P("{{/each}}"),
      ].join(""),
    );
    const buf = await makeDocx(xml);
    const result = await discoverTemplate(buf);

    // Placeholders
    const placeholderNames = result.placeholders.map((p) => p.name);
    expect(placeholderNames).toContain("contract_date");
    expect(placeholderNames).toContain("guarantor_name");
    expect(placeholderNames).toContain("sellers.name");

    // Fields
    const fieldMap = new Map(result.fields.map((f) => [f.path, f]));
    expect(fieldMap.get("contract_date")?.kind).toBe("string");
    expect(fieldMap.get("has_guarantor")?.kind).toBe("boolean");
    expect(fieldMap.get("guarantor_name")?.kind).toBe("string");
    expect(fieldMap.get("sellers")?.kind).toBe("array");
  });

  test("structure errors for unclosed blocks", async () => {
    const xml = WRAP(
      [
        P("{{#if x}}"),
        P("Content"),
        // Missing {{/if}}
      ].join(""),
    );
    const buf = await makeDocx(xml);
    const result = await discoverTemplate(buf);

    expect(result.structureErrors.length).toBeGreaterThan(0);
    expect(result.structureErrors[0].message).toContain("Unclosed");
  });

  test("empty template returns empty results", async () => {
    const xml = WRAP(P("Just text, no templates."));
    const buf = await makeDocx(xml);
    const result = await discoverTemplate(buf);

    expect(result.placeholders).toEqual([]);
    expect(result.fields).toEqual([]);
    expect(result.structureErrors).toEqual([]);
  });

  test("multiple occurrences counted correctly", async () => {
    const xml = WRAP(
      [P("{{name}} and {{name}} again"), P("Also {{name}}")].join(""),
    );
    const buf = await makeDocx(xml);
    const result = await discoverTemplate(buf);

    const nameP = result.placeholders.find((p) => p.name === "name");
    expect(nameP?.count).toBe(3);
  });

  // ── visibleWhen inference ──────────────────────────────

  test("field inside #if gets visibleWhen", async () => {
    const xml = WRAP(
      [P("{{#if isUK}}"), P("Number: {{uk_number}}"), P("{{/if}}")].join(""),
    );
    const buf = await makeDocx(xml);
    const result = await discoverTemplate(buf);

    const ukField = result.fields.find((f) => f.path === "uk_number");
    expect(ukField).toBeDefined();
    expect(ukField?.visibleWhen).toBe("isUK");
  });

  test("field outside #if has no visibleWhen", async () => {
    const xml = WRAP(
      [P("{{name}}"), P("{{#if isUK}}"), P("{{uk_number}}"), P("{{/if}}")].join(
        "",
      ),
    );
    const buf = await makeDocx(xml);
    const result = await discoverTemplate(buf);

    const nameField = result.fields.find((f) => f.path === "name");
    expect(nameField?.visibleWhen).toBeUndefined();
  });

  test("field in both inside and outside has no visibleWhen", async () => {
    const xml = WRAP(
      [
        P("{{name}}"),
        P("{{#if isUK}}"),
        P("{{name}} again"),
        P("{{/if}}"),
      ].join(""),
    );
    const buf = await makeDocx(xml);
    const result = await discoverTemplate(buf);

    const nameField = result.fields.find((f) => f.path === "name");
    expect(nameField?.visibleWhen).toBeUndefined();
  });

  test("field in #else gets negated visibleWhen", async () => {
    const xml = WRAP(
      [
        P("{{#if isUK}}"),
        P("{{uk_number}}"),
        P("{{#else}}"),
        P("{{other_number}}"),
        P("{{/if}}"),
      ].join(""),
    );
    const buf = await makeDocx(xml);
    const result = await discoverTemplate(buf);

    const otherField = result.fields.find((f) => f.path === "other_number");
    expect(otherField?.visibleWhen).toBe("!isUK");
  });

  test("field in #elseif gets compound visibleWhen", async () => {
    const xml = WRAP(
      [
        P("{{#if isUK}}"),
        P("{{uk_field}}"),
        P("{{#elseif isDE}}"),
        P("{{de_field}}"),
        P("{{/if}}"),
      ].join(""),
    );
    const buf = await makeDocx(xml);
    const result = await discoverTemplate(buf);

    const deField = result.fields.find((f) => f.path === "de_field");
    expect(deField?.visibleWhen).toBe("!isUK and isDE");
  });

  test("nested #if combines conditions with and", async () => {
    const xml = WRAP(
      [
        P("{{#if isUK}}"),
        P("{{#if hasLicense}}"),
        P("{{license_number}}"),
        P("{{/if}}"),
        P("{{/if}}"),
      ].join(""),
    );
    const buf = await makeDocx(xml);
    const result = await discoverTemplate(buf);

    const field = result.fields.find((f) => f.path === "license_number");
    expect(field?.visibleWhen).toBe("isUK and hasLicense");
  });

  test("condition driver field has no visibleWhen", async () => {
    const xml = WRAP(
      [P("{{#if isUK}}"), P("{{uk_number}}"), P("{{/if}}")].join(""),
    );
    const buf = await makeDocx(xml);
    const result = await discoverTemplate(buf);

    // isUK is a boolean used in conditions, not a
    // placeholder — it should have no visibleWhen
    const isUKField = result.fields.find((f) => f.path === "isUK");
    expect(isUKField?.visibleWhen).toBeUndefined();
  });

  test("else after elseif gets full negation", async () => {
    const xml = WRAP(
      [
        P("{{#if isUK}}"),
        P("{{uk_field}}"),
        P("{{#elseif isDE}}"),
        P("{{de_field}}"),
        P("{{#else}}"),
        P("{{other_field}}"),
        P("{{/if}}"),
      ].join(""),
    );
    const buf = await makeDocx(xml);
    const result = await discoverTemplate(buf);

    const otherField = result.fields.find((f) => f.path === "other_field");
    expect(otherField?.visibleWhen).toBe("!isUK and !isDE");
  });
});
