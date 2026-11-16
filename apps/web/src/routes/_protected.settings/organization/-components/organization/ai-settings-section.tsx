import { panic } from "better-result";
import { useTranslations } from "use-intl";

export type SectionFeedback =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved" }
  | { status: "error"; message: string };

export type KeySettingsDraft =
  | { action: "untouched" }
  | { action: "set"; apiKey: string }
  | { action: "cleared" };

export type KeySettingsSectionProps = {
  draft: KeySettingsDraft;
  onChange: (apiKey: string) => void;
  onRemove: () => void;
  disabled: boolean;
  feedback: SectionFeedback;
};

export type ToggleSettingsSectionProps = {
  value: boolean | null;
  onChange: (value: boolean) => void;
  disabled: boolean;
  feedback: SectionFeedback;
};

export const AISettingsSectionFeedback = ({
  feedback,
}: {
  feedback: SectionFeedback;
}) => {
  const t = useTranslations("common");
  switch (feedback.status) {
    case "idle":
      return null;
    case "saving":
      return (
        <p role="status" className="text-muted-foreground text-xs">
          {t("loading")}
        </p>
      );
    case "saved":
      return (
        <p role="status" className="text-muted-foreground text-xs">
          {t("saved")}
        </p>
      );
    case "error":
      return (
        <p
          role="alert"
          className="text-destructive text-sm wrap-anywhere whitespace-pre-wrap"
        >
          {feedback.message}
        </p>
      );
    default:
      feedback satisfies never;
      return panic("Unhandled AI settings section feedback");
  }
};
