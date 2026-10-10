import { sanitizeHref } from "@stll/decision-reader/sanitize-href";

import { MarkdownReferenceChip } from "@/components/references/reference-chip";
import { isReferenceHref } from "@/components/references/reference.logic";

/** Renders reference links (`#stella-entity=`, `#stella-decision=`, …) as
 *  the shared reference chip; all other links render as normal anchors. */
export const EntityLink = ({
  href,
  children,
  workspaceId,
  ...props
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
    <a
      href={sanitizeHref(href)}
      rel="noopener noreferrer"
      target="_blank"
      {...props}
    >
      {children}
    </a>
  );
};
