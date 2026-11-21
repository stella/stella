import { useState } from "react";
import type { ReactNode } from "react";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { SESSION_SIGN_IN_REVIEW } from "@stll/api-contract/session-sign-ins";
import { Badge } from "@stll/ui/badge";
import { Button } from "@stll/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "@stll/ui/dialog";
import {
  type EntityAction,
  EntityActions,
  EntityActionsButton,
} from "@stll/ui/entity-actions";
import {
  LaptopIcon,
  type LucideIcon,
  MonitorIcon,
  SmartphoneIcon,
  TabletIcon,
} from "@stll/ui/icons";
import { ListEmpty, ListItemMedia, ListItemStatus } from "@stll/ui/list";
import { Popover, PopoverPopup, PopoverTrigger } from "@stll/ui/popover";
import { SettingsRow, SettingsSection } from "@stll/ui/settings";
import { stellaToast } from "@stll/ui/toast";
import { DEVICE_KIND, type DeviceKind } from "@stll/user-agent";

import { useFormatter, useRelativeTime } from "@/i18n/formatting-context";
import { useAnalytics } from "@/lib/analytics/provider";
import { authClient } from "@/lib/auth-client";
import { detached } from "@/lib/detached";
import { toAuthClientError } from "@/lib/errors/auth";
import { notifyUserError } from "@/lib/errors/user-toast";
import { MEDIUM_DATE_FORMAT } from "@/lib/relative-time";
import { resourceMutation } from "@/lib/workspace-realtime";
import type { SignedInDevice } from "@/routes/_protected.settings/-account.security.logic";
import { SIGNED_IN_DEVICES_SECTION_ID } from "@/routes/_protected.settings/-account.security.pending";
import { useDeviceWording } from "@/routes/_protected.settings/-components/account/security/device-wording";
import { SignInMap } from "@/routes/_protected.settings/-components/account/security/sign-in-map";

const DEVICE_KIND_ICON = {
  [DEVICE_KIND.phone]: SmartphoneIcon,
  [DEVICE_KIND.tablet]: TabletIcon,
  [DEVICE_KIND.computer]: LaptopIcon,
  [DEVICE_KIND.desktopApp]: MonitorIcon,
  [DEVICE_KIND.unknown]: LaptopIcon,
} as const satisfies Record<DeviceKind, LucideIcon>;

type SignedInDevicesProps = {
  current: SignedInDevice | undefined;
  others: readonly SignedInDevice[];
};

/** This device, then every other signed-in device with its actions. */
export const SignedInDevices = ({ current, others }: SignedInDevicesProps) => {
  const t = useTranslations();
  return (
    <SettingsSection
      action={others.length > 0 ? <SignOutOtherDevicesDialog /> : undefined}
      className="scroll-mt-6"
      description={t("settings.account.security.devicesDescription")}
      id={SIGNED_IN_DEVICES_SECTION_ID}
      title={t("settings.account.security.devicesTitle")}
    >
      {current !== undefined && <ThisDeviceRow device={current} />}
      {others.length === 0 ? (
        <ListEmpty>{t("settings.account.security.noOtherDevices")}</ListEmpty>
      ) : (
        others.map((device) => (
          <OtherDeviceRow device={device} key={device.id} />
        ))
      )}
    </SettingsSection>
  );
};

const DeviceKindIcon = ({ kind }: { kind: DeviceKind }) => {
  const Icon = DEVICE_KIND_ICON[kind];
  return <Icon aria-hidden="true" />;
};

/** A row's media tile: the device kind's icon. */
const DeviceMedia = ({ kind }: { kind: DeviceKind }) => (
  <ListItemMedia>
    <DeviceKindIcon kind={kind} />
  </ListItemMedia>
);

type DetailPart = { key: string; content: ReactNode };

/** Parts of a row's secondary line, divided by middle dots. */
const DetailLine = ({ parts }: { parts: readonly DetailPart[] }) =>
  parts.map(({ key, content }, index) => (
    <span key={key}>
      {index > 0 && <span aria-hidden="true"> · </span>}
      {content}
    </span>
  ));

const ThisDeviceRow = ({ device }: { device: SignedInDevice }) => {
  const t = useTranslations();
  const format = useFormatter();
  const { deviceLabel, placeLabel } = useDeviceWording();
  const parts: DetailPart[] = [
    {
      key: "place",
      content: (
        <bdi>
          {device.location.type === "known"
            ? placeLabel(device.location)
            : t("settings.account.security.unknownLocation")}
        </bdi>
      ),
    },
    ...(device.ipAddress === null
      ? []
      : [{ key: "address", content: <bdi dir="ltr">{device.ipAddress}</bdi> }]),
    {
      key: "signedInAt",
      content: t("settings.account.security.signedInAt", {
        date: format.dateTime(device.signedInAt, MEDIUM_DATE_FORMAT),
      }),
    },
  ];
  return (
    <SettingsRow
      description={<DetailLine parts={parts} />}
      media={<DeviceMedia kind={device.kind} />}
      title={
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <bdi>{deviceLabel(device.name)}</bdi>
          <Badge>{t("settings.account.security.thisDevice")}</Badge>
        </span>
      }
    >
      <ListItemStatus tone="success">
        {t("settings.account.security.activeNow")}
      </ListItemStatus>
    </SettingsRow>
  );
};

const OtherDeviceRow = ({ device }: { device: SignedInDevice }) => {
  const t = useTranslations();
  const navigate = useNavigate();
  const relativeTime = useRelativeTime();
  const { deviceLabel } = useDeviceWording();
  const signOut = useSignOutDevice();
  const name = deviceLabel(device.name);
  const pending = device.review === SESSION_SIGN_IN_REVIEW.pending;

  const actions: EntityAction[] = [
    ...(pending
      ? [
          {
            label: t("settings.account.security.reviewAction"),
            onClick: () =>
              detached(
                navigate({
                  to: "/settings/account/security",
                  search: { review: device.id },
                }),
                "security.review-device",
              ),
          },
        ]
      : []),
    {
      label: t("common.signOut"),
      variant: "destructive",
      disabled: signOut.isPending,
      onClick: () => signOut.mutate(device.id),
    },
  ];

  return (
    <EntityActions
      actions={actions}
      label={t("settings.account.security.deviceActions", { device: name })}
    >
      <SettingsRow
        description={
          <DetailLine
            parts={[
              { key: "place", content: <DevicePlace device={device} /> },
              {
                key: "activity",
                content:
                  device.originClientName === null
                    ? relativeTime(device.lastActiveAt)
                    : t("account.sessions.signedInFrom", {
                        clientName: device.originClientName,
                      }),
              },
            ]}
          />
        }
        media={<DeviceMedia kind={device.kind} />}
        title={
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <bdi>{name}</bdi>
            {pending && (
              <Badge tone="warning">
                {t("settings.account.security.newBadge")}
              </Badge>
            )}
          </span>
        }
      >
        <EntityActionsButton />
      </SettingsRow>
    </EntityActions>
  );
};

/**
 * The sign-in place. With coordinates it opens a small map on hover, focus
 * or press; the image is requested only once the popover opens.
 */
const DevicePlace = ({ device }: { device: SignedInDevice }) => {
  const t = useTranslations();
  const { placeLabel } = useDeviceWording();
  const { location } = device;
  switch (location.type) {
    case "unknown":
      return t("settings.account.security.unknownLocation");
    case "known": {
      const place = placeLabel(location);
      if (location.coordinates === null) {
        return (
          <bdi>
            {t("settings.account.security.placeApproximate", { place })}
          </bdi>
        );
      }
      return (
        <Popover>
          <PopoverTrigger
            delay={150}
            openOnHover
            render={<Button size="inline" variant="link" />}
          >
            <bdi>{place}</bdi>
          </PopoverTrigger>
          <PopoverPopup
            aria-label={t("settings.account.security.mapLabel", { place })}
            className="w-80"
          >
            <div className="flex flex-col gap-2">
              <SignInMap
                alt={t("settings.account.security.mapLabel", { place })}
                className="aspect-2/1 w-full rounded-lg object-cover outline-1 -outline-offset-1 outline-black/5"
                sessionId={device.id}
              />
              <span className="text-muted-foreground flex justify-between gap-2 text-xs">
                <bdi>
                  {t("settings.account.security.placeApproximate", { place })}
                </bdi>
                {device.ipAddress !== null && (
                  <bdi dir="ltr">{device.ipAddress}</bdi>
                )}
              </span>
            </div>
          </PopoverPopup>
        </Popover>
      );
    }
    default:
      location satisfies never;
      return panic("Unknown sign-in location kind");
  }
};

/** Signs one device out; its resource contract refreshes the account's lists. */
export const useSignOutDevice = (onSignedOut?: (sessionId: string) => void) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: resourceMutation({
      mutation: "revokeSession",
      queryClient,
      scope: { type: "organization" },
      mutationFn: async (sessionId: string) => {
        const result = await authClient.revokeSessionById({ sessionId });
        if (result.error) {
          throw toAuthClientError(result.error);
        }
        // The outcome lands before the refreshed lists drop the device.
        onSignedOut?.(sessionId);
        return sessionId;
      },
    }),
    onSuccess: () => {
      stellaToast.add({ title: t("success.sessionRevoked"), type: "success" });
    },
    onError: (error) => {
      analytics.captureError(error, {
        fingerprintKey: "SignedInDevices:signOut",
        scope: { type: "handler", handlerId: "SignedInDevices:signOut" },
      });
      notifyUserError(error, t("errors.actionFailed"));
    },
  });
};

const SignOutOtherDevicesDialog = () => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const analytics = useAnalytics();
  const [isOpen, setIsOpen] = useState(false);

  const signOutOthers = useMutation({
    mutationFn: resourceMutation({
      mutation: "revokeOtherSessions",
      queryClient,
      scope: { type: "organization" },
      mutationFn: async () => {
        const result = await authClient.revokeOtherSessions();
        if (result.error) {
          throw toAuthClientError(result.error);
        }
        return result.data;
      },
    }),
    onSuccess: () => {
      stellaToast.add({
        title: t("success.otherSessionsRevoked"),
        type: "success",
      });
    },
    onError: (error) => {
      analytics.captureError(error, {
        fingerprintKey: "SignedInDevices:signOutOthers",
        scope: { type: "handler", handlerId: "SignedInDevices:signOutOthers" },
      });
      notifyUserError(error, t("errors.actionFailed"));
    },
    onSettled: () => setIsOpen(false),
  });

  return (
    <Dialog onOpenChange={setIsOpen} open={isOpen}>
      <DialogTrigger
        render={
          <Button
            disabled={signOutOthers.isPending}
            disabledReason={t("settings.account.revokingSessions")}
            size="sm"
            variant="outline"
          />
        }
      >
        {t("account.sessions.revokeOtherSessions")}
      </DialogTrigger>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{t("account.sessions.revokeOtherSessions")}</DialogTitle>
          <DialogDescription>
            {t("account.sessions.revokeOtherSessionsConfirm")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            {t("common.cancel")}
          </DialogClose>
          <Button
            loading={signOutOthers.isPending}
            onClick={() => signOutOthers.mutate()}
            variant="destructive"
          >
            {t("account.sessions.revokeOtherSessions")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
};
