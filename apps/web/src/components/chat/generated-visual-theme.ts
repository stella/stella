import { Result, panic } from "better-result";
import * as v from "valibot";

import {
  VISUAL_THEME_VARIABLES,
  visualThemeSchema,
  type VisualTheme,
} from "@stll/api-contract/visual-theme";

type ReadVisualThemeOptions = {
  style: Pick<CSSStyleDeclaration, "getPropertyValue" | "fontFamily">;
  appearance: VisualTheme["appearance"];
};

export const readVisualTheme = ({
  style,
  appearance,
}: ReadVisualThemeOptions) => {
  const variables = Object.fromEntries(
    VISUAL_THEME_VARIABLES.map((name) => {
      const value =
        style.getPropertyValue(name).trim() ||
        (name === "--font-sans" ? style.fontFamily : "");
      if (value === "") {
        panic(`Missing app visual theme token: ${name}`);
      }
      return [name, value];
    }),
  );
  return v.parse(visualThemeSchema, { appearance, variables });
};

type ReadVisualThemeOrOmitOptions = ReadVisualThemeOptions & {
  report: (error: unknown) => void;
};

/**
 * The app theme for a view, or none when the app's tokens cannot be read.
 * The view then keeps its own fallback tokens and still renders; the failure
 * is reported.
 */
export const readVisualThemeOrOmit = ({
  report,
  ...options
}: ReadVisualThemeOrOmitOptions): VisualTheme | undefined =>
  Result.try(() => readVisualTheme(options)).match({
    ok: (theme) => theme,
    err: (error) => {
      report(error);
      return undefined;
    },
  });
