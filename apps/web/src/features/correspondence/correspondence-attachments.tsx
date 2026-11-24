import { useRouter } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { TruncatedText } from "@stll/ui/truncated-text";

import { openEntityInInspector } from "@/components/chat/entity-open";
import { DocumentIcon } from "@/components/document-icon";
import { useFormatter } from "@/i18n/formatting-context";
import { detached } from "@/lib/detached";
import { getCurrentWorkspaceDocument } from "@/lib/workspaces/use-workspace-view-params";

/**
 * A filed record's attachments: documents of the matter, each with its type
 * icon and size, opening as the document it was filed as.
 */
export const CorrespondenceAttachments = ({
  files,
  workspaceId,
}: {
  files: readonly {
    entityId: string | null;
    fileName: string;
    mediaType: string;
    byteSize?: number;
  }[];
  workspaceId: string;
}) => {
  const router = useRouter();
  const t = useTranslations();
  const format = useFormatter();
  if (files.length === 0) {
    return null;
  }
  return (
    <section className="rounded-lg border p-4">
      <h2 className="mb-3 text-sm font-medium">
        {t("emailViewer.attachments")}
      </h2>
      <ul className="divide-y">
        {files.map(({ entityId, fileName, mediaType, byteSize }, ordinal) => (
          <li
            className="flex items-center gap-2 py-2 text-sm"
            key={entityId ?? ordinal}
          >
            <DocumentIcon
              className="size-4 shrink-0"
              fileName={fileName}
              mimeType={mediaType}
            />
            {entityId === null ? (
              <TruncatedText dir="auto" render={<bdi />}>
                {fileName}
              </TruncatedText>
            ) : (
              <Button
                className="min-w-0"
                onClick={() =>
                  detached(
                    openEntityInInspector({
                      documentOnScreen: getCurrentWorkspaceDocument(
                        router.state.matches,
                      ),
                      entityId,
                      label: fileName,
                      workspaceId,
                    }),
                    "correspondence.open-attachment",
                  )
                }
                size="sm"
                type="button"
                variant="link"
              >
                <TruncatedText dir="auto" render={<bdi />}>
                  {fileName}
                </TruncatedText>
              </Button>
            )}
            {byteSize !== undefined && (
              <span className="text-muted-foreground ms-auto shrink-0 text-xs tabular-nums">
                {format.number(byteSize, {
                  style: "unit",
                  unit: "byte",
                  unitDisplay: "short",
                })}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
};
