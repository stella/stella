import { useState } from "react";

import { useInfiniteQuery } from "@tanstack/react-query";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";
import { Frame, FramePanel } from "@stll/ui/frame";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@stll/ui/table";

import { usePermissions } from "@/hooks/use-permissions";
import { useTimeBillingPreviewEnabled } from "@/hooks/use-time-billing-preview";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import {
  sellerProfilesKeys,
  sellerProfilesOptions,
  sendSellerProfileCommand,
} from "@/lib/organization/seller-profiles";
import type {
  SellerProfile,
  SellerProfileCommand,
  SellerProfileInput,
} from "@/lib/organization/seller-profiles";
import { SellerProfileForm } from "@/routes/_protected.settings/-components/organization/seller-profile-form";
import { SellerProfileRefusal } from "@/routes/_protected.settings/-components/organization/seller-profile-refusal";
import { useSettingsMutation } from "@/routes/_protected.settings/-hooks/use-settings-mutation";

type ProfileDialog =
  | { type: "closed" }
  | { type: "create" }
  | { type: "edit"; profile: SellerProfile }
  | { type: "archive"; profile: SellerProfile };

export const SellerProfilesCard = () => {
  const preview = useTimeBillingPreviewEnabled();
  const canUpdate = usePermissions({ organizationSettings: ["update"] });
  const user = useAuthenticatedUser();
  if (!preview || !canUpdate) {
    return null;
  }
  return (
    <SellerProfilesCardBody
      key={user.activeOrganizationId}
      organizationId={user.activeOrganizationId}
    />
  );
};

const SellerProfilesCardBody = ({
  organizationId,
}: {
  organizationId: string;
}) => {
  const t = useTranslations();
  const query = useInfiniteQuery(sellerProfilesOptions(organizationId));
  const [dialog, setDialog] = useState<ProfileDialog>({ type: "closed" });
  const mutation = useSettingsMutation({
    mutationFn: sendSellerProfileCommand,
    invalidate: sellerProfilesKeys.all(organizationId),
  });
  const profiles = query.data?.pages.flatMap((page) => page.items) ?? [];
  const close = () => {
    if (!mutation.isPending) {
      setDialog({ type: "closed" });
      mutation.reset();
    }
  };
  const run = async (command: SellerProfileCommand) => {
    if (mutation.isPending) {
      return;
    }
    const result = await Result.tryPromise(() => mutation.mutateAsync(command));
    if (Result.isOk(result)) {
      setDialog({ type: "closed" });
      mutation.reset();
    }
  };
  const save = async (values: SellerProfileInput) => {
    switch (dialog.type) {
      case "create":
        await run({ type: "create", values });
        return;
      case "edit":
        await run({ type: "update", id: dialog.profile.id, values });
        return;
      case "closed":
      case "archive":
        return;
    }
  };
  const open = (next: ProfileDialog) => {
    mutation.reset();
    setDialog(next);
  };

  return (
    <Frame>
      <FramePanel className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium">
              {t("billing.sellerProfiles.title")}
            </h2>
            <p className="text-muted-foreground text-sm">
              {t("billing.sellerProfiles.description")}
            </p>
          </div>
          <Button
            onClick={() => open({ type: "create" })}
            disabled={mutation.isPending}
          >
            {t("billing.sellerProfiles.add")}
          </Button>
        </div>
        {query.isPending && (
          <p className="text-muted-foreground text-sm">{t("common.loading")}</p>
        )}
        {query.error !== null && (
          <div className="flex items-center justify-between gap-2">
            <SellerProfileRefusal error={query.error} />
            <Button
              variant="outline"
              onClick={() => detached(query.refetch(), "seller-profiles.retry")}
            >
              {t("common.retry")}
            </Button>
          </div>
        )}
        {mutation.error !== null && dialog.type === "closed" && (
          <SellerProfileRefusal error={mutation.error} />
        )}
        {query.isSuccess && profiles.length === 0 && (
          <p className="text-muted-foreground text-sm">
            {t("billing.sellerProfiles.empty")}
          </p>
        )}
        {profiles.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("billing.sellerProfiles.legalName")}</TableHead>
                <TableHead>
                  {t("billing.sellerProfiles.defaultCurrency")}
                </TableHead>
                <TableHead>{t("common.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {profiles.map((profile) => (
                <TableRow key={profile.id}>
                  <TableCell>
                    <BidiText>{profile.legalName}</BidiText>
                    {profile.isDefault && (
                      <span className="text-muted-foreground ms-2 text-xs">
                        {t("billing.sellerProfiles.default")}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <BidiText>{profile.defaultCurrency}</BidiText>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={mutation.isPending}
                        onClick={() => open({ type: "edit", profile })}
                      >
                        {t("common.edit")}
                      </Button>
                      {!profile.isDefault && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={mutation.isPending}
                          onClick={() =>
                            detached(
                              run({ type: "default", id: profile.id }),
                              "seller-profiles.default",
                            )
                          }
                        >
                          {t("billing.sellerProfiles.setDefault")}
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={mutation.isPending}
                        onClick={() => open({ type: "archive", profile })}
                      >
                        {t("common.archive")}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {query.hasNextPage && (
          <Button
            variant="outline"
            disabled={query.isFetchingNextPage}
            onClick={() =>
              detached(query.fetchNextPage(), "seller-profiles.load-more")
            }
          >
            {t("common.loadMore")}
          </Button>
        )}
        <Dialog
          open={dialog.type !== "closed"}
          onOpenChange={(isOpen) => {
            if (!isOpen) {
              close();
            }
          }}
        >
          {dialog.type !== "closed" && (
            <DialogPopup className="max-w-xl">
              <DialogHeader>
                <DialogTitle>
                  {dialog.type === "create" && t("billing.sellerProfiles.add")}
                  {dialog.type === "archive" && t("common.archive")}
                  {dialog.type === "edit" && t("billing.sellerProfiles.edit")}
                </DialogTitle>
              </DialogHeader>
              {mutation.error !== null && (
                <DialogPanel>
                  <SellerProfileRefusal error={mutation.error} />
                </DialogPanel>
              )}
              {dialog.type === "archive" ? (
                <>
                  <DialogPanel className="flex flex-col gap-4">
                    <p className="text-sm">
                      {t("billing.sellerProfiles.archiveConfirm")}
                    </p>
                    <BidiText>{dialog.profile.legalName}</BidiText>
                  </DialogPanel>
                  <DialogFooter>
                    <Button
                      variant="outline"
                      disabled={mutation.isPending}
                      onClick={close}
                    >
                      {t("common.cancel")}
                    </Button>
                    <Button
                      variant="destructive"
                      disabled={mutation.isPending}
                      onClick={() =>
                        detached(
                          run({ type: "archive", id: dialog.profile.id }),
                          "seller-profiles.archive",
                        )
                      }
                    >
                      {t("common.archive")}
                    </Button>
                  </DialogFooter>
                </>
              ) : (
                <SellerProfileForm
                  key={dialog.type === "edit" ? dialog.profile.id : "new"}
                  {...(dialog.type === "edit"
                    ? { profile: dialog.profile }
                    : {})}
                  pending={mutation.isPending}
                  onCancel={close}
                  onSubmit={save}
                />
              )}
            </DialogPopup>
          )}
        </Dialog>
      </FramePanel>
    </Frame>
  );
};
