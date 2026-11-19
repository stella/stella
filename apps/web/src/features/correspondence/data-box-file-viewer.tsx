import { useSuspenseQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import type { DataBoxDeliveryEvent } from "@stll/api-contract/data-box";
import { Button } from "@stll/ui/button";
import { DownloadIcon } from "@stll/ui/icons";
import { ScrollArea } from "@stll/ui/scroll-area";

import { DOCKED_COMPOSER_CLEARANCE } from "@/components/ai-suggestions/composer-geometry";
import { FileViewerWithAI } from "@/components/ai-suggestions/file-viewer-with-ai";
import type { FileTab } from "@/components/inspector/file-tab";
import { useFormatter } from "@/i18n/formatting-context";
import { dataBoxPreviewOptions } from "@/lib/files/queries";
import { MEDIUM_DATE_SHORT_TIME_FORMAT } from "@/lib/relative-time";

import { CorrespondenceAttachments } from "./correspondence-attachments";
import { DataBoxEnvelope } from "./data-box-envelope";

/** Receipt events can repeat; the nth event with the same statement keeps its key. */
const keyedEvents = <TEvent extends DataBoxDeliveryEvent>(
  events: readonly TEvent[],
) => {
  const seen = new Map<string, number>();
  return events.map((event) => {
    const statement = JSON.stringify([event.occurredAt, event.description]);
    const occurrence = (seen.get(statement) ?? 0) + 1;
    seen.set(statement, occurrence);
    return { ...event, key: `${statement}#${occurrence}` };
  });
};

export const DataBoxFileViewer = ({
  onDownload,
  tab,
}: {
  onDownload: () => void;
  tab: FileTab;
}) => {
  const { data } = useSuspenseQuery(
    dataBoxPreviewOptions({ fieldId: tab.id, workspaceId: tab.workspaceId }),
  );
  const t = useTranslations();
  const format = useFormatter();
  const hasUnlinkedFiles =
    data.kind === "message" &&
    data.files.some((file) => file.entityId === null);

  return (
    <FileViewerWithAI
      activeFile={{
        entityId: tab.entityId,
        fileFieldId: tab.id,
        fileName: tab.fileName,
      }}
      className="flex h-full min-h-0 flex-col"
      workspaceId={tab.workspaceId}
    >
      <ScrollArea axis="vertical" className="min-h-0 flex-1">
        <article
          {...DOCKED_COMPOSER_CLEARANCE}
          className="space-y-4 p-4"
          data-print-root=""
        >
          {data.annotation && (
            <h2 className="text-base font-medium">
              <bdi dir="auto">{data.annotation}</bdi>
            </h2>
          )}
          <DataBoxEnvelope
            contacts={null}
            envelope={data.envelope}
            titleKey={
              data.kind === "receipt"
                ? "correspondence.dataBox.deliveryReceipt"
                : "correspondence.dataBox.statedInFile"
            }
          />
          {data.kind === "message" && (
            <CorrespondenceAttachments
              files={data.files}
              workspaceId={tab.workspaceId}
            />
          )}
          {data.kind === "receipt" && data.events.length > 0 && (
            <section className="rounded-lg border p-4">
              <h2 className="mb-3 text-sm font-medium">
                {t("correspondence.dataBox.deliveryEvents")}
              </h2>
              <ol className="divide-y text-sm">
                {keyedEvents(data.events).map(
                  ({ key, occurredAt, description }) => (
                    <li className="flex flex-wrap gap-x-3 py-2" key={key}>
                      {occurredAt && (
                        <time
                          className="text-muted-foreground"
                          dateTime={occurredAt}
                        >
                          {format.dateTime(
                            new Date(occurredAt),
                            MEDIUM_DATE_SHORT_TIME_FORMAT,
                          )}
                        </time>
                      )}
                      {description && <bdi dir="auto">{description}</bdi>}
                    </li>
                  ),
                )}
              </ol>
            </section>
          )}
          {hasUnlinkedFiles && (
            <p className="text-sm print:hidden">
              {t("correspondence.dataBox.unlinkedFiles")}
            </p>
          )}
          <div className="space-y-2">
            <Button
              className="print:hidden"
              onClick={onDownload}
              size="sm"
              type="button"
              variant="outline"
            >
              <DownloadIcon />
              {t("common.downloadOriginal")}
            </Button>
            <p className="text-muted-foreground text-xs">
              {t("correspondence.dataBox.sealNotVerified")}
            </p>
          </div>
        </article>
      </ScrollArea>
    </FileViewerWithAI>
  );
};
