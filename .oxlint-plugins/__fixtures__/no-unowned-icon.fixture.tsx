/* oxlint-disable import/no-duplicates, no-duplicate-imports -- fixture: each import form stands on its own line */

// Passive regression fixture for `no-unowned-icon/no-unowned-icon`.
//
// An icon-module entry with an `ownedBy:` line in packages/ui/src/icons.ts
// (the copy glyph, owned by CopyButton) is importable only in its owner.

// expect-clean: no-unowned-icon/no-unowned-icon
import * as icons from "@stll/ui/icons";
// oxlint-disable-next-line no-unowned-icon/no-unowned-icon -- the copy glyph outside CopyButton
import { CopyToClipboardIcon } from "@stll/ui/icons";
// expect-clean: no-unowned-icon/no-unowned-icon
import { CopyFromMenuIcon, DuplicateIcon } from "@stll/ui/icons";

// oxlint-disable-next-line no-unowned-icon/no-unowned-icon -- namespace member
const NamespaceGlyph = icons.CopyToClipboardIcon;
// expect-clean: no-unowned-icon/no-unowned-icon
const NeutralGlyph = icons.FileIcon;

export const UnownedIconFixture = () => (
  <>
    <CopyToClipboardIcon />
    <CopyFromMenuIcon />
    <DuplicateIcon />
    <NamespaceGlyph />
    <NeutralGlyph />
  </>
);
