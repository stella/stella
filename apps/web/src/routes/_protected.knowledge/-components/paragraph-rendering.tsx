import { useTranslations } from "use-intl";

// ── Placeholder regex ────────────────────────────────

export const PLACEHOLDER_RE = /\{\{([^{}]+)\}\}/g;

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
    const start = match.index ?? 0;
    if (start > lastIndex) {
      parts.push(text.slice(lastIndex, start));
    }

    const inner = match[1];
    const isClauseSlot = inner.startsWith(CLAUSE_MARKER_PREFIX);

    parts.push(
      <mark
        className={`rounded-sm px-0.5 ${
          isClauseSlot
            ? "bg-purple-100 dark:bg-purple-900/30"
            : "bg-amber-100 dark:bg-amber-900/30"
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

  return <>{parts}</>;
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
          ? "text-blue-600 dark:text-blue-400"
          : "text-emerald-600 dark:text-emerald-400"
      }`}
    >
      {label}
    </span>
  );
};
