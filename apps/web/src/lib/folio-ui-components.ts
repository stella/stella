import type { FolioUIComponents } from "@stll/folio";
import { Button } from "@stll/ui/components/button";

/**
 * Chrome UI primitives injected into folio's `DocxEditor` so the editor keeps
 * the app's design system while folio itself stays UI-agnostic. The object
 * grows as folio decouples more primitives; render sites pass it once and need
 * no further edits when the contract expands.
 */
export const folioUIComponents: Partial<FolioUIComponents> = {
  Button,
};
