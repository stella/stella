import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  DESIGN_PATH,
  designMismatches,
  designNameRows,
  readCommittedUiApiSnapshot,
  readUiApiSnapshot,
  snapshotChanges,
  UI_API_SNAPSHOT_PATH,
  UI_API_SNAPSHOT_WRITE,
} from "../../scripts/ui-api-snapshot.ts";

const ROOT = path.resolve(import.meta.dir, "../..");

// A new export, variant, size or tone of @stll/ui is a design decision: one
// name per concept, chosen against the names that already exist. Both the
// snapshot and DESIGN.md are edited on purpose, never as a side effect.
const HOW_TO_UPDATE =
  "The public API of @stll/ui changed. Check DESIGN.md's \"One Name per " +
  'Concept" section first: if an existing name already says it, use that ' +
  "instead. If the change is deliberate, update the names list in that " +
  `section (one line per prop) and run \`${UI_API_SNAPSHOT_WRITE}\`, then ` +
  `commit DESIGN.md and ${UI_API_SNAPSHOT_PATH} with the change.`;

const design = readFileSync(path.join(ROOT, DESIGN_PATH), "utf-8");

describe("@stll/ui API snapshot", () => {
  test("matches the exports and closed prop sets in packages/ui", () => {
    const changes = snapshotChanges(
      readCommittedUiApiSnapshot(),
      readUiApiSnapshot(),
    );
    expect(changes, `${changes.join("\n")}\n\n${HOW_TO_UPDATE}`).toEqual([]);
  });

  test("DESIGN.md names every prop and name in the snapshot", () => {
    const errors = designMismatches(design, readCommittedUiApiSnapshot());
    expect(errors, `${errors.join("\n")}\n\n${HOW_TO_UPDATE}`).toEqual([]);
  });

  test("the snapshot reads the Button API", () => {
    const { props } = readCommittedUiApiSnapshot();
    expect(props["Button.variant"]).toContain("plain");
    expect(props["Button.size"]).toContain("inline");
    expect(props["Button.shape"]).toEqual(["box", "round"]);
  });
});

describe("designMismatches", () => {
  const markdown = [
    "### One Name per Concept",
    "",
    "| Concept | API |",
    "| ------- | --- |",
    '| Quiet line | `AccordionTrigger variant="muted"` |',
    "",
    "- `DialogFooter`, `SheetFooter` `variant`: `bare`, `default`",
    "- `Button` `size`: `default`, `sm`",
    "",
    "### Menu Rows & Sections",
    "",
    "- `Ignored` `size`: `xl`",
  ].join("\n");

  test("reads the names list of the section only", () => {
    expect(designNameRows(markdown)).toEqual([
      {
        components: ["DialogFooter", "SheetFooter"],
        prop: "variant",
        names: ["bare", "default"],
      },
      { components: ["Button"], prop: "size", names: ["default", "sm"] },
    ]);
  });

  test("a new name, a missing prop and a stale line all fail", () => {
    expect(
      designMismatches(markdown, {
        exports: {},
        props: {
          "Button.size": ["default", "sm", "xxl"],
          "DialogFooter.variant": ["bare", "default"],
          "Label.variant": ["choice", "default"],
        },
      }),
    ).toEqual([
      "Button.size accepts default, sm, xxl; DESIGN.md lists default, sm",
      "Label.variant has no line in DESIGN.md. Add: - `Label` `variant`: `choice`, `default`",
      "DESIGN.md lists SheetFooter.variant, which no component accepts",
    ]);
  });
});
