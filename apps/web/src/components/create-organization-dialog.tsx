import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { Result } from "better-result";
import { useTranslations } from "use-intl";
import { useStore } from "zustand";

import { ORGANIZATION_NAME_MAX_LENGTH } from "@stll/api-contract/organization-create";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";
import { Field, FieldLabel } from "@stll/ui/field";
import { Form } from "@stll/ui/form";
import { Input } from "@stll/ui/input";

import { RecoverableErrorStatus } from "@/components/recoverable-error-status";
import { useInvalidateSession } from "@/hooks/use-invalidate-session";
import { useSingleFlight } from "@/hooks/use-single-flight";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { useCapabilityMutation } from "@/lib/capabilities/use-capability-mutation";
import { detached } from "@/lib/detached";
import { unwrapApiResponse } from "@/lib/errors/api";
import { toAuthClientError } from "@/lib/errors/auth";
import { transformUnknownError } from "@/lib/errors/client";
import { readQueryResult } from "@/lib/errors/query-result";
import {
  getOrganizationCreationOwner,
  organizationCreationView,
} from "@/lib/organization/creation-state";
import { toSafeId } from "@/lib/safe-id";
import { createUuid } from "@/lib/uuid";

export const CreateOrganizationDialog = ({
  open,
  onOpenChange,
  userId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
}) => {
  const t = useTranslations();
  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();
  const owner = getOrganizationCreationOwner(queryClient, toSafeId(userId));
  const state = useStore(owner.state);
  const view = organizationCreationView(state);
  const analytics = useAnalytics();
  const invalidateSession = useInvalidateSession();
  const singleFlight = useSingleFlight();
  const create = useCapabilityMutation({
    capability: "organizations.create",
    retry: false,
    target: { type: "user", id: toSafeId(userId) },
    mutationFn: async (
      intent: NonNullable<ReturnType<typeof owner.begin>>,
      request,
    ) => {
      const response = api.organizations.post(
        { name: intent.name.trim() },
        {
          ...request,
          headers: {
            "Idempotency-Key": intent.idempotencyKey,
            ...request.headers,
          },
        },
      );
      const result = await Result.tryPromise({
        try: async () => unwrapApiResponse(await response),
        catch: transformUnknownError,
      });
      if (result.isErr()) {
        owner.refused(intent);
        analytics.captureError(result.error, {
          fingerprintKey: "CreateOrganizationDialog:create",
          scope: {
            type: "handler",
            handlerId: "CreateOrganizationDialog:create",
          },
        });
        return readQueryResult(result);
      }
      // Creation never changes the active organization. Even an offscreen
      // completion waits in the account owner for an explicit switch.
      owner.created(intent, result.value);
    },
  });
  const switchOrganization = useMutation({
    retry: false,
    mutationFn: async (
      organization: NonNullable<ReturnType<typeof owner.beginSwitch>>,
    ) => {
      const location = router.state.location.href;
      const selected = await Result.tryPromise({
        try: async () =>
          await authClient.organization.setActive({
            organizationId: organization.organizationId,
          }),
        catch: transformUnknownError,
      });
      const result = await selected.andThenAsync(async ({ error }) => {
        if (error) {
          return Result.err(toAuthClientError(error));
        }
        return await Result.tryPromise({
          try: async () => {
            await invalidateSession.mutateAsync();
            const navigateHome = router.state.location.href === location;
            if (navigateHome) {
              await navigate({ to: "/", replace: true });
            }
            return navigateHome;
          },
          catch: transformUnknownError,
        });
      });
      if (result.isErr()) {
        owner.switchFailed();
        analytics.captureError(result.error, {
          fingerprintKey: "CreateOrganizationDialog:switch",
          scope: {
            type: "handler",
            handlerId: "CreateOrganizationDialog:switch",
          },
        });
        return readQueryResult(result);
      }
      owner.switched();
      if (result.value) {
        onOpenChange(false);
      }
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen, details) => {
        if (
          !nextOpen &&
          organizationCreationView(owner.state.getState()).pending
        ) {
          details.cancel();
          return;
        }
        onOpenChange(nextOpen);
      }}
    >
      <DialogPopup size="sm" showCloseButton={!view.pending}>
        <DialogHeader>
          <DialogTitle>{t("organization.newOrganization")}</DialogTitle>
          <DialogDescription>
            {t("organization.newOrganizationDescription")}
          </DialogDescription>
        </DialogHeader>
        <Form
          onSubmit={(event) => {
            event.preventDefault();
            detached(
              singleFlight.runSettled((onSettled) => {
                if (view.organization !== null) {
                  const organization = owner.beginSwitch();
                  if (organization === null) {
                    onSettled();
                    return;
                  }
                  switchOrganization.mutate(organization, { onSettled });
                  return;
                }
                const intent = owner.begin(createUuid);
                if (intent === null) {
                  onSettled();
                  return;
                }
                create.mutate(intent, { onSettled });
              }),
              "create-organization-dialog.submit",
            );
          }}
        >
          <DialogPanel className="space-y-4">
            <Field name="organizationName">
              <FieldLabel htmlFor="new-organization-name">
                {t("common.organizationName")}
              </FieldLabel>
              <Input
                autoFocus
                id="new-organization-name"
                maxLength={ORGANIZATION_NAME_MAX_LENGTH}
                value={view.name}
                onChange={(event) => owner.setName(event.target.value)}
                disabled={!view.editable}
              />
            </Field>
            {view.organization !== null && (
              <BidiText as="p" direction="ltr">
                {view.organization.slug}
              </BidiText>
            )}
            {view.failed && (
              <RecoverableErrorStatus
                className="text-destructive text-sm"
                message={t("errors.actionFailed")}
                actions={null}
              />
            )}
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="outline"
              type="button"
              disabled={view.pending}
              onClick={() => {
                if (!organizationCreationView(owner.state.getState()).pending) {
                  onOpenChange(false);
                }
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              loading={view.pending}
              disabled={view.pending || !view.name.trim()}
            >
              {view.organization === null
                ? t("auth.createOrganizationButton")
                : t("organization.switchOrganization")}
            </Button>
          </DialogFooter>
        </Form>
      </DialogPopup>
    </Dialog>
  );
};
