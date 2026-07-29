import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  CalendarClockIcon,
  CheckIcon,
  CircleCheckIcon,
  CopyIcon,
  EyeIcon,
  FileCheck2Icon,
  FileTextIcon,
  KeyRoundIcon,
  Link2Icon,
  MailIcon,
  ShieldCheckIcon,
  SparklesIcon,
} from "lucide-react";
import { useFormatter, useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/components/bidi-text";
import { Button } from "@stll/ui/components/button";
import { Checkbox } from "@stll/ui/components/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/components/dialog";
import { Input } from "@stll/ui/components/input";
import { Label } from "@stll/ui/components/label";
import { Separator } from "@stll/ui/components/separator";
import { stellaToast } from "@stll/ui/components/toast";

import { DatePickerPopover } from "@/components/date-picker-popover";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { toSafeId } from "@/lib/safe-id";
import { entityVersionsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/entity-versions";

type ShareDocumentDialogProps = {
  entityId: string;
  entityName: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  workspaceId: string;
};

export const ShareDocumentDialog = ({
  entityId,
  entityName,
  onOpenChange,
  open,
  workspaceId,
}: ShareDocumentDialogProps) => {
  const t = useTranslations();
  const formatter = useFormatter();
  const navigate = useNavigate();
  const versionsQuery = useQuery({
    ...entityVersionsOptions({ workspaceId, entityId }),
    enabled: open,
  });
  const [recipientEmail, setRecipientEmail] = useState("");
  const [allowDownload, setAllowDownload] = useState(false);
  const [expiresAt, setExpiresAt] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{
    shareSpaceId: string;
    invitationUrl: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setRecipientEmail("");
      setAllowDownload(false);
      setExpiresAt("");
      setResult(null);
      setCopied(false);
    }
    onOpenChange(nextOpen);
  };

  const currentVersion = versionsQuery.data?.versions.find(
    (version) => version.id === versionsQuery.data.currentVersionId,
  );
  const recipientInitial = recipientEmail.trim().charAt(0).toUpperCase();
  const securityPromises = [
    { Icon: ShieldCheckIcon, label: t("sharing.dialog.promiseOtp") },
    { Icon: FileCheck2Icon, label: t("sharing.dialog.promiseSnapshot") },
    { Icon: Link2Icon, label: t("sharing.dialog.promiseAudit") },
  ];

  const publish = async () => {
    if (!currentVersion?.file) {
      return;
    }
    setPending(true);
    try {
      const published = unwrapEden(
        await api["workspaces"]({
          workspaceId: toSafeId<"workspace">(workspaceId),
        })["share-spaces"]["publish-document"].post({
          entityId: toSafeId<"entity">(entityId),
          entityVersionId: toSafeId<"entityVersion">(currentVersion.id),
          fieldId: toSafeId<"field">(currentVersion.file.fieldId),
          recipientEmail,
          downloadPolicy: allowDownload ? "allowed" : "blocked",
          expiresAt: expiresAt
            ? new Date(`${expiresAt}T23:59:59.999`).toISOString()
            : null,
        }),
      );
      setResult({
        shareSpaceId: published.shareSpaceId,
        invitationUrl: `${window.location.origin}/share/${published.invitationSecret}`,
      });
    } catch (error) {
      stellaToast.add({
        title: userErrorFromThrown(error, t("sharing.dialog.publishFailed")),
        type: "error",
      });
    } finally {
      setPending(false);
    }
  };

  const copyInvitation = async () => {
    if (!result) {
      return false;
    }
    try {
      await navigator.clipboard.writeText(result.invitationUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      return true;
    } catch {
      stellaToast.add({
        title: t("sharing.dialog.copyFailed"),
        type: "error",
      });
      return false;
    }
  };

  const revoke = async () => {
    if (!result) {
      return;
    }
    setPending(true);
    try {
      unwrapEden(
        await api["workspaces"]({
          workspaceId: toSafeId<"workspace">(workspaceId),
        })
          ["share-spaces"]({
            shareSpaceId: toSafeId<"shareSpace">(result.shareSpaceId),
          })
          .revoke.post(),
      );
      stellaToast.add({
        title: t("sharing.dialog.revokedToast"),
        type: "success",
      });
      handleOpenChange(false);
    } catch (error) {
      stellaToast.add({
        title: userErrorFromThrown(error, t("sharing.dialog.revokeFailed")),
        type: "error",
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogPopup className="sm:max-w-2xl">
        <DialogHeader className="border-border/70 bg-muted/35 border-b pb-5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="text-primary flex items-center gap-2 text-xs font-semibold tracking-wide uppercase">
              <ShieldCheckIcon className="size-4" />
              {t("sharing.dialog.eyebrow")}
            </div>
            <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <span
                className={
                  result
                    ? "size-2 rounded-full bg-[var(--option-emerald-fg)]"
                    : "bg-primary size-2 rounded-full"
                }
              />
              {result
                ? t("sharing.dialog.stepReady")
                : t("sharing.dialog.stepConfigure")}
            </div>
          </div>
          <DialogTitle className="text-2xl">
            {result
              ? t("sharing.dialog.readyTitle")
              : t("sharing.dialog.title")}
          </DialogTitle>
          <DialogDescription>
            {result
              ? t("sharing.dialog.readyDescription", {
                  email: recipientEmail,
                })
              : t("sharing.dialog.description", { name: entityName })}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-5 py-5">
          {result ? (
            <>
              <div className="flex flex-col items-center py-2 text-center">
                <div className="relative mb-4">
                  <div className="flex size-16 items-center justify-center rounded-2xl bg-[var(--option-emerald-bg)] text-[var(--option-emerald-fg)] shadow-sm">
                    <CircleCheckIcon className="size-8" />
                  </div>
                  <SparklesIcon className="text-primary absolute -end-3 -top-2 size-5" />
                </div>
                <p className="font-heading text-lg font-semibold">
                  {t("sharing.dialog.linkCreated")}
                </p>
                <p className="text-muted-foreground mt-1 max-w-md text-sm">
                  {t("sharing.dialog.publishing")}
                </p>
              </div>
              <div className="border-border bg-muted/30 rounded-xl border p-3">
                <Label className="text-muted-foreground mb-2 block text-xs font-medium">
                  {t("sharing.dialog.invitationLink")}
                </Label>
                <div className="flex gap-2">
                  <Input
                    className="bg-background font-mono text-xs"
                    readOnly
                    value={result.invitationUrl}
                  />
                  <Button
                    aria-label={t("sharing.dialog.copyLink")}
                    className="min-w-28"
                    onClick={() =>
                      detached(copyInvitation(), "ShareDocumentDialog.copy")
                    }
                  >
                    {copied ? <CheckIcon /> : <CopyIcon />}
                    {copied
                      ? t("sharing.dialog.copied")
                      : t("sharing.dialog.copyLink")}
                  </Button>
                </div>
                <p className="text-muted-foreground mt-2 flex items-start gap-1.5 text-xs">
                  <KeyRoundIcon className="mt-0.5 size-3.5 shrink-0" />
                  {t("sharing.dialog.copyHint")}
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="border-border rounded-lg border p-3">
                  <MailIcon className="text-primary mb-2 size-4" />
                  <p className="text-muted-foreground text-xs">
                    {t("sharing.dialog.recipientLabel")}
                  </p>
                  <BidiText
                    as="p"
                    className="mt-0.5 truncate text-sm font-medium"
                  >
                    {recipientEmail}
                  </BidiText>
                </div>
                <div className="border-border rounded-lg border p-3">
                  <CalendarClockIcon className="text-primary mb-2 size-4" />
                  <p className="text-muted-foreground text-xs">
                    {t("sharing.dialog.expirationLabel")}
                  </p>
                  <p className="mt-0.5 text-sm font-medium">
                    {expiresAt
                      ? formatter.dateTime(
                          new Date(`${expiresAt}T23:59:59.999`),
                          { dateStyle: "medium" },
                        )
                      : t("sharing.dialog.untilRevoked")}
                  </p>
                </div>
                <div className="border-border rounded-lg border p-3">
                  <EyeIcon className="text-primary mb-2 size-4" />
                  <p className="text-muted-foreground text-xs">
                    {t("sharing.dialog.accessLabel")}
                  </p>
                  <p className="mt-0.5 text-sm font-medium">
                    {allowDownload
                      ? t("sharing.dialog.viewAndDownload")
                      : t("folio.viewOnly")}
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3 rounded-lg bg-[var(--option-emerald-bg)]/50 p-3 text-sm text-[var(--option-emerald-fg)]">
                <ShieldCheckIcon className="mt-0.5 size-4 shrink-0" />
                <span>{t("sharing.dialog.securityReady")}</span>
              </div>
            </>
          ) : (
            <>
              <div className="border-border bg-muted/25 flex items-center gap-3 rounded-xl border p-3.5">
                <div className="bg-background text-primary flex size-10 shrink-0 items-center justify-center rounded-lg border shadow-xs">
                  <FileTextIcon className="size-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <BidiText as="p" className="truncate text-sm font-semibold">
                    {entityName}
                  </BidiText>
                  <p className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 text-xs">
                    <span>
                      {t("sharing.dialog.version", {
                        version: String(
                          currentVersion?.stamp ??
                            currentVersion?.versionNumber ??
                            "—",
                        ),
                      })}
                    </span>
                    {currentVersion?.file ? (
                      <>
                        <span aria-hidden>·</span>
                        <BidiText as="span" className="truncate">
                          {currentVersion.file.fileName}
                        </BidiText>
                      </>
                    ) : null}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--option-emerald-bg)] px-2.5 py-1 text-xs font-medium text-[var(--option-emerald-fg)]">
                  <FileCheck2Icon className="size-3.5" />
                  {t("sharing.dialog.exactSnapshot")}
                </div>
              </div>
              <div>
                <div className="mb-3 flex items-center gap-2">
                  <div className="bg-primary text-primary-foreground flex size-6 items-center justify-center rounded-full text-xs font-semibold">
                    1
                  </div>
                  <p className="text-sm font-semibold">
                    {t("sharing.dialog.whoCanOpen")}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <div className="bg-muted text-muted-foreground flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold uppercase">
                    {recipientInitial || <MailIcon className="size-4" />}
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <Label className="sr-only" htmlFor="share-recipient-email">
                      {t("sharing.dialog.recipientEmail")}
                    </Label>
                    <Input
                      autoComplete="email"
                      autoFocus
                      id="share-recipient-email"
                      placeholder={t("sharing.dialog.recipientPlaceholder")}
                      type="email"
                      value={recipientEmail}
                      onChange={(event) =>
                        setRecipientEmail(event.target.value)
                      }
                    />
                    <p className="text-muted-foreground text-xs">
                      {t("sharing.dialog.recipientHint")}
                    </p>
                  </div>
                </div>
              </div>
              <Separator />
              <div>
                <div className="mb-3 flex items-center gap-2">
                  <div className="bg-primary text-primary-foreground flex size-6 items-center justify-center rounded-full text-xs font-semibold">
                    2
                  </div>
                  <p className="text-sm font-semibold">
                    {t("sharing.dialog.chooseAccess")}
                  </p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="border-border rounded-xl border p-3.5">
                    <div className="mb-3 flex items-center gap-2">
                      <CalendarClockIcon className="text-primary size-4" />
                      <Label>{t("sharing.dialog.expiresAt")}</Label>
                    </div>
                    <DatePickerPopover
                      onChange={(date) => setExpiresAt(date ?? "")}
                      value={expiresAt}
                    />
                    <p className="text-muted-foreground mt-2 text-xs">
                      {t("sharing.dialog.expiresHint")}
                    </p>
                  </div>
                  <label
                    className="border-border hover:bg-muted/30 flex cursor-pointer items-start gap-3 rounded-xl border p-3.5 transition-colors"
                    htmlFor="share-allow-download"
                  >
                    <Checkbox
                      checked={allowDownload}
                      className="mt-0.5"
                      id="share-allow-download"
                      onCheckedChange={setAllowDownload}
                    />
                    <span>
                      <span className="flex items-center gap-2 text-sm font-medium">
                        <EyeIcon className="text-primary size-4" />
                        {t("sharing.dialog.allowDownload")}
                      </span>
                      <span className="text-muted-foreground mt-1 block text-xs">
                        {t("sharing.dialog.downloadHint")}
                      </span>
                    </span>
                  </label>
                </div>
              </div>
              <div className="bg-primary/5 border-primary/15 grid gap-2 rounded-xl border p-3.5 sm:grid-cols-3">
                {securityPromises.map(({ Icon, label }) => (
                  <div
                    className="text-muted-foreground flex items-center gap-2 text-xs"
                    key={label}
                  >
                    <Icon className="text-primary size-4 shrink-0" />
                    <span>{label}</span>
                  </div>
                ))}
              </div>
              {versionsQuery.isError ? (
                <p className="text-destructive text-sm">
                  {t("sharing.dialog.loadFailed")}
                </p>
              ) : null}
            </>
          )}
        </DialogPanel>
        <DialogFooter>
          {result ? (
            <>
              <Button
                disabled={pending}
                onClick={() => detached(revoke(), "ShareDocumentDialog.revoke")}
                variant="ghost"
              >
                {t("sharing.dialog.revoke")}
              </Button>
              <Button
                onClick={() =>
                  detached(
                    copyInvitation().then((didCopy) => {
                      if (didCopy) {
                        handleOpenChange(false);
                      }
                      return didCopy;
                    }),
                    "ShareDocumentDialog.copyAndClose",
                  )
                }
              >
                <CopyIcon />
                {t("sharing.dialog.copyAndClose")}
              </Button>
            </>
          ) : (
            <>
              <Button
                disabled={pending}
                onClick={() => {
                  handleOpenChange(false);
                  detached(
                    navigate({
                      to: "/workspaces/$workspaceId/shares",
                      params: { workspaceId },
                    }),
                    "ShareDocumentDialog.manage",
                  );
                }}
                variant="ghost"
              >
                {t("sharing.dialog.manage")}
              </Button>
              <Button
                disabled={
                  pending ||
                  recipientEmail.trim().length === 0 ||
                  !currentVersion?.file
                }
                loading={pending || versionsQuery.isPending}
                onClick={() =>
                  detached(publish(), "ShareDocumentDialog.publish")
                }
              >
                <ShieldCheckIcon />
                {t("sharing.dialog.publish")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
};
