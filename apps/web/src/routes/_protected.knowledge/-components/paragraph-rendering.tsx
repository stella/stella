import { useTranslations } from "use-intl";

// ── Placeholder regex ────────────────────────────────

const PLACEHOLDER_RE = /\{\{([^{}]+)\}\}/gu;

// ── Types ────────────────────────────────────────────

export type BlockDirectiveKind =
  | "if"
  | "elseif"
  | "else"
  | "endif"
  | "each"
  | "endeach";

// ── Sub-components ───────────────────────────────────

const CLAUSE_MARKER_PREFIX = "@clause:";

export const HighlightedText = ({ text }: { text: string }) => {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(PLACEHOLDER_RE)) {
    const start = match.index;
    if (start > lastIndex) {
      parts.push(text.slice(lastIndex, start));
    }

    const inner = match[1] ?? "";
    const isClauseSlot = inner.startsWith(CLAUSE_MARKER_PREFIX);

    parts.push(
      <mark
        className={`rounded-sm px-0.5 ${
          isClauseSlot
            ? "bg-muted dark:bg-muted"
            : "bg-warning/15 dark:bg-warning/15"
        }`}
        key={start}
      >
        {`{{${inner}}}`}
      </mark>,
    );
    lastIndex = start + match[0].length;
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
