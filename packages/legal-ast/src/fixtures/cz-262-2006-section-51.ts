import { panic } from "better-result";

import rawSection51 from "../__fixtures__/cz-262-2006-section-51.json" with { type: "json" };
import { parseDocumentAst } from "../document-ast";

// A recorded statute section, validated once so the seed and its tests share
// the typed document shape instead of the widened JSON import.
export const section51StatuteAst =
  parseDocumentAst(rawSection51) ??
  panic("cz-262-2006-section-51 fixture is not a valid document AST");
