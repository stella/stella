import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";

const REPO_ROOT = path.join(import.meta.dir, "../../../..");
const SOURCE_ROOTS = [
  path.join(REPO_ROOT, "apps/web/src"),
  path.join(REPO_ROOT, "packages"),
];

const ALLOWED = {
  "apps/web/src/components/chat/tool-call-code-block.tsx":
    "The code block has a multi-action header whose copy state needs a dedicated follow-up migration.",
  "apps/web/src/components/company-specification.tsx":
    "The registry preview copies transformed content from a compound action row.",
  "apps/web/src/components/copy-field.tsx":
    "The copy affordance is embedded in an input group with field-specific layout.",
  "apps/web/src/components/feedback-dialog.tsx":
    "The receipt copy runs after a dialog workflow rather than from a standalone copy control.",
  "apps/web/src/components/inspector/entity-metadata-panel.tsx":
    "The metadata action is part of a contextual menu.",
  "apps/web/src/components/inspector/external-reference-panel.tsx":
    "The URL copy is part of a confirmation workflow.",
  "apps/web/src/components/legal-reader/citation-copy-options.tsx":
    "The citation formatter is a menu with several copy formats.",
  "apps/web/src/components/legal-reader/web-reader-presentation.tsx":
    "The share control combines URL copying with reader presentation actions.",
  "apps/web/src/components/route-components.tsx":
    "The error reference copy is embedded in the route error boundary.",
  "apps/web/src/components/workspaces/matter-context-menu.tsx":
    "The matter link action lives in a contextual menu.",
  "apps/web/src/routes/_protected.settings/-components/account/connections/client-setup-groups.tsx":
    "Setup values are copied from a generated command group.",
  "apps/web/src/routes/_protected.settings/-components/account/two-factor-card.tsx":
    "Recovery codes are copied as a batch from a security workflow.",
  "apps/web/src/routes/_protected.workspaces/$workspaceId/-components/correspondence-view.tsx":
    "The correspondence address action is coupled to its composer field.",
} as const;

describe("copy feedback ownership", () => {
  test("every copy success toast is an explained baseline", () => {
    const discovered = sourceFiles(SOURCE_ROOTS)
      .filter((file) => {
        const source = readFileSync(file, "utf-8");
        return (
          source.includes("copyToClipboard(") &&
          /stellaToast[\s\S]{0,300}common\.copied|common\.copied[\s\S]{0,300}stellaToast/u.test(
            source,
          )
        );
      })
      .map((file) => repoRelativePath(REPO_ROOT, file))
      .toSorted();

    expect(discovered).toEqual(Object.keys(ALLOWED).toSorted());
  });
});

function sourceFiles(roots: readonly string[]): string[] {
  const files: string[] = [];
  const pending = [...roots];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) {
      continue;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== "dist") {
          pending.push(entryPath);
        }
      } else if ([".ts", ".tsx"].includes(path.extname(entry.name))) {
        files.push(entryPath);
      }
    }
  }
  return files;
}
