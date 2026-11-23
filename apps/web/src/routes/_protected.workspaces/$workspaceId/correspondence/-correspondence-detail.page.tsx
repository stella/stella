import { lazy, Suspense } from "react";

import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import type { CorrespondenceAuthentication } from "@stll/api-contract/correspondence";
import { Button } from "@stll/ui/button";
import { TruncatedText } from "@stll/ui/truncated-text";

import { MatterRefLink } from "@/components/matter-ref-link";
import { QueryViewFeedback } from "@/components/query-view-feedback";
import { CorrespondenceAttachments } from "@/features/correspondence/correspondence-attachments";
import { DataBoxEnvelope } from "@/features/correspondence/data-box-envelope";
import { usePermissions } from "@/hooks/use-permissions";
import { useFormatter } from "@/i18n/formatting-context";
import { queryView } from "@/lib/query-view.logic";
import { MEDIUM_DATE_SHORT_TIME_FORMAT } from "@/lib/relative-time";
import { useQueryViewError } from "@/lib/use-query-view";
import {
  CORRESPONDENCE_AUTH_LABEL_KEYS,
  correspondenceByIdOptions,
  uniqueCorrespondenceAddresses,
} from "@/lib/workspaces/queries/correspondence";
import { viewsOptions } from "@/lib/workspaces/queries/views";
import { selectAvailableWorkspaceViews } from "@/lib/workspaces/queries/views.logic";
import { correspondenceViewId } from "@/lib/workspaces/view-layout";
import { CorrespondenceAssigneeField } from "@/routes/_protected.workspaces/$workspaceId/-components/correspondence-assignee-field";
import { CorrespondenceProvenance } from "@/routes/_protected.workspaces/$workspaceId/-components/correspondence-provenance";
import { correspondenceProvenancePresentation } from "@/routes/_protected.workspaces/$workspaceId/-components/correspondence-provenance.logic";
import { UploadedSource } from "@/routes/_protected.workspaces/$workspaceId/-components/uploaded-mail-source";
import { useUpdateCorrespondence } from "@/routes/_protected.workspaces/$workspaceId/-mutations/correspondence";

import {
  BackToListLabel,
  BodySectionHeading,
  CorrespondenceDetailShell,
  CorrespondenceSection,
  DetailField,
  FIELDS_HEADING_CLASS,
  HANDLING_BUTTON,
  handlingActionLabelKey,
} from "./-correspondence-detail.pending";

// Only a certified email record needs its envelope; its strings load with it.
const CertifiedEmailEnvelope = lazy(async () => {
  const m =
    await import("@/features/correspondence/certified-email/certified-email-envelope");
  return { default: m.CertifiedEmailEnvelope };
});

const routeApi = getRouteApi(
  "/_protected/workspaces/$workspaceId/correspondence/$correspondenceId",
);

/** The delivery checks a delivered message shows, in the order they read. */
const AUTHENTICATION_CHECKS: readonly Exclude<
  keyof CorrespondenceAuthentication,
  "alignedIdentifier"
>[] = ["spf", "dkim", "dmarc"];

/** A filed message: how it came in, its envelope, its body and who filed it. */
export function CorrespondenceDetailPage() {
  const t = useTranslations();
  const format = useFormatter();
  const { workspaceId, correspondenceId } = routeApi.useParams({
    select: (params) => ({
      workspaceId: params.workspaceId,
      correspondenceId: params.correspondenceId,
    }),
  });
  const { data } = useSuspenseQuery(
    correspondenceByIdOptions(workspaceId, correspondenceId),
  );
  const { record, filers, attachments, dataBoxContacts } = data;
  const provenance = correspondenceProvenancePresentation(record);
  const update = useUpdateCorrespondence();
  const canUpdate = usePermissions({ workspace: ["update"] });

  return (
    <CorrespondenceDetailShell
      action={
        canUpdate && (
          <Button
            className="min-h-11"
            disabled={update.isPending}
            disabledReason={t("common.saving")}
            onClick={() =>
              update.mutate({
                workspaceId,
                correspondenceId,
                type: "set_handling",
                handlingState:
                  record.handlingState === "new" ? "handled" : "new",
              })
            }
            size={HANDLING_BUTTON.size}
            variant={HANDLING_BUTTON.variant}
          >
            {t(handlingActionLabelKey(record.handlingState))}
          </Button>
        )
      }
      back={<BackToCorrespondenceLink workspaceId={workspaceId} />}
      title={
        <TruncatedText>
          <bdi dir="auto">{record.subject || t("emailViewer.noSubject")}</bdi>
        </TruncatedText>
      }
    >
      {record.source === "delivery" ? (
        <CorrespondenceSection>
          <h2 className="text-sm font-medium">
            {t("correspondence.deliveryAuthentication")}
          </h2>
          <CorrespondenceProvenance record={record} />
          <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {AUTHENTICATION_CHECKS.map((check) => (
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
        </CorrespondenceSection>
      ) : (
        <UploadedSource
          channel={record.channel}
          uploader={filers.find((filer) => filer.type === "user")}
          signatureDomain={provenance.signatureDomain}
          sourceEntityId={record.sourceEntityId}
          workspaceId={workspaceId}
        />
      )}
      {record.channel === "pec" && (
        <Suspense fallback={null}>
          <CertifiedEmailEnvelope envelope={record.certifiedEmail} />
        </Suspense>
      )}
      {record.channel === "data_box" ? (
        <DataBoxEnvelope contacts={dataBoxContacts} envelope={record.dataBox} />
      ) : (
        <CorrespondenceSection layout="fields">
          {provenance.assertedHeadersLabel !== null && (
            <h2 className={FIELDS_HEADING_CLASS}>
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
        </CorrespondenceSection>
      )}
      <CorrespondenceSection layout="fields">
        <DetailField label={t("correspondence.receivedAt")}>
          {format.dateTime(
            new Date(record.receivedAt),
            MEDIUM_DATE_SHORT_TIME_FORMAT,
          )}
        </DetailField>
        <DetailField label={t("common.assignee")}>
          <CorrespondenceAssigneeField
            assigneeId={record.assigneeId}
            correspondenceId={correspondenceId}
            workspaceId={workspaceId}
          />
        </DetailField>
      </CorrespondenceSection>

      {(record.channel === "email" || record.channel === "pec") && (
        <CorrespondenceSection layout="plain">
          <BodySectionHeading>{t("emailViewer.bodyTitle")}</BodySectionHeading>
          {record.bodyHtml === null ? (
            <pre
              className="text-foreground font-sans text-sm leading-6 wrap-break-word whitespace-pre-wrap"
              dir="auto"
            >
              {record.bodyText}
            </pre>
          ) : (
            <iframe
              className="h-[28rem] w-full rounded-sm border"
              referrerPolicy="no-referrer"
              sandbox=""
              // safe-html: sanitizeEmailBodyHtml in apps/api/src/lib/files/email-to-html.ts strips active content; the iframe sandbox omits script permission.
              srcDoc={record.bodyHtml}
              title={t("emailViewer.bodyTitle")}
            />
          )}
        </CorrespondenceSection>
      )}

      <CorrespondenceAttachments
        files={attachments.map(
          ({ entityId, filename, mediaType, byteSize }) => ({
            entityId,
            fileName: filename,
            mediaType,
            byteSize,
          }),
        )}
        workspaceId={workspaceId}
      />

      {filers.length > 0 && (
        <CorrespondenceSection layout="plain">
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
        </CorrespondenceSection>
      )}
    </CorrespondenceDetailShell>
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
  const viewIdView = queryView(viewIdQuery);
  useQueryViewError(viewIdView, "BackToCorrespondenceLink:query");
  const viewId = viewIdView.type === "items" ? viewIdView.items : null;
  const label = (
    <BackToListLabel>{t("correspondence.backToList")}</BackToListLabel>
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
