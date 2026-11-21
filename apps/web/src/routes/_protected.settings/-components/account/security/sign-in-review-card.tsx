import { useMutation, useQueryClient } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { SESSION_SIGN_IN_REVIEW } from "@stll/api-contract/session-sign-ins";
import { Badge } from "@stll/ui/badge";
import { Button } from "@stll/ui/button";
import { DetailsGrid, DetailsItem } from "@stll/ui/details-grid";
import { CircleCheckIcon } from "@stll/ui/icons";

import { useFormatter, useRelativeTime } from "@/i18n/formatting-context";
import { reviewSessionSignIn } from "@/lib/account/session-sign-ins";
import { useAnalytics } from "@/lib/analytics/provider";
import { notifyUserError } from "@/lib/errors/user-toast";
import { MEDIUM_DATE_SHORT_TIME_FORMAT } from "@/lib/relative-time";
import { resourceMutation } from "@/lib/workspace-realtime";
import type {
  ReviewCardState,
  SignedInDevice,
} from "@/routes/_protected.settings/-account.security.logic";
import { useDeviceWording } from "@/routes/_protected.settings/-components/account/security/device-wording";
import { SignInMap } from "@/routes/_protected.settings/-components/account/security/sign-in-map";
import { SIGN_IN_METHODS_SECTION_ID } from "@/routes/_protected.settings/-components/account/sign-in-methods.pending";

type SignInReviewCardProps = {
  state: ReviewCardState;
  /** Signs the reviewed device out; the page remembers the outcome. */
  onSignOut: (device: SignedInDevice) => void;
  signOutPending: boolean;
  /** Leaves the review, back to the page without a target. */
  onDismiss: () => void;
};

/**
 * "Was this you?" for the sign-in the new-device email linked to: confirm
 * it (and undo that), or sign the device out and see what to check next.
 */
export const SignInReviewCard = ({
  state,
  onSignOut,
  signOutPending,
  onDismiss,
}: SignInReviewCardProps) => {
  const t = useTranslations();
  const { deviceLabel } = useDeviceWording();
  const decide = useReviewDecision();

  switch (state.type) {
    case "none":
      return null;
    case "ask":
      return (
        <AskCard
          decisionPending={decide.isPending}
          device={state.device}
          onConfirm={() =>
            decide.mutate({
              sessionId: state.device.id,
              review: SESSION_SIGN_IN_REVIEW.confirmed,
            })
          }
          onSignOut={() => onSignOut(state.device)}
          signOutPending={signOutPending}
        />
      );
    case "confirmed":
      return (
        <div
          className="bg-muted/60 flex flex-wrap items-center gap-2.5 rounded-xl px-4 py-3 text-sm"
          role="status"
        >
          <CircleCheckIcon
            aria-hidden="true"
            className="text-success size-4 shrink-0"
          />
          <span className="min-w-0 flex-1 text-pretty">
            {t("settings.account.security.reviewConfirmed", {
              device: deviceLabel(state.device.name),
            })}
          </span>
          <Button
            loading={decide.isPending}
            onClick={() =>
              decide.mutate({
                sessionId: state.device.id,
                review: SESSION_SIGN_IN_REVIEW.pending,
              })
            }
            size="sm"
            variant="ghost"
          >
            {t("common.undo")}
          </Button>
        </div>
      );
    case "signedOut":
      return (
        <section
          aria-labelledby="sign-in-review-signed-out"
          className="flex flex-col gap-4 rounded-2xl border p-6 shadow-sm"
          role="status"
        >
          <div className="flex items-center gap-3">
            <span className="bg-success/12 grid size-9 place-items-center rounded-full">
              <CircleCheckIcon
                aria-hidden="true"
                className="text-success size-4"
              />
            </span>
            <h2
              className="text-lg font-semibold text-balance"
              id="sign-in-review-signed-out"
            >
              {t("settings.account.security.reviewSignedOutTitle", {
                device: deviceLabel(state.deviceName),
              })}
            </h2>
          </div>
          <p className="text-muted-foreground max-w-prose text-sm text-pretty">
            {t("settings.account.security.reviewSignedOutBody")}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              render={<a href={`#${SIGN_IN_METHODS_SECTION_ID}`} />}
              size="lg"
            >
              {t("settings.account.security.reviewCheckMethods")}
            </Button>
            <Button onClick={onDismiss} size="lg" variant="outline">
              {t("common.back")}
            </Button>
          </div>
        </section>
      );
    case "gone":
      return (
        <div
          className="bg-muted/60 flex flex-wrap items-center gap-2.5 rounded-xl px-4 py-3 text-sm"
          role="status"
        >
          <span className="min-w-0 flex-1 text-pretty">
            {t("settings.account.security.reviewGone")}
          </span>
          <Button onClick={onDismiss} size="sm" variant="ghost">
            {t("common.close")}
          </Button>
        </div>
      );
    default:
      state satisfies never;
      return panic("Unknown review card state");
  }
};

type AskCardProps = {
  device: SignedInDevice;
  decisionPending: boolean;
  signOutPending: boolean;
  onConfirm: () => void;
  onSignOut: () => void;
};

const AskCard = ({
  device,
  decisionPending,
  signOutPending,
  onConfirm,
  onSignOut,
}: AskCardProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const relativeTime = useRelativeTime();
  const { deviceLabel, placeLabel } = useDeviceWording();
  const place =
    device.location.type === "known" ? placeLabel(device.location) : null;
  const busy = decisionPending || signOutPending;
  const busyReason = signOutPending
    ? t("common.signingOut")
    : t("common.saving");
  const details = [
    {
      key: "device",
      term: t("settings.account.security.reviewDevice"),
      value: deviceLabel(device.name),
    },
    {
      key: "place",
      term: t("settings.account.security.reviewPlace"),
      value:
        place === null
          ? t("settings.account.security.unknownLocation")
          : t("settings.account.security.placeApproximate", { place }),
    },
    ...(device.ipAddress === null
      ? []
      : [
          {
            key: "address",
            term: t("settings.account.security.reviewAddress"),
            value: device.ipAddress,
          },
        ]),
    {
      key: "time",
      term: t("common.datePicker.time"),
      value: format.dateTime(device.signedInAt, MEDIUM_DATE_SHORT_TIME_FORMAT),
    },
  ];

  return (
    <section
      aria-labelledby="sign-in-review-title"
      className="flex flex-wrap overflow-hidden rounded-2xl border shadow-sm"
    >
      <div className="flex min-w-0 flex-1 basis-80 flex-col gap-5 p-6">
        <div className="flex flex-col items-start gap-1.5">
          <Badge tone="warning">
            {t("settings.account.security.reviewBadge", {
              time: relativeTime(device.signedInAt),
            })}
          </Badge>
          <h2
            className="text-xl font-semibold text-balance"
            id="sign-in-review-title"
          >
            {t("settings.account.security.reviewTitle")}
          </h2>
        </div>
        <DetailsGrid variant="list">
          {details.map(({ key, term, value }) => (
            <DetailsItem key={key} label={term}>
              <bdi>{value}</bdi>
            </DetailsItem>
          ))}
        </DetailsGrid>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={busy}
            disabledReason={busyReason}
            loading={decisionPending}
            onClick={onConfirm}
            size="lg"
          >
            {t("settings.account.security.reviewConfirm")}
          </Button>
          <Button
            disabled={busy}
            disabledReason={busyReason}
            loading={signOutPending}
            onClick={onSignOut}
            size="lg"
            variant="destructive-outline"
          >
            {t("settings.account.security.reviewReject")}
          </Button>
        </div>
      </div>
      {device.location.type === "known" &&
        device.location.coordinates !== null && (
          <SignInMap
            alt={t("settings.account.security.mapLabel", {
              place: place ?? "",
            })}
            className="min-h-56 min-w-0 flex-1 basis-80 border-t object-cover sm:border-s sm:border-t-0"
            sessionId={device.id}
          />
        )}
    </section>
  );
};

/** Moves the reviewed sign-in; its resource contract refreshes the list. */
const useReviewDecision = () => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: resourceMutation({
      mutation: "reviewSessionSignIn",
      queryClient,
      scope: { type: "organization" },
      mutationFn: reviewSessionSignIn,
    }),
    onError: (error) => {
      analytics.captureError(error, {
        fingerprintKey: "SignInReviewCard:decide",
        scope: { type: "handler", handlerId: "SignInReviewCard:decide" },
      });
      notifyUserError(error, t("errors.actionFailed"));
    },
  });
};
