import { useTranslations } from "use-intl";

import type {
  ReaderAnnotationTargetType,
  ReaderAnnotationVisibility,
} from "@stll/api-contract/legal-reader-annotations";
import { Button } from "@stll/ui/button";
import { Building2Icon, LockIcon } from "@stll/ui/icons";

/**
 * Who a shared mark reaches: on public law, the reader's organization; on a
 * matter's content, everyone who can open the matter.
 */
export const SHARED_LABEL_KEY = {
  decision: "legalReader.annotations.visibilityShared",
  statute: "legalReader.annotations.visibilityShared",
  "verification-claim": "legalReader.annotations.visibilitySharedWithMatter",
  "matter-document": "legalReader.annotations.visibilitySharedWithMatter",
} as const satisfies Record<ReaderAnnotationTargetType, string>;

type AnnotationVisibilityToggleProps = {
  /** What the mark sits on, which decides who sharing reaches. */
  targetType: ReaderAnnotationTargetType;
  visibility: ReaderAnnotationVisibility;
  onToggle: () => void;
  disabled?: boolean;
  shareLabel?: string;
};

/** The same explicit sharing action for a passage's comments and answers. */
export const AnnotationVisibilityToggle = ({
  targetType,
  visibility,
  onToggle,
  disabled = false,
  shareLabel,
}: AnnotationVisibilityToggleProps) => {
  const t = useTranslations();
  const shared = visibility === "shared";
  const label = shared
    ? t(SHARED_LABEL_KEY[targetType])
    : (shareLabel ?? t("knowledge.agentSkills.scopePrivate"));
  return (
    <Button
      aria-label={label}
      aria-pressed={shared}
      className="group/plain"
      disabled={disabled}
      onClick={onToggle}
      tooltip={label}
      variant="plain"
    >
      {/* A glyph in the note's margin: muted, a full 44px target. */}
      <span className="text-muted-foreground group-hover/plain:text-foreground flex min-h-11 min-w-11 items-center gap-1 rounded-sm p-1">
        {shared ? (
          <Building2Icon className="size-3.5" />
        ) : (
          <LockIcon className="size-3.5" />
        )}
        {shareLabel !== undefined && <span>{label}</span>}
      </span>
    </Button>
  );
};
