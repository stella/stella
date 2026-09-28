import { describe, expect, test } from "bun:test";

import { renameIdentifiers } from "./codemod-icons";

const RENAMES = new Map([["WandSparklesIcon", "AiActionIcon"]]);

const rename = (source: string): string =>
  renameIdentifiers("view.tsx", source, RENAMES);

describe("renameIdentifiers", () => {
  test("renames references and leaves strings, comments and keys alone", () => {
    const input = [
      'import { AiActionIcon } from "@stll/ui/icons";',
      "// WandSparklesIcon in a comment",
      'const icons = { WandSparklesIcon, label: "WandSparklesIcon" };',
      "const keyed = { WandSparklesIcon: 1 };",
      "const member = registry.WandSparklesIcon;",
      "const text = String(WandSparklesIcon.name) + `WandSparklesIcon`;",
      'export const View = () => <WandSparklesIcon data-testid="WandSparklesIcon" />;',
      "export { WandSparklesIcon };",
    ].join("\n");

    expect(rename(input)).toBe(
      [
        'import { AiActionIcon } from "@stll/ui/icons";',
        "// WandSparklesIcon in a comment",
        'const icons = { WandSparklesIcon: AiActionIcon, label: "WandSparklesIcon" };',
        "const keyed = { WandSparklesIcon: 1 };",
        "const member = registry.WandSparklesIcon;",
        "const text = String(AiActionIcon.name) + `WandSparklesIcon`;",
        'export const View = () => <AiActionIcon data-testid="WandSparklesIcon" />;',
        "export { AiActionIcon as WandSparklesIcon };",
      ].join("\n"),
    );
  });

  test("reaches a fixed point: a second pass changes nothing", () => {
    const input = [
      'const icons = { WandSparklesIcon, label: "WandSparklesIcon" };',
      "export const View = () => <WandSparklesIcon />;",
      "export { WandSparklesIcon };",
    ].join("\n");
    const once = rename(input);

    expect(rename(once)).toBe(once);
  });
});
