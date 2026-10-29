// The sheet's contract, shared by its two renderers: the web's (./sheet.tsx,
// an edge-anchored Base UI dialog) and React Native's (./sheet.native.tsx,
// the platform's page sheet).

import type { ReactNode } from "react";

/** The props every sheet root accepts, with one meaning. */
export type SheetContract = {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: ReactNode;
};
