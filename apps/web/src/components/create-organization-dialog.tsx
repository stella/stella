import { useState } from "react";

import { useNavigate } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { ORGANIZATION_NAME_MAX_LENGTH } from "@stll/api-contract/organization-create";
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
import { useIdempotentSubmit } from "@/lib/idempotency/use-idempotent-submit";
import { toSafeId } from "@/lib/safe-id";

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
  const analytics = useAnalytics();
  const invalidateSession = useInvalidateSession();
  const singleFlight = useSingleFlight();
  const createIntent = useIdempotentSubmit();
  const [name, setName] = useState("");
  const [failure, setFailure] = useState(false);
  const [createdOrganizationId, setCreatedOrganizationId] = useState<
    string | null
  >(null);
  const create = useCapabilityMutation({
    capability: "organizations.create",
    target: { type: "user", id: toSafeId(userId) },
    mutationFn: async (organizationName: string, request) => {
      // Retain a successful creation if switching fails, so retry only switches.
      const organizationId =
        createdOrganizationId ??
        unwrapApiResponse(
          await api.organizations.post(
            { name: organizationName },
            {
              ...request,
              headers: {
                "Idempotency-Key": createIntent.prepare({
                  body: { name: organizationName },
                  operation: "organizations.create",
                }).headers["Idempotency-Key"],
                ...request.headers,
              },
            },
          ),
        ).organizationId;
      setCreatedOrganizationId(organizationId);
      const { error } = await authClient.organization.setActive({
        organizationId,
      });
      if (error) {
        throw toAuthClientError(error);
      }
      await invalidateSession.mutateAsync();
      await navigate({ to: "/", replace: true });
      createIntent.reset();
      setName("");
      setCreatedOrganizationId(null);
      onOpenChange(false);
    },
    onError: (error) => {
      setFailure(true);
      analytics.captureError(error, {
        fingerprintKey: "CreateOrganizationDialog:create",
        scope: {
          type: "handler",
          handlerId: "CreateOrganizationDialog:create",
        },
      });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup size="sm">
        <DialogHeader>
          <DialogTitle>{t("organization.newOrganization")}</DialogTitle>
          <DialogDescription>
            {t("organization.newOrganizationDescription")}
          </DialogDescription>
        </DialogHeader>
        <Form
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim()) {
              return;
            }
            setFailure(false);
            detached(
              singleFlight.runSettled((onSettled) =>
                create.mutate(name.trim(), { onSettled }),
              ),
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
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={
                  singleFlight.pending || createdOrganizationId !== null
                }
              />
            </Field>
            {failure && (
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
              disabled={singleFlight.pending}
              onClick={() => onOpenChange(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              loading={singleFlight.pending}
              disabled={singleFlight.pending || !name.trim()}
            >
              {createdOrganizationId === null
                ? t("auth.createOrganizationButton")
                : t("organization.switchOrganization")}
            </Button>
          </DialogFooter>
        </Form>
      </DialogPopup>
    </Dialog>
  );
};
