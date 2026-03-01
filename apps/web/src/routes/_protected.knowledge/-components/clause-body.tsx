import {
  CONDITIONAL_KINDS,
  DirectiveLabel,
  HighlightedText,
  type BlockDirectiveKind,
} from "@/routes/_protected.knowledge/-components/paragraph-rendering";

// ── Types ────────────────────────────────────────────

type ClauseParagraph = {
  text: string;
  style?: string;
  level?: number;
  isDirective?: boolean;
  directiveKind?: BlockDirectiveKind;
  directiveExpression?: string;
};

// ── Component ────────────────────────────────────────

export const ClauseBody = ({
  paragraphs,
}: {
  paragraphs: ClauseParagraph[];
}) => {
  if (paragraphs.length === 0) {
    return null;
  }

  return (
    <div className="space-y-0.5 py-2 text-sm">
      {paragraphs.map((p, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: paragraphs are a static ordered list without stable IDs
        <ClauseParagraphRow key={i} paragraph={p} />
      ))}
    </div>
  );
};

const ClauseParagraphRow = ({ paragraph }: { paragraph: ClauseParagraph }) => {
  if (paragraph.isDirective && paragraph.directiveKind) {
    const isConditional = CONDITIONAL_KINDS.has(paragraph.directiveKind);

    return (
      <div
        className={`rounded-sm border-l-[3px] py-1.5 pr-2 pl-3 ${
          isConditional
            ? "border-blue-400 bg-blue-50/50 dark:border-blue-600 dark:bg-blue-950/20"
            : "border-emerald-400 bg-emerald-50/50 dark:border-emerald-600 dark:bg-emerald-950/20"
        }`}
      >
        <DirectiveLabel
          expression={paragraph.directiveExpression ?? ""}
          kind={paragraph.directiveKind}
        />
      </div>
    );
  }

  if (!paragraph.text.trim()) {
    return <div className="py-1" />;
  }

  const isHeading = paragraph.style?.startsWith("Heading");

  return (
    <p className={`leading-relaxed ${isHeading ? "font-semibold" : ""}`}>
      <HighlightedText text={paragraph.text} />
    </p>
  );
};
