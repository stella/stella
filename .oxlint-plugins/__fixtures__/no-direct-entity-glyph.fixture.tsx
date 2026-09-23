/* oxlint-disable import/no-duplicates, no-duplicate-imports, unicorn/prefer-module, import/namespace, typescript/dot-notation, oxc/no-barrel-file -- fixture: each import form stands on its own line */

// Passive regression fixture for
// `no-direct-entity-glyph/no-direct-entity-glyph`.
//
// The folder and task glyphs are restricted to the entity-kind icon
// component in every lucide spelling (`X`, `XIcon`, `LucideX`) and every way
// of reaching them.

// expect-clean: no-direct-entity-glyph/no-direct-entity-glyph
import * as Lucide from "lucide-react";
// oxlint-disable-next-line no-direct-entity-glyph/no-direct-entity-glyph -- x3: one per imported glyph
import { FolderIcon, FolderOpen, ListTodoIcon as Task } from "lucide-react";
// oxlint-disable-next-line no-direct-entity-glyph/no-direct-entity-glyph -- prefixed spelling
import { LucideFolderOpen } from "lucide-react";
// expect-clean: no-direct-entity-glyph/no-direct-entity-glyph
import { FileIcon, MailIcon } from "lucide-react";

// oxlint-disable-next-line no-direct-entity-glyph/no-direct-entity-glyph -- namespace member
const NamespaceGlyph = Lucide.Folder;
// oxlint-disable-next-line no-direct-entity-glyph/no-direct-entity-glyph -- computed member
const ComputedGlyph = Lucide["ListTodo"];
// oxlint-disable-next-line no-direct-entity-glyph/no-direct-entity-glyph -- destructured from the namespace
const { FolderOpenIcon: DestructuredGlyph } = Lucide;
// oxlint-disable-next-line no-direct-entity-glyph/no-direct-entity-glyph -- require member
const RequiredGlyph = require("lucide-react").LucideFolder;
// oxlint-disable-next-line no-direct-entity-glyph/no-direct-entity-glyph -- awaited dynamic import with destructuring
const { ListTodoIcon: LoadedGlyph } = await import("lucide-react");
// oxlint-disable-next-line no-direct-entity-glyph/no-direct-entity-glyph -- member of an awaited dynamic import
const AwaitedGlyph = (await import("lucide-react")).FolderIcon;
// expect-clean: no-direct-entity-glyph/no-direct-entity-glyph
const NeutralGlyph = Lucide.LinkIcon;

// oxlint-disable-next-line no-direct-entity-glyph/no-direct-entity-glyph -- named re-export
export { FolderIcon as ReexportedGlyph } from "lucide-react";
// oxlint-disable-next-line no-direct-entity-glyph/no-direct-entity-glyph, no-direct-matter-glyph/no-direct-matter-glyph -- star re-export carries every glyph
export * from "lucide-react";

export const DirectEntityGlyphFixture = () => (
  <>
    <FolderIcon />
    <FolderOpen />
    <Task />
    <LucideFolderOpen />
    <FileIcon />
    <MailIcon />
    <NamespaceGlyph />
    <ComputedGlyph />
    <DestructuredGlyph />
    <RequiredGlyph />
    <LoadedGlyph />
    <AwaitedGlyph />
    <NeutralGlyph />
    {/* oxlint-disable-next-line no-direct-entity-glyph/no-direct-entity-glyph -- namespace member in JSX */}
    <Lucide.FolderIcon />
    {/* expect-clean: no-direct-entity-glyph/no-direct-entity-glyph */}
    <Lucide.FileIcon />
  </>
);
