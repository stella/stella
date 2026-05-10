import {
  CONDITIONAL_KINDS,
  DirectiveLabel,
  HighlightedText,
} from "@/routes/_protected.knowledge/-components/paragraph-rendering";
import type { BlockDirectiveKind } from "@/routes/_protected.knowledge/-components/paragraph-rendering";

// ── Types ────────────────────────────────────────────

type ClauseRun = {
  text: string;
  bold?: boolean;
  italic?: boolean;
};

type ClauseParagraph = {
  text: string;
  style?: string;
  level?: number;
  runs?: ClauseRun[];
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
        className={`rounded-sm border-s-[3px] py-1.5 ps-3 pe-2 ${
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

  const isHeading =
    paragraph.style?.startsWith("Heading") || paragraph.style === "heading";

  // Render with formatting runs if available
  if (paragraph.runs && paragraph.runs.length > 0) {
    return (
      <p className={`leading-relaxed ${isHeading ? "font-semibold" : ""}`}>
        {paragraph.runs.map((run, ri) => {
          let content: React.ReactNode = <HighlightedText text={run.text} />;
          if (run.bold) {
            content = <strong>{content}</strong>;
          }
          if (run.italic) {
            content = <em>{content}</em>;
          }
          return <span key={ri}>{content}</span>;
        })}
      </p>
    );
  }

  return (
    <p className={`leading-relaxed ${isHeading ? "font-semibold" : ""}`}>
      <HighlightedText text={paragraph.text} />
    </p>
  );
};
