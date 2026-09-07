import { describe, expect, test } from "bun:test";

import { scanInvalidMarkers, scanMarkers } from "@stll/template-conditions";

import { migrateMarkerText } from "./codemod-jinja-dialect";

describe("migrateMarkerText", () => {
  test("rewrites the condition family", () => {
    expect(
      migrateMarkerText(
        "{{#if is_company}}A{{#elseif is_person}}B{{#else}}C{{/if}}",
      ),
    ).toBe("{% if is_company %}A{% elif is_person %}B{% else %}C{% endif %}");
  });

  test("rewrites the loop family and aliases its body", () => {
    expect(
      migrateMarkerText(
        "{{#each deliverables}}{{deliverables.item}} — {{deliverables.fee}}{{/each}}",
      ),
    ).toBe(
      "{% for deliverable in deliverables %}{{ deliverable.item }} — {{ deliverable.fee }}{% endfor %}",
    );
  });

  test("aliases item paths inside a loop's conditions", () => {
    expect(
      migrateMarkerText(
        "{{#each parties}}{{#if parties.is_guarantor}}G{{/if}}{{/each}}",
      ),
    ).toBe(
      "{% for party in parties %}{% if party.is_guarantor %}G{% endif %}{% endfor %}",
    );
  });

  test("keeps a nested loop's own alias", () => {
    expect(
      migrateMarkerText(
        "{{#each contracts}}{{#each contracts.fields}}{{contracts.fields.name}}{{/each}}{{/each}}",
      ),
    ).toBe(
      "{% for contract in contracts %}{% for field in contract.fields %}{{ field.name }}{% endfor %}{% endfor %}",
    );
  });

  test("rewrites the iteration tokens and the @ functions", () => {
    expect(
      migrateMarkerText(
        "{{@index}}/{{@count}} {{@num:scope}} {{@ref:scope}} {{@clause:NDA}} {{@clause:NDA:v3}}",
      ),
    ).toBe(
      '{{ loop.index }}/{{ loop.length }} {{ num("scope") }} {{ ref("scope") }} {{ clause("NDA") }} {{ clause("NDA", "v3") }}',
    );
  });

  test("translates the condition operators that changed", () => {
    expect(migrateMarkerText("{{#if !signed}}x{{/if}}")).toBe(
      "{% if not signed %}x{% endif %}",
    );
    expect(
      migrateMarkerText('{{#if parties contains "guarantor"}}x{{/if}}'),
    ).toBe('{% if "guarantor" in parties %}x{% endif %}');
  });

  test("leaves a marker that is already current alone", () => {
    const current = '{% if a %}{{ b.c }}{{ clause("X") }}{% endif %}';
    expect(migrateMarkerText(current)).toBe(current);
  });

  test("every rewritten document reads back as valid markers", () => {
    const migrated = migrateMarkerText(
      "{{#each sellers}}{{sellers.name}} {{@index}}{{/each}} {{@num:k}} {{#if !x}}y{{/if}}",
    );
    expect(scanInvalidMarkers(migrated)).toEqual([]);
    expect(scanMarkers(migrated).map(({ meta }) => meta.kind)).toEqual([
      "for",
      "placeholder",
      "loop",
      "endfor",
      "num",
      "if",
      "endif",
    ]);
  });
});
