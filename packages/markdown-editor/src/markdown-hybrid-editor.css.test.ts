import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The engine emits its diff-mode classes but ships no stylesheet for them, so
// an unstyled class renders a change as plain text. Every diff class it emits
// must either have a rule in our stylesheet or be listed here with the reason
// it needs none.
const UNSTYLED_BY_DESIGN: ReadonlyMap<string, string> = new Map([
  ["md-diff-hunk", "container of the standalone diff's two sides"],
  ["md-diff-decoration", "container of a removed or original block"],
  ["md-diff-modified", "a changed live block; its gutter marker shows it"],
]);

const engineSource = readFileSync(
  fileURLToPath(import.meta.resolve("@vscode/markdown-editor")),
  "utf-8",
);
const stylesheet = readFileSync(
  new URL("markdown-hybrid-editor.css", import.meta.url),
  "utf-8",
);

const emittedDiffClasses = [
  ...new Set(engineSource.match(/md-diff-[a-z-]*[a-z]/gu)),
].toSorted();

describe("markdown hybrid editor diff styles", () => {
  test("the engine still emits diff classes", () => {
    expect(emittedDiffClasses).toContain("md-diff-del-rect");
    expect(emittedDiffClasses).toContain("md-diff-ins-rect");
  });

  test("every emitted diff class is styled or unstyled by design", () => {
    const unhandled = emittedDiffClasses.filter(
      (className) =>
        !UNSTYLED_BY_DESIGN.has(className) &&
        !new RegExp(`\\.${className}(?![a-z-])`, "u").test(stylesheet),
    );
    expect(unhandled).toEqual([]);
  });

  test("no class is both styled and listed as unstyled", () => {
    const listedButStyled = [...UNSTYLED_BY_DESIGN.keys()].filter((className) =>
      new RegExp(`\\.${className}(?![a-z-])`, "u").test(stylesheet),
    );
    expect(listedButStyled).toEqual([]);
  });
});
