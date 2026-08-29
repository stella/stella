import type { DateFormatStyle } from "@stll/template-conditions";

import type { BusinessRegistrySlug } from "./business-registries";

export type TemplateRecipeDefinition = {
  fields: {
    path: string;
    label?: string | undefined;
    inputType?: "text" | "number" | "boolean" | "date" | "select" | undefined;
    options?: string[] | undefined;
    required?: boolean | undefined;
    aiPrompt?: string | undefined;
    aiAdapt?: boolean | undefined;
    aiSeesDocument?: boolean | undefined;
    parts?:
      | {
          key: string;
          label?: string | undefined;
          inputType: "text" | "select";
          options?: string[] | undefined;
          pattern?: string | undefined;
        }[]
      | undefined;
    format?: string | undefined;
    optionsFrom?: string | undefined;
    lookup?:
      | {
          registry: BusinessRegistrySlug;
          formats: { key: string; template: string }[];
        }
      | undefined;
    hint?: string | undefined;
    dateFormat?: { locale: string; style: DateFormatStyle } | undefined;
  }[];
  loop?: { path: string } | undefined;
};
