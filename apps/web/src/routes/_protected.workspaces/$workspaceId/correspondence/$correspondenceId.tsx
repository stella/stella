import type { ReactNode } from "react";

import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { ScrollArea } from "@stll/ui/scroll-area";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";

import { openEntityInInspector } from "@/components/chat/entity-open";
import { MatterRefLink } from "@/components/matter-ref-link";
import { QueryViewFeedback } from "@/components/query-view-feedback";
import { usePermissions } from "@/hooks/use-permissions";
import { useFormatter } from "@/i18n/formatting-context";
import { detached } from "@/lib/detached";
import { ensureRouteQueryData } from "@/lib/react-query";
import { MEDIUM_DATE_SHORT_TIME_FORMAT } from "@/lib/relative-time";
import { useQueryView, useQueryViewError } from "@/lib/use-query-view";
import {
  CORRESPONDENCE_AUTH_LABEL_KEYS,
  correspondenceByIdOptions,
  uniqueCorrespondenceAddresses,
} from "@/lib/workspaces/queries/correspondence";
import { viewsOptions } from "@/lib/workspaces/queries/views";
import { selectAvailableWorkspaceViews } from "@/lib/workspaces/queries/views.logic";
import { workspaceMembersOptions } from "@/lib/workspaces/queries/workspace-members";
import { correspondenceViewId } from "@/lib/workspaces/view-layout";
import { CorrespondenceProvenance } from "@/routes/_protected.workspaces/$workspaceId/-components/correspondence-provenance";
import { correspondenceProvenancePresentation } from "@/routes/_protected.workspaces/$workspaceId/-components/correspondence-provenance.logic";
import { UploadedSource } from "@/routes/_protected.workspaces/$workspaceId/-components/uploaded-mail-source";
import { useUpdateCorrespondence } from "@/routes/_protected.workspaces/$workspaceId/-mutations/correspondence";

export const Route = createFileRoute(
  "/_protected/workspaces/$workspaceId/correspondence/$correspondenceId",
)({
  component: CorrespondenceDetailPage,
  loader: async ({ context, params }) => {
    await ensureRouteQueryData(
      context.queryClient,
      correspondenceByIdOptions(params.workspaceId, params.correspondenceId),
    );
  },
});

function CorrespondenceDetailPage() {
  const t = useTranslations();
  const format = useFormatter();
  const { workspaceId, correspondenceId } = Route.useParams({
    select: (params) => ({
      workspaceId: params.workspaceId,
      correspondenceId: params.correspondenceId,
    }),
  });
  const { data } = useSuspenseQuery(
    correspondenceByIdOptions(workspaceId, correspondenceId),
  );
  const { record, filers, attachments } = data;
  const provenance = correspondenceProvenancePresentation(record);
  const membersQuery = useQuery(workspaceMembersOptions(workspaceId));
  const membersView = useQueryView(membersQuery);
  const members = membersView.type === "items" ? membersView.items : [];
  const update = useUpdateCorrespondence();
  const canUpdate = usePermissions({ workspace: ["update"] });
  const tCommon = useTranslations("common");

  return (
    <div className="flex h-full flex-col">
      <QueryViewFeedback view={membersView} />
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <BackToCorrespondenceLink workspaceId={workspaceId} />

        <h1 className="min-w-0 flex-1 truncate text-sm font-medium">
          <bdi dir="auto">{record.subject || t("emailViewer.noSubject")}</bdi>
        </h1>
        {canUpdate && (
          <Button
            className="min-h-11"
            disabled={update.isPending}
            onClick={() =>
              update.mutate({
                workspaceId,
                correspondenceId,
                type: "set_handling",
                handlingState:
                  record.handlingState === "new" ? "handled" : "new",
              })
            }
            size="sm"
            variant="outline"
          >
            {record.handlingState === "new"
              ? t("correspondence.markHandled")
              : t("correspondence.markNew")}
          </Button>
        )}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-5 p-4">
          {record.source === "delivery" ? (
            <section className="space-y-3 rounded-lg border p-4">
              <h2 className="text-sm font-medium">
                {t("correspondence.deliveryAuthentication")}
              </h2>
              <CorrespondenceProvenance record={record} />
              <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
                {(["spf", "dkim", "dmarc"] as const).map((check) => (
                  <bdi dir="ltr" key={check}>
                    {check.toUpperCase()}:{" "}
                    {t(
                      CORRESPONDENCE_AUTH_LABEL_KEYS[
                        record.authenticatedSender[check]
                      ],
                    )}
                  </bdi>
                ))}
              </span>
            </section>
          ) : (
            <UploadedSource
              uploader={filers.find((filer) => filer.type === "user")}
              signatureDomain={provenance.signatureDomain}
              sourceEntityId={record.sourceEntityId}
              workspaceId={workspaceId}
            />
          )}
          <section className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2">
            {provenance.assertedHeadersLabel !== null && (
              <h2 className="text-sm font-medium sm:col-span-2">
                {t(provenance.assertedHeadersLabel)}
              </h2>
            )}
            {provenance.assertedHeadersLabel !== null && (
              <DetailField
                label={t("inspector.metadata.documentProperties.keys.subject")}
              >
                <bdi dir="auto">
                  {record.subject || t("emailViewer.noSubject")}
                </bdi>
              </DetailField>
            )}
            <DetailField label={t(provenance.originalSenderLabel)}>
              <Address name={record.from.name} address={record.from.address} />
            </DetailField>
            <DetailField label={t("emailViewer.to")}>
              <AddressList addresses={record.to} />
            </DetailField>
            {record.cc.length > 0 && (
              <DetailField label={t("emailViewer.cc")}>
                <AddressList addresses={record.cc} />
              </DetailField>
            )}
            {record.sentAt && (
              <DetailField label={t("correspondence.sentAt")}>
                {format.dateTime(
                  new Date(record.sentAt),
                  MEDIUM_DATE_SHORT_TIME_FORMAT,
                )}
              </DetailField>
            )}
          </section>
          <section className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2">
            <DetailField label={t("correspondence.receivedAt")}>
              {format.dateTime(
                new Date(record.receivedAt),
                MEDIUM_DATE_SHORT_TIME_FORMAT,
              )}
            </DetailField>
            <DetailField label={t("common.assignee")}>
              {canUpdate ? (
                <Select
                  disabled={update.isPending}
                  onValueChange={(value) =>
                    update.mutate({
                      workspaceId,
                      correspondenceId,
                      type: "assign",
                      assigneeId: value === "unassigned" ? null : value,
                    })
                  }
                  value={record.assigneeId ?? "unassigned"}
                >
                  <SelectTrigger className="min-h-11 w-full sm:max-w-64">
                    <SelectValue>
                      {(value) =>
                        value === "unassigned"
                          ? tCommon("unassigned")
                          : (members.find((member) => member.userId === value)
                              ?.user?.name ?? tCommon("unassigned"))
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="unassigned">
                      {tCommon("unassigned")}
                    </SelectItem>
                    {members.map((member) => {
                      if (member.user === null) {
                        return null;
                      }
                      return (
                        <SelectItem key={member.userId} value={member.userId}>
                          {member.user.name}
                        </SelectItem>
                      );
                    })}
                  </SelectPopup>
                </Select>
              ) : (
                (members.find((member) => member.userId === record.assigneeId)
                  ?.user?.name ?? tCommon("unassigned"))
              )}
            </DetailField>
          </section>

          <section className="rounded-lg border p-4">
            <h2 className="mb-3 text-sm font-medium">
              {t("emailViewer.bodyTitle")}
            </h2>
            {record.bodyHtml === null ? (
              <pre
                className="text-foreground font-sans text-sm leading-6 wrap-break-word whitespace-pre-wrap"
                dir="auto"
              >
                {record.bodyText}
              </pre>
            ) : (
              <iframe
                className="h-[28rem] w-full rounded border"
                referrerPolicy="no-referrer"
                sandbox=""
                // safe-html: sanitizeEmailBodyHtml in apps/api/src/lib/files/email-to-html.ts strips active content; the iframe sandbox omits script permission.
                srcDoc={record.bodyHtml}
                title={t("emailViewer.bodyTitle")}
              />
            )}
          </section>

          {attachments.length > 0 && (
            <section className="rounded-lg border p-4">
              <h2 className="mb-3 text-sm font-medium">
                {t("emailViewer.attachments")}
              </h2>
              <ul className="divide-y">
                {attachments.map((attachment) => (
                  <li
                    className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                    key={attachment.entityId}
                  >
                    <Button
                      className="min-w-0"
                      onClick={() =>
                        detached(
                          openEntityInInspector(
                            attachment.entityId,
                            attachment.filename,
                            workspaceId,
                          ),
                          "correspondence.open-attachment",
                        )
                      }
                      size="sm"
                      type="button"
                      variant="link"
                    >
                      <bdi className="block truncate" dir="auto">
                        {attachment.filename}
                      </bdi>
                    </Button>
                    <span className="text-muted-foreground text-xs">
                      {format.number(attachment.byteSize, {
                        style: "unit",
                        unit: "byte",
                        unitDisplay: "short",
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {filers.length > 0 && (
            <section className="rounded-lg border p-4">
              <h2 className="mb-2 text-sm font-medium">
                {t("correspondence.filers")}
              </h2>
              <ul className="space-y-1 text-sm">
                {filers.map((filer) => {
                  if (filer.type === "shared_mailbox") {
                    return (
                      <li key={`${filer.type}-${filer.allowedSenderId}`}>
                        <bdi dir="auto">
                          {t("correspondence.sharedMailboxFiler", {
                            address: filer.address,
                            approver:
                              filer.approvedByStatus === "deleted"
                                ? t("tasks.deletedAccount")
                                : (filer.approvedByName ??
                                  t("correspondence.unknownApprover")),
                          })}
                        </bdi>
                      </li>
                    );
                  }

                  return (
                    <li key={`${filer.type}-${filer.userId}`}>
                      <bdi>
                        {filer.userStatus === "deleted"
                          ? t("tasks.deletedAccount")
                          : (filer.userName ?? t("common.unknownUser"))}
                      </bdi>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

// Back to the matter's correspondence view (the overview when the matter
// removed it). Until the matter's views are cached, the matter itself, which
// opens its first view.
const BackToCorrespondenceLink = ({ workspaceId }: { workspaceId: string }) => {
  const t = useTranslations();
  const viewIdQuery = useQuery({
    ...viewsOptions(workspaceId),
    select: (views) =>
      correspondenceViewId(selectAvailableWorkspaceViews(views)),
  });
  const viewIdView = useQueryView(viewIdQuery);
  useQueryViewError(viewIdView);
  const viewId = viewIdView.type === "items" ? viewIdView.items : null;
  const label = (
    <span className="text-muted-foreground hover:text-foreground flex min-h-11 items-center px-2 text-sm">
      {t("correspondence.backToList")}
    </span>
  );

  if (viewId === null) {
    return (
      <>
        {viewIdView.type !== "pending" && (
          <QueryViewFeedback view={viewIdView} />
        )}
        <MatterRefLink workspaceId={workspaceId}>{label}</MatterRefLink>
      </>
    );
  }
  return (
    <Link
      params={{ workspaceId, viewId }}
      to="/workspaces/$workspaceId/$viewId"
    >
      {label}
    </Link>
  );
};

const DetailField = ({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) => (
  <div className="min-w-0 space-y-1">
    <div className="text-muted-foreground text-xs">{label}</div>
    <div className="text-sm wrap-break-word">{children}</div>
  </div>
);

const Address = ({
  name,
  address,
}: {
  name: string | null;
  address: string;
}) => (
  <span>
    <bdi dir="auto">{name ?? address}</bdi>
    {name && (
      <>
        {" "}
        <span className="text-muted-foreground">
          &lt;<bdi dir="ltr">{address}</bdi>&gt;
        </span>
      </>
    )}
  </span>
);

const AddressList = ({
  addresses,
}: {
  addresses: { name: string | null; address: string }[];
}) => (
  <span className="flex flex-col gap-1">
    {uniqueCorrespondenceAddresses(addresses).map((address) => (
      <Address key={address.address.toLowerCase()} {...address} />
    ))}
  </span>
);
