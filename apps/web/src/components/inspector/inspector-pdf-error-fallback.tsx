import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { AlertTriangleIcon } from "@stll/ui/icons";

import type { WorkspaceFieldContent } from "@/lib/types";

type ConversionRefusal = NonNullable<
  Extract<
    WorkspaceFieldContent,
    { type: "file" }
  >["pdfDerivative"] extends infer State
    ? State extends { status: "failed" }
      ? State["conversionRefusal"]
      : never
    : never
>;

const LEGACY_FORMAT = {
  ".pptx": "PowerPoint",
  ".xlsx": "Excel",
} as const satisfies Record<
  Extract<ConversionRefusal, { kind: "legacy_format" }>["replacementExtension"],
  string
>;

export const ConversionRefusalFallback = ({
  refusal,
}: {
  refusal: ConversionRefusal;
}) => {
  const t = useTranslations();
  let message: string;
  switch (refusal.kind) {
    case "unsupported_field":
      message = t("inspector.conversionRefusal.unsupportedField", {
        fieldType: refusal.fieldType,
      });
      break;
    case "unsupported_reference":
      message = t("inspector.conversionRefusal.unsupportedReference", {
        element: refusal.element,
        attribute: refusal.attribute,
      });
      break;
    case "legacy_format":
      message = t("inspector.conversionRefusal.legacyFormat", {
        format: LEGACY_FORMAT[refusal.replacementExtension],
        replacementExtension: refusal.replacementExtension,
      });
      break;
    default:
      refusal satisfies never;
      return panic("Unexpected conversion refusal");
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <AlertTriangleIcon className="text-foreground-disabled size-8" />
      <p className="text-muted-foreground text-sm">{message}</p>
    </div>
  );
};

export const InspectorPdfErrorFallback = ({
  onRetry,
}: {
  onRetry?: (() => void) | undefined;
}) => {
  const t = useTranslations();

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <AlertTriangleIcon className="text-foreground-disabled size-8" />
      <p className="text-muted-foreground text-sm">
        {t("common.somethingWentWrong")}
      </p>
      {onRetry && (
        <Button onClick={onRetry} size="sm" variant="outline">
          {t("common.tryAgain")}
        </Button>
      )}
    </div>
  );
};
