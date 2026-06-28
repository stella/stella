import { createContext, useContext } from "react";
import type { ComponentProps, ComponentType, ReactNode } from "react";

import { DefaultButton } from "./defaults/button";

/**
 * Folio chrome (toolbars, dialogs, error states) renders UI primitives that a
 * consumer can override with its own design system. Each entry in
 * `FolioUIComponents` is a React component folio's chrome renders; the contract
 * grows as more primitives are decoupled from a hard design-system dependency.
 *
 * Standalone folio uses {@link DEFAULT_COMPONENTS}; consumers inject overrides
 * through `DocxEditor`'s `components` prop.
 */

/**
 * The Button prop subset folio's chrome actually relies on. `variant` and
 * `size` are deliberately narrow string-literal unions: each is a subset of the
 * design-system Button's options so an external Button stays assignable as an
 * override. Native attributes are picked from `<button>` so their types match
 * exactly.
 */
export type FolioButtonProps = Pick<
  ComponentProps<"button">,
  | "onClick"
  | "onMouseDown"
  | "className"
  | "disabled"
  | "type"
  | "title"
  | "aria-label"
  | "aria-pressed"
  | "children"
> & {
  variant?: "default" | "ghost";
  size?: "sm" | "xs" | "icon-xs";
};

export type FolioUIComponents = {
  Button: ComponentType<FolioButtonProps>;
};

export const DEFAULT_COMPONENTS: FolioUIComponents = {
  Button: DefaultButton,
};

const FolioUIContext = createContext<FolioUIComponents>(DEFAULT_COMPONENTS);

export function FolioUIProvider({
  components,
  children,
}: {
  components?: Partial<FolioUIComponents> | undefined;
  children: ReactNode;
}) {
  const value = components
    ? { ...DEFAULT_COMPONENTS, ...components }
    : DEFAULT_COMPONENTS;
  return (
    <FolioUIContext.Provider value={value}>{children}</FolioUIContext.Provider>
  );
}

export function useFolioUI(): FolioUIComponents {
  return useContext(FolioUIContext);
}
