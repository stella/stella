import { Skeleton } from "@stll/ui/skeleton";

import { MarkdownHybridEditor } from "@/components/markdown/markdown-hybrid-editor";
import {
  toEditorMarkdown,
  toStoredMarkdown,
} from "@/components/skill-body-markdown";

type ProposalBodyEditorProps = {
  /** Undefined while the proposal is still loading. */
  proposal: { id: string; body: string; baseBody: string } | undefined;
  editable: boolean;
  /** Receives the stored form: the proposal's frontmatter re-prepended. */
  onBodyChange: (storedMarkdown: string) => void;
};

/**
 * The proposed body diffed against the revision it branched from. Editable only
 * by its author while the proposal is still open; everyone else reviews it
 * read-only. The engine reads its text and comment mode once per mount, so the
 * key carries both the proposal and whether it is editable.
 */
export const ProposalBodyEditor = ({
  proposal,
  editable,
  onBodyChange,
}: ProposalBodyEditorProps) => {
  if (proposal === undefined) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-4">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-11/12" />
        <Skeleton className="h-3 w-4/5" />
      </div>
    );
  }

  return (
    <MarkdownHybridEditor
      imagePolicy="data-only"
      baseline={toEditorMarkdown(proposal.baseBody)}
      key={`${proposal.id}:${String(editable)}`}
      markdown={toEditorMarkdown(proposal.body)}
      onMarkdownChange={(editorMarkdown) => {
        onBodyChange(toStoredMarkdown(editorMarkdown, proposal.body));
      }}
      readOnly={!editable}
    />
  );
};
