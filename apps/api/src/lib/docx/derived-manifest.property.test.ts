/**
 * The manifest is a cache of the document, and a cache that can disagree with
 * what it caches is the bug this refactor exists to remove.
 *
 * `writeStoredTemplate` derives the manifest from the bytes it publishes, so no
 * write path can store a disagreeing pair: that half is structural. What is
 * left to prove is that deriving is a FIXED POINT: writing a configuration
 * into a document and reading it back yields that configuration, and writing
 * the read-back again changes nothing. Without it, every save would drift the
 * template a little further from what its author asked for.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import JSZip from "jszip";

import { propertyConfig } from "@stll/property-testing";
import {
  arrayFiltersFromFieldConfig,
  filtersFromFieldConfig,
} from "@stll/template-conditions";

import { deriveManifestFromDocx } from "./derived-manifest";
import { isFieldMeta, type FieldMeta } from "./types";
import { writeFieldFilters } from "./write-field-filters";

const WRAP = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body}</w:body></w:document>`;

const P = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

const makeDocx = async (paragraphs: readonly string[]): Promise<Buffer> => {
  const zip = new JSZip();
  zip.file("word/document.xml", WRAP(paragraphs.map(P).join("")));
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
};

/** The document every generated configuration is written into: two plain value
 *  markers and a repeat whose body writes one item marker through its alias. */
const PATHS = ["deposit", "signed_on"] as const;
const ARRAY_PATH = "attorneys";
const ITEM_PATH = "attorneys.name";

const documentParagraphs = [
  ...PATHS.map((path) => `Value: {{ ${path} }}`),
  `{% for attorney in ${ARRAY_PATH} %}`,
  "{{ attorney.name }}",
  "{% endfor %}",
];

const text = fc.stringMatching(/^[- ,.'"a-zA-Zá-ž0-9]{1,16}$/u);

/** The described properties, under the path they belong to. */
const atPath =
  (path: string) =>
  (described: object): object => ({ path, ...described });

/** A generated tuple of fields as the list the writer takes. */
const asFieldList = (fields: readonly FieldMeta[]): FieldMeta[] => [...fields];

/** One configuration a value marker can hold, generated per path. */
const valueField = (path: string): fc.Arbitrary<FieldMeta> =>
  fc
    .record(
      {
        label: text,
        hint: text,
        required: fc.constant(true),
        inputType: fc.constantFrom("text" as const, "number" as const),
        validation: fc
          .integer({ min: 0, max: 20 })
          .map((minLength) => ({ minLength })),
      },
      { requiredKeys: [] },
    )
    .map(atPath(path))
    .filter(isFieldMeta);

/** A repeat carries the filters a repeat can: what to call it and how many
 *  rows it takes. */
const arrayField: fc.Arbitrary<FieldMeta> = fc
  .record(
    {
      label: text,
      validation: fc
        .integer({ min: 0, max: 3 })
        .map((minItems) => ({ minItems })),
    },
    { requiredKeys: [] },
  )
  .map(atPath(ARRAY_PATH))
  .filter(isFieldMeta);

const configuration = fc
  .tuple(
    valueField(PATHS[0]),
    valueField(PATHS[1]),
    valueField(ITEM_PATH),
    arrayField,
  )
  .map(asFieldList);

const rewritesFor = (fields: readonly FieldMeta[]) =>
  fields.map((field) => ({
    path: field.path,
    filters:
      field.path === ARRAY_PATH
        ? arrayFiltersFromFieldConfig(field)
        : filtersFromFieldConfig(field),
  }));

/** The fields whose configuration a marker actually carries. A field that
 *  writes no filter says nothing, and a path the document merely mentions is
 *  not a claim about how it is filled. */
const configured = (fields: readonly FieldMeta[]): FieldMeta[] =>
  rewritesFor(fields).flatMap(({ filters, path }) =>
    filters.length === 0 ? [] : fields.filter((field) => field.path === path),
  );

describe("deriving a manifest from the document that declares it", () => {
  test("a configuration written into the markers reads back as itself", async () => {
    await fc.assert(
      fc.asyncProperty(configuration, async (fields) => {
        const document = await makeDocx(documentParagraphs);
        const { buffer, written } = await writeFieldFilters(
          document,
          rewritesFor(fields),
        );
        // Every generated path is one the document carries, so a path that did
        // not land is a writer bug rather than an unconfigurable field.
        expect([...written].toSorted()).toEqual(
          fields.map(({ path }) => path).toSorted(),
        );

        const manifest = await deriveManifestFromDocx(buffer);
        for (const field of configured(fields)) {
          expect(
            manifest.fields.find(({ path }) => path === field.path),
          ).toMatchObject(field);
        }
      }),
      propertyConfig(),
    );
  });

  test("writing the read-back configuration changes nothing", async () => {
    await fc.assert(
      fc.asyncProperty(configuration, async (fields) => {
        const document = await makeDocx(documentParagraphs);
        const once = await writeFieldFilters(document, rewritesFor(fields));
        const first = await deriveManifestFromDocx(once.buffer);

        const twice = await writeFieldFilters(
          once.buffer,
          rewritesFor(first.fields),
        );
        expect(await deriveManifestFromDocx(twice.buffer)).toEqual(first);
      }),
      propertyConfig(),
    );
  });

  test("a document with no configured marker still derives a manifest", async () => {
    const manifest = await deriveManifestFromDocx(
      await makeDocx(documentParagraphs),
    );
    expect(manifest.version).toBe(1);
    // An item path nothing configures rides in its repeat's `itemFields`; a
    // manifest entry of its own would say the author decided something there.
    expect(manifest.fields.map(({ path }) => path).toSorted()).toEqual([
      "attorneys",
      "deposit",
      "signed_on",
    ]);
  });
});
