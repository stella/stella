import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import * as v from "valibot";

import { assertProperty } from "@stll/property-testing";

import { apiRoutes } from "@/api/api-routes";
import { fileSchema } from "@/api/lib/custom-schema";
import { isValibotSchema } from "@/api/lib/json-schema/valibot-to-json-schema";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const FILE_TYPES = new Set(["file", "blob"]);

/** Child schemas a schema reads its input through. */
const childSchemas = (schema: v.GenericSchema): unknown[] => {
  const children: unknown[] = [];
  if ("entries" in schema && isRecord(schema.entries)) {
    children.push(...Object.values(schema.entries));
  }
  if ("wrapped" in schema) {
    children.push(schema.wrapped);
  }
  if ("item" in schema) {
    children.push(schema.item);
  }
  if ("items" in schema && Array.isArray(schema.items)) {
    children.push(...schema.items);
  }
  if ("rest" in schema) {
    children.push(schema.rest);
  }
  if ("options" in schema && Array.isArray(schema.options)) {
    children.push(...schema.options);
  }
  if ("value" in schema) {
    children.push(schema.value);
  }
  return children.filter(isValibotSchema);
};

const hasMaxSize = (schema: v.GenericSchema): boolean => {
  if (!("pipe" in schema) || !Array.isArray(schema.pipe)) {
    return false;
  }
  return schema.pipe.some(
    (item) =>
      (isRecord(item) && item["type"] === "max_size") ||
      (isValibotSchema(item) && hasMaxSize(item)),
  );
};

/** Every file or blob schema a request schema reads, with whether it is capped. */
const fileSchemasOf = (root: unknown): { readonly capped: boolean }[] => {
  const found: { readonly capped: boolean }[] = [];
  const seen = new Set<unknown>();
  const visit = (schema: unknown): void => {
    if (!isValibotSchema(schema) || seen.has(schema)) {
      return;
    }
    seen.add(schema);
    if (FILE_TYPES.has(schema.type)) {
      found.push({ capped: hasMaxSize(schema) });
    }
    for (const child of childSchemas(schema)) {
      visit(child);
    }
  };
  visit(root);
  return found;
};

describe("file upload limits", () => {
  test("every served request file schema declares a maxSize", () => {
    const offenders: string[] = [];
    let files = 0;
    for (const { method, path, definition } of apiRoutes) {
      const { body, query, params, headers } = definition.config;
      for (const slot of [body, query, params, headers]) {
        for (const file of fileSchemasOf(slot)) {
          files += 1;
          if (!file.capped) {
            offenders.push(`${method} ${path}`);
          }
        }
      }
    }

    expect(offenders).toEqual([]);
    // The census reads the served routes, so it can never pass by finding no
    // upload at all.
    expect(files).toBeGreaterThan(0);
  });

  test("file caps remain visible through nested validation pipes", () => {
    const wrap = (schema: v.GenericSchema, depth: number) => {
      let wrapped = schema;
      for (let index = 0; index < depth; index++) {
        wrapped = v.pipe(
          wrapped,
          v.check(() => true),
        );
      }
      return v.object({ file: wrapped });
    };
    assertProperty(
      "file caps remain visible through nested validation pipes",
      fc.property(
        fc.integer({ min: 0, max: 32 }),
        fc.boolean(),
        (depth, capped) => {
          const schema = capped ? fileSchema({ maxBytes: 1024 }) : v.file();
          expect(fileSchemasOf(wrap(schema, depth))).toEqual([{ capped }]);
        },
      ),
    );
  });

  test("finds an uncapped file nested in a body and accepts a capped one", () => {
    const uncapped = v.object({
      attachments: v.optional(v.array(v.object({ file: v.file() }))),
    });
    const capped = v.object({ file: fileSchema({ maxBytes: 1024 }) });

    expect(fileSchemasOf(uncapped)).toEqual([{ capped: false }]);
    expect(fileSchemasOf(capped)).toEqual([{ capped: true }]);
  });
});
