import type { ComponentProps } from "react";

import { documentNamePatternProblem } from "@stll/api-contract/document-name";

import { DocumentNamePatternField } from "@/routes/_protected.settings/organization/-components/organization/document-name-pattern-field";

const states = [
  { key: "preview", value: "{dateCompact}_{matterNumber}_{docType}_{title}" },
  { key: "invalid", value: "{party}_{title}" },
  { key: "empty", value: "" },
] as const;

const fieldProps = (
  value: string,
): ComponentProps<typeof DocumentNamePatternField> => ({
  value,
  onChange: () => undefined,
  problem: value === "" ? null : documentNamePatternProblem(value),
});

export const DocumentNamingPlayground = () => (
  <section
    className="grid w-full max-w-md gap-8 p-4"
    data-playground-section="document-naming"
  >
    {states.map(({ key, value }) => (
      <div className="grid gap-3" data-document-naming-state={key} key={key}>
        <DocumentNamePatternField {...fieldProps(value)} />
      </div>
    ))}
  </section>
);
