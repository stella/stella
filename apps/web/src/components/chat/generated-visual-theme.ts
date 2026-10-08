import { panic } from "better-result";
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
