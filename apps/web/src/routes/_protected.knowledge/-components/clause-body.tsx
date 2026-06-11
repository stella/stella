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

type ClauseListKind = "bullet" | "ordered";

type ClauseParagraph = {
  text: string;
  style?: string;
  level?: number;
  runs?: ClauseRun[];
  isDirective?: boolean;
  directiveKind?: BlockDirectiveKind;
  directiveExpression?: string;
  listKind?: ClauseListKind;
  listLevel?: number;
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
    <div className="space-y-0.5 py-2 text-sm">{renderRows(paragraphs)}</div>
  );
};

/**
 * Walk the flat paragraph array, rendering each run of consecutive list
 * paragraphs (`listKind` set) as a real nested `<ul>`/`<ol>` and every other
 * paragraph as a row. List nesting is reconstructed from `listLevel`.
 */
const renderRows = (paragraphs: ClauseParagraph[]): React.ReactNode[] => {
  const rows: React.ReactNode[] = [];
  let i = 0;

  while (i < paragraphs.length) {
    const p = paragraphs[i];
    if (!p) {
      i += 1;
      continue;
    }
    if (p.listKind && !p.isDirective) {
      const built = buildListTree(paragraphs, i, p.listLevel ?? 0, p.listKind);
      rows.push(<ClauseList key={i} node={built.node} />);
      i += built.consumed;
      continue;
    }
    rows.push(<ClauseParagraphRow key={i} paragraph={p} />);
    i += 1;
  }

  return rows;
};

type ListTreeItem = {
  paragraph: ClauseParagraph;
  children: ListTree | null;
};

type ListTree = {
  kind: ClauseListKind;
  items: ListTreeItem[];
};

/** Build a nested list tree for one run of list paragraphs at `level`. */
const buildListTree = (
  paragraphs: ClauseParagraph[],
  start: number,
  level: number,
  kind: ClauseListKind,
): { node: ListTree; consumed: number } => {
  const items: ListTreeItem[] = [];
  let i = start;

  while (i < paragraphs.length) {
    const p = paragraphs[i];
    if (!p || p.isDirective || !p.listKind) {
      break;
    }
    const pLevel = Math.max(0, p.listLevel ?? 0);
    if (pLevel < level || (pLevel === level && p.listKind !== kind)) {
      break;
    }
    if (pLevel > level) {
      const child = buildListTree(paragraphs, i, pLevel, p.listKind);
      const lastItem = items.at(-1);
      if (lastItem) {
        lastItem.children = child.node;
      } else {
        items.push({ paragraph: { text: "" }, children: child.node });
      }
      i += child.consumed;
      continue;
    }

    const item: ListTreeItem = { paragraph: p, children: null };
    i += 1;
    const next = paragraphs[i];
    if (next?.listKind && !next.isDirective && (next.listLevel ?? 0) > level) {
      const child = buildListTree(
        paragraphs,
        i,
        next.listLevel ?? 0,
        next.listKind,
      );
      item.children = child.node;
      i += child.consumed;
    }
    items.push(item);
  }

  return { node: { kind, items }, consumed: i - start };
};

const ClauseList = ({ node }: { node: ListTree }) => {
  if (node.kind === "ordered") {
    return (
      <ol className="my-1 list-decimal ps-6">
        <ClauseListItems items={node.items} />
      </ol>
    );
  }
  return (
    <ul className="my-1 list-disc ps-6">
      <ClauseListItems items={node.items} />
    </ul>
  );
};

const ClauseListItems = ({ items }: { items: ListTreeItem[] }) => (
  <>
    {items.map((item, idx) => (
      <li className="leading-relaxed" key={idx}>
        <ParagraphContent paragraph={item.paragraph} />
        {item.children ? <ClauseList node={item.children} /> : null}
      </li>
    ))}
  </>
);

/** Inline content (runs or plain text) of a paragraph, without a block wrapper. */
const ParagraphContent = ({ paragraph }: { paragraph: ClauseParagraph }) => {
  if (paragraph.runs && paragraph.runs.length > 0) {
    return (
      <>
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
      </>
    );
  }

  return <HighlightedText text={paragraph.text} />;
};

const ClauseParagraphRow = ({ paragraph }: { paragraph: ClauseParagraph }) => {
  if (paragraph.isDirective && paragraph.directiveKind) {
    const isConditional = CONDITIONAL_KINDS.has(paragraph.directiveKind);

    return (
      <div
        className={`rounded-sm border-s-[3px] py-1.5 ps-3 pe-2 ${
          isConditional
            ? "border-foreground-disabled bg-accent/50 dark:border-foreground-disabled dark:bg-accent/30"
            : "border-success/40 bg-success/10 dark:border-success/40 dark:bg-success/10"
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

  return (
    <p className={`leading-relaxed ${isHeading ? "font-semibold" : ""}`}>
      <ParagraphContent paragraph={paragraph} />
    </p>
  );
};
