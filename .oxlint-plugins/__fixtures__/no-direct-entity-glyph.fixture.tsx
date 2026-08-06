// Passive regression fixture for
// `no-direct-entity-glyph/no-direct-entity-glyph`.
//
// The rule bans importing the raw folder/task glyphs from lucide-react
// anywhere except the entity-kind icon component (and the global search
// dialog, which keys a component map off a wider union). If the rule
// regresses, the disable directive below goes unused and
// `--report-unused-disable-directives-severity=error` fails CI.

// oxlint-disable-next-line no-direct-entity-glyph/no-direct-entity-glyph
import { FolderIcon, FolderOpenIcon, ListTodoIcon } from "lucide-react";

export function DirectEntityGlyphFixture() {
  return (
    <>
      <FolderIcon />
      <FolderOpenIcon />
      <ListTodoIcon />
    </>
  );
}
