import * as v from "valibot";

import {
  visualThemeMessageSchema,
  type VisualTheme,
} from "@stll/api-contract/visual-theme";

type VisualThemeHandlerOptions = {
  parentWindow: unknown;
  onTheme: (theme: VisualTheme) => void;
};

export const createVisualThemeHandler =
  ({ parentWindow, onTheme }: VisualThemeHandlerOptions) =>
  (event: { source: unknown; data: unknown }) => {
    if (event.source !== parentWindow) {
      return;
    }
    const parsed = v.safeParse(visualThemeMessageSchema, event.data);
    if (parsed.success) {
      onTheme(parsed.output.theme);
    }
  };
