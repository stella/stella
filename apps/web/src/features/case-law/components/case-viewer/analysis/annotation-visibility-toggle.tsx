import { useTranslations } from "use-intl";

import type { ReaderAnnotationVisibility } from "@stll/api-contract/legal-reader-annotations";
import { Building2Icon, LockIcon } from "@stll/ui/icons";

import Tooltip from "@/components/tooltip";

type AnnotationVisibilityToggleProps = {
  visibility: ReaderAnnotationVisibility;
  onToggle: () => void;
  disabled?: boolean;
  shareLabel?: string;
};

/** The same explicit sharing action for a passage's comments and answers. */
export const AnnotationVisibilityToggle = ({
  visibility,
  onToggle,
  disabled = false,
  shareLabel,
}: AnnotationVisibilityToggleProps) => {
  const t = useTranslations();
  const shared = visibility === "shared";
  const label = shared
    ? t("legalReader.annotations.visibilityShared")
    : (shareLabel ?? t("knowledge.agentSkills.scopePrivate"));
  return (
    <Tooltip
      content={label}
      render={
        <button
          aria-label={label}
          aria-pressed={shared}
          aria-disabled={disabled}
          className="text-muted-foreground hover:text-foreground flex min-h-11 min-w-11 items-center gap-1 rounded-sm p-1"
          onClick={() => {
            if (!disabled) {
              onToggle();
            }
          }}
          type="button"
        />
      }
    >
      {shared ? (
        <Building2Icon className="size-3.5" />
      ) : (
        <LockIcon className="size-3.5" />
      )}
      {shareLabel !== undefined && <span>{label}</span>}
    </Tooltip>
  );
};
