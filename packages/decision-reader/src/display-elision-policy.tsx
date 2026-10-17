/**
 * Whether the reader applies the court publishers' display elisions.
 *
 * A published decision carries typesetting artefacts the reader hides: letter
 * runs spaced out for emphasis, quotes escaped by the publisher's export. On a
 * court's text that is the faithful reading. On a document a user uploaded the
 * same rules would rewrite the evidence a reviewer is checking, so a surface
 * that renders uploads states that its text is literal.
 *
 * A context for the same reason as the source-link policy: the renderers that
 * consult it sit deep in layout code. The default keeps the court reading.
 */

import { createContext, useContext } from "react";
import type { ReactNode } from "react";

export type DisplayElisionPolicy = "publisher" | "literal";

const DisplayElisionPolicyContext =
  createContext<DisplayElisionPolicy>("publisher");

export const useDisplayElisionPolicy = (): DisplayElisionPolicy =>
  useContext(DisplayElisionPolicyContext);

/** Render the text below exactly as stored, without publisher elisions. */
export const LiteralTextProvider = ({ children }: { children: ReactNode }) => (
  <DisplayElisionPolicyContext.Provider value="literal">
    {children}
  </DisplayElisionPolicyContext.Provider>
);
