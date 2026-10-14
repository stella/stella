import { ChatLink } from "@stll/chat/link";

import { MarkdownReferenceChip } from "@/components/references/reference-chip";
import { isReferenceHref } from "@/components/references/reference.logic";

/** Renders reference links (`#stella-entity=`, `#stella-decision=`, …) as
 *  the shared reference chip; all other links render as normal anchors. */
export const EntityLink = ({
  href,
  children,
  workspaceId,
  ...anchorProps
}: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
  workspaceId?: string | undefined;
}) => {
  if (href !== undefined && isReferenceHref(href)) {
    return (
      <MarkdownReferenceChip href={href} interactive workspaceId={workspaceId}>
        {children}
      </MarkdownReferenceChip>
    );
  }

  return (
    <ChatLink {...anchorProps} href={href ?? ""}>
      {children}
    </ChatLink>
  );
};
