import { createContext, use } from "react";
import type { ReactNode } from "react";

/**
 * How a cell's text is decorated on its way to the screen.
 *
 * This package draws a field's value; it has no opinion on why a host might
 * want part of that value marked. A host that does — a table's find bar
 * marking the matches it filtered on — supplies a renderer per property, and
 * the default hands the string back untouched.
 *
 * Renderers receive the text a cell would have shown, so a decoration can only
 * ever wrap what was already rendered, never change it.
 */
export type FieldTextRenderer = (text: string) => ReactNode;

const plainText: FieldTextRenderer = (text) => text;

const FieldTextContext = createContext<
  (propertyId: string | undefined) => FieldTextRenderer
>(() => plainText);

export const FieldTextProvider = FieldTextContext.Provider;

export const useFieldText = (
  propertyId: string | undefined,
): FieldTextRenderer => use(FieldTextContext)(propertyId);
