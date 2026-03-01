import { describe, expect, test } from "bun:test";
import * as slimdom from "slimdom";

import { collectExistingIds, createIdGenerator, W_NS } from "./ooxml";

const WRAP = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<w:document xmlns:w="${W_NS}">` +
  `<w:body>${body}</w:body></w:document>`;

describe("collectExistingIds", () => {
  test("finds w:id attributes in document", () => {
    const xml = WRAP(
      `<w:p><w:ins w:id="1"><w:r><w:t>hi</w:t></w:r></w:ins></w:p>` +
        `<w:p><w:del w:id="5"><w:r><w:t>bye</w:t></w:r></w:del></w:p>`,
    );
    const doc = slimdom.parseXmlDocument(xml);
    const ids = collectExistingIds(doc);

    expect(ids.has(1)).toBe(true);
    expect(ids.has(5)).toBe(true);
    expect(ids.size).toBe(2);
  });

  test("returns empty set for document with no IDs", () => {
    const xml = WRAP("<w:p><w:r><w:t>plain text</w:t></w:r></w:p>");
    const doc = slimdom.parseXmlDocument(xml);
    const ids = collectExistingIds(doc);

    expect(ids.size).toBe(0);
  });

  test("ignores non-numeric ID values", () => {
    const xml = WRAP(`<w:p w:id="abc"><w:r w:id="42"><w:t>x</w:t></w:r></w:p>`);
    const doc = slimdom.parseXmlDocument(xml);
    const ids = collectExistingIds(doc);

    expect(ids.has(42)).toBe(true);
    expect(ids.size).toBe(1);
  });

  test("handles large ID values", () => {
    const xml = WRAP(
      `<w:p><w:ins w:id="999999"><w:r><w:t>x</w:t></w:r></w:ins></w:p>`,
    );
    const doc = slimdom.parseXmlDocument(xml);
    const ids = collectExistingIds(doc);

    expect(ids.has(999_999)).toBe(true);
  });
});

describe("createIdGenerator", () => {
  test("starts above max existing ID", () => {
    const ids = new Set([1, 5, 10]);
    const gen = createIdGenerator(ids);

    expect(gen()).toBe(11);
    expect(gen()).toBe(12);
    expect(gen()).toBe(13);
  });

  test("starts at 1 with empty set", () => {
    const gen = createIdGenerator(new Set());

    expect(gen()).toBe(1);
    expect(gen()).toBe(2);
  });

  test("produces monotonically increasing values", () => {
    const gen = createIdGenerator(new Set([100]));
    const values = Array.from({ length: 5 }, () => gen());

    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBe(values[i - 1] + 1);
    }
  });

  test("handles single existing ID of 0", () => {
    const gen = createIdGenerator(new Set([0]));

    expect(gen()).toBe(1);
  });
});
