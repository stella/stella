import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  FixtureSection,
  visualRegistry,
  visualSearchSchema,
} from "./-visual-registry";

describe("registered visual fixtures", () => {
  for (const [name, entry] of Object.entries(visualRegistry)) {
    test(`${name} is selectable and renders its fixture label`, () => {
      const { visual } = v.parse(visualSearchSchema, { visual: name });
      expect(visual === name).toBe(true);
      if (visual === undefined) {
        throw new TypeError("A registered fixture must have a visual name");
      }

      const html = renderToStaticMarkup(
        <FixtureSection visual={visual}>
          <div data-fixture-content="true" />
        </FixtureSection>,
      );
      expect(html).toContain(`data-playground-section="fixture:${name}"`);
      expect(html).toContain(`<header`);
      expect(html).toContain(`Fixture: ${entry.label}</header>`);
      expect(html).toContain('data-fixture-content="true"');
    });
  }

  test("rejects unknown names and inherited object keys", () => {
    for (const visual of ["unknown", "toString", "__proto__", 1, null]) {
      expect(v.safeParse(visualSearchSchema, { visual }).success).toBe(false);
    }
    expect(v.parse(visualSearchSchema, {})).toEqual({});
  });
});
