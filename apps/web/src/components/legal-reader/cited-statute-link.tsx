import type { ReactNode } from "react";

import { Link } from "@tanstack/react-router";

import { LEGAL_CITATION_LINK_CLASS_NAME } from "@stll/decision-reader/citation-link";
import type { CitedStatuteTarget } from "@stll/decision-reader/reader-types";
import { ReferencePeek } from "@stll/decision-reader/reference-peek";
import { cn } from "@stll/ui/utils";

import { useInspectorView } from "@/components/inspector/use-inspector-view";
import { createStatuteViewTab } from "@/features/statutes/statute-inspector.logic";
import { createStatuteLinkTarget } from "@/lib/statutes/statute-route";

/**
 * A work-level statute citation: no provision locator is required. Its peek
 * names the act and opens it beside the decision or on its own page; every
 * browser navigation gesture follows the link to the act's page.
 */
export const CitedStatuteLink = ({
  children,
  className,
  target,
}: {
  children: ReactNode;
  className?: string | undefined;
  target: CitedStatuteTarget;
}) => {
  const { open } = useInspectorView();
  const linkTarget = createStatuteLinkTarget({
    country: target.document.country,
    documentId: target.document.id,
    eli: target.document.eli,
    slug: target.document.slug,
    versionValidFrom: target.document.versionValidFrom,
  });

  return (
    <ReferencePeek
      header={{ primary: target.statuteTitle, meta: [] }}
      target={{
        kind: "statute",
        actions: {
          openInSidePanel: () =>
            open(
              createStatuteViewTab({
                country: target.document.country,
                documentId: target.document.id,
                eli: target.document.eli,
                slug: target.document.slug,
                statuteTitle: target.statuteTitle,
                versionValidFrom: target.document.versionValidFrom,
              }),
            ),
          openInStella: <Link {...linkTarget} />,
        },
      }}
      trigger={{
        type: "link",
        element: (
          <Link
            className={cn(LEGAL_CITATION_LINK_CLASS_NAME, className)}
            {...linkTarget}
          />
        ),
      }}
    >
      {children}
    </ReferencePeek>
  );
};
