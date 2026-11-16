import { useState } from "react";
import type { ComponentProps, RefObject } from "react";

import { Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import { ImportUndoContacts } from "@/routes/_protected.contacts/-components/bulk-delete";
import { ImportResultsList } from "@/routes/_protected.contacts/-import-review";
import type { ImportReviewResult } from "@/routes/_protected.contacts/-import-review";

/**
 * The receipt of a finished import. It owns which created contacts a later
 * undo removed, so the summary, the list and the undo button always agree.
 */
export const ImportDoneStep = ({
  activeOrganizationId,
  deleteContacts,
  onRestart,
  results,
  stepHeadingRef,
}: {
  activeOrganizationId: string;
  /** External delete boundary; supplied by focused DOM tests. */
  deleteContacts?: ComponentProps<typeof ImportUndoContacts>["deleteContacts"];
  onRestart: () => void;
  results: ImportReviewResult[];
  stepHeadingRef: RefObject<HTMLHeadingElement | null>;
}) => {
  const t = useTranslations();
  const [undoneIds, setUndoneIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const createdIds = results.flatMap((result) =>
    result.status === "created" ? [result.contactId] : [],
  );
  const remainingIds = createdIds.filter((id) => !undoneIds.has(id));

  return (
    <section className="space-y-4">
      <div>
        <h2
          className="text-lg font-semibold outline-none"
          ref={stepHeadingRef}
          tabIndex={-1}
        >
          {t("common.done")}
        </h2>
        <p className="text-muted-foreground text-sm">
          {t("contacts.import.resultsSummary", {
            created: createdIds.length,
            skipped: results.filter(({ status }) => status === "skipped")
              .length,
          })}
        </p>
        {undoneIds.size > 0 ? (
          <p className="text-muted-foreground text-sm">
            {t("contacts.importStudio.undoneSummary", {
              count: undoneIds.size,
            })}
          </p>
        ) : null}
      </div>
      <ImportResultsList results={results} undoneContactIds={undoneIds} />
      <div className="flex flex-wrap gap-2 pt-2">
        <Button render={<Link to="/contacts" />}>
          {t("contacts.importStudio.openContacts")}
        </Button>
        <Button onClick={onRestart} variant="outline">
          {t("contacts.importStudio.importAnother")}
        </Button>
        <ImportUndoContacts
          contactIds={remainingIds}
          deleteContacts={deleteContacts}
          onUndone={(removedIds) =>
            setUndoneIds((current) => new Set([...current, ...removedIds]))
          }
          organizationId={activeOrganizationId}
        />
      </div>
    </section>
  );
};
