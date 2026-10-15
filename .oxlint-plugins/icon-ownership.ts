// Reads the semantic entries of the icon module (packages/ui/src/icons.ts),
// the single source for which glyph means what and which component alone may
// draw a glyph. `no-unowned-icon` builds its table from here, so ownership is
// declared once, next to the entry, and never restated in a lint list.
//
// An entry is `export { Glyph as Name } from "lucide-react";` with its
// comment lines directly above it. An owned entry carries
// `// ownedBy: <Component> (<repo path>)`.

import { panic } from "better-result";
import { readFileSync } from "node:fs";
import path from "node:path";

export const ICON_MODULE_PATH = "packages/ui/src/icons.ts";

const SEMANTIC_EXPORT =
  /^export \{ (?<glyph>\w+) as (?<name>\w+) \} from "lucide-react";$/u;
const OWNED_BY = /^ownedBy: (?<component>\w+) \((?<owner>[^)\s]+)\)$/u;
// Any comment that looks like an ownership line. One that does not parse as
// OWNED_BY fails loudly, so a typo cannot silently unown an icon.
const OWNERSHIP_LIKE = /^owned/iu;

export type IconEntry = {
  readonly name: string;
  readonly glyph: string;
  readonly owner: { readonly component: string; readonly path: string } | null;
};

export const parseIconEntries = (source: string): IconEntry[] => {
  const entries: IconEntry[] = [];
  let comments: string[] = [];
  for (const line of source.split("\n")) {
    const match = SEMANTIC_EXPORT.exec(line);
    if (match?.groups !== undefined) {
      const owned = comments
        .map((comment) => OWNED_BY.exec(comment)?.groups)
        .find((groups) => groups !== undefined);
      entries.push({
        name: match.groups.name ?? "",
        glyph: match.groups.glyph ?? "",
        owner:
          owned === undefined
            ? null
            : {
                component: owned.component ?? "",
                path: owned.owner ?? "",
              },
      });
      comments = [];
    } else if (line.startsWith("//")) {
      const comment = line.replace(/^\/\/\s*/u, "");
      if (OWNERSHIP_LIKE.test(comment) && !OWNED_BY.test(comment)) {
        panic(
          `${ICON_MODULE_PATH}: malformed ownership line "${comment}"; ` +
            "write `ownedBy: <Component> (<repo path>)`.",
        );
      }
      comments.push(comment);
    } else {
      comments = [];
    }
  }
  return entries;
};

export const readIconEntries = (): IconEntry[] =>
  parseIconEntries(
    readFileSync(
      path.join(import.meta.dirname, "..", ICON_MODULE_PATH),
      "utf-8",
    ),
  );
