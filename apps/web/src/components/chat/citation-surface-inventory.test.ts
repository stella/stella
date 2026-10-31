import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createCitationSurfaceInventory } from "@stll/scripts/src/citation-surface-inventory";

const SOURCE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CITATION_INVENTORY = createCitationSurfaceInventory(SOURCE_ROOT);
const SOURCE_TRAY = path.join(SOURCE_ROOT, "features/chat/source-chips.tsx");
const TRAY_BODY = '<div className="w-full space-y-2">';

/** Renders `element` inside the source tray and appends `declarations` to its module. */
const trayWith = (element: string, declarations: readonly string[]) => {
  const sourceText = readFileSync(SOURCE_TRAY, "utf-8");
  expect(sourceText).toContain(TRAY_BODY);
  return new Map([
    [
      SOURCE_TRAY,
      `${sourceText.replace(TRAY_BODY, () => `${TRAY_BODY}${element}`)}\n${declarations.join("\n")}\n`,
    ],
  ]);
};
const trayBypasses = (failures: readonly string[]) =>
  failures.filter(
    (failure) =>
      failure.startsWith("Bypassing source-tray anchor") &&
      failure.includes("features/chat/source-chips.tsx:"),
  );

describe("chat citation surface ownership", () => {
  test("all discovered markdown overrides and source sinks use the shared legal resolver", () => {
    const result = CITATION_INVENTORY.inspect();
    expect(result.hostCount).toBeGreaterThan(0);
    expect(result.anchorCount).toBeGreaterThan(0);
    expect(result.sinkCount).toBeGreaterThan(0);
    expect(result.failures).toEqual([]);
  });
  test("a plain anchor override cannot silently bypass citation navigation", () => {
    const anchor = CITATION_INVENTORY.inspect().sharedAnchorOverrides.at(0);
    expect(anchor).toBeDefined();
    if (anchor === undefined) {
      return;
    }
    const mutated = `${anchor.sourceText.slice(0, anchor.start)}(props) => <a {...props} />${anchor.sourceText.slice(anchor.end)}`;
    const result = CITATION_INVENTORY.inspect(
      new Map([[anchor.filePath, mutated]]),
    );
    expect(
      result.failures.some((failure) =>
        failure.startsWith("Bypassing markdown anchor"),
      ),
    ).toBe(true);
  });
  test("a function-declared tray component cannot hide a plain source anchor", () => {
    const result = CITATION_INVENTORY.inspect(
      trayWith("<PlainSourceAnchor />", [
        'function PlainSourceAnchor() { return <a href="https://example.test">source</a>; }',
      ]),
    );
    expect(trayBypasses(result.failures)).toHaveLength(1);
  });
  test("a function-declared tray component is checked through the props its caller passes", () => {
    const component =
      "function SourceAnchor({ href }: { href: string }) { return <a href={href}>source</a>; }";
    const resolved = CITATION_INVENTORY.inspect(
      trayWith("<SourceAnchor href={resolveLegalCitationLinks({}).href} />", [
        'import { resolveLegalCitationLinks } from "@stll/api-contract/legal-citation-links";',
        component,
      ]),
    );
    const plain = CITATION_INVENTORY.inspect(
      trayWith('<SourceAnchor href={"https://example.test"} />', [component]),
    );
    expect(resolved.sinkCount).toBe(plain.sinkCount);
    expect(resolved.failures).toEqual([]);
    expect(trayBypasses(plain.failures)).toHaveLength(1);
  });
});
