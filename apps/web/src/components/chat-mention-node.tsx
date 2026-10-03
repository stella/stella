import { NodeViewWrapper } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";

import {
  ReferenceChip,
  useReferenceRenderWorkspaceId,
} from "@/components/references/reference-chip";
import { referenceFromMentionAttrs } from "@/components/references/reference.logic";

/**
 * A mention in the composer. It renders the same reference chip the sent
 * message and the answer render; ProseMirror's node selection shows as the
 * chip's selected ring, a state style, never as a colour of its own.
 */
export const ChatMentionNode = (props: NodeViewProps) => {
  const renderWorkspaceId = useReferenceRenderWorkspaceId();
  const reference = referenceFromMentionAttrs(props.node.attrs, {
    renderWorkspaceId,
  });

  return (
    <NodeViewWrapper className="inline">
      {reference === null ? null : (
        <ReferenceChip
          interactive={false}
          reference={reference}
          selected={props.selected}
        />
      )}
    </NodeViewWrapper>
  );
};
