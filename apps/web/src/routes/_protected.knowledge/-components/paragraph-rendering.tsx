import { useTranslations } from "use-intl";

import { BLOCK_DIRECTIVE_KINDS, scanMarkers } from "@stll/template-conditions";

// ── Types ────────────────────────────────────────────

// Block directives that wrap content (own paragraph). Derived from the shared
// grammar so it cannot drift from the fill pipeline's directive kinds.
export type BlockDirectiveKind = (typeof BLOCK_DIRECTIVE_KINDS)[number];

// ── Sub-components ───────────────────────────────────

export const HighlightedText = ({ text }: { text: string }) => {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;

  for (const marker of scanMarkers(text)) {
    if (marker.start > lastIndex) {
      parts.push(text.slice(lastIndex, marker.start));
    }

    // Plain fields read as the prominent "to fill" token; clause slots,
    // numbering markers, and block directives sit a touch softer.
    const isField = marker.meta.kind === "placeholder";

    parts.push(
      <mark
        className={`rounded-sm px-0.5 ${
          isField
            ? "bg-warning/15 dark:bg-warning/15"
            : "bg-muted dark:bg-muted"
        }`}
        key={marker.start}
      >
        {marker.raw}
      </mark>,
    );
    lastIndex = marker.end;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts;
};

export const CONDITIONAL_KINDS = new Set<BlockDirectiveKind>([
  "if",
  "elseif",
  "else",
  "endif",
]);

export const DirectiveLabel = ({
  kind,
  expression,
}: {
  kind: BlockDirectiveKind;
  expression: string;
}) => {
  const t = useTranslations("templates");
  const isConditional = CONDITIONAL_KINDS.has(kind);

  const label = (() => {
    switch (kind) {
      case "if":
        return t("directiveIf", { expression });
      case "elseif":
        return t("directiveElseIf", { expression });
      case "else":
        return t("directiveElse");
      case "endif":
        return t("directiveEndIf");
      case "each":
        return t("directiveEach", { expression });
      case "endeach":
        return t("directiveEndEach");
      default:
        return kind;
    }
  })();

  return (
    <span
      className={`text-xs font-medium ${
        isConditional
          ? "text-foreground dark:text-foreground-muted"
          : "text-success"
      }`}
    >
      {label}
    </span>
  );
};
