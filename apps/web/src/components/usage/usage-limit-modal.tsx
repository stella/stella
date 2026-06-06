import { useMutation } from "@tanstack/react-query";

import { Button } from "@stll/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@stll/ui/components/dialog";
import { stellaToast } from "@stll/ui/components/toast";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";

/** Modal shown when the current organisation cannot run more AI work. */

export type UsageLimitExceededReason =
  | "no_entitlement"
  | "usage_limit_exceeded"
  | "entitlement_inactive";

export type UsageLimitModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  required: number;
  available: number;
  reason: UsageLimitExceededReason;
  /**
   * Whether the org has a hosted entitlement. Drives which CTA
   * is shown. The caller knows this from the entitlement query.
   */
  hasHostedEntitlement: boolean;
};

export const UsageLimitModal = ({
  open,
  onOpenChange,
  required,
  available,
  reason,
  hasHostedEntitlement,
}: UsageLimitModalProps) => {
  const managementMutation = useMutation({
    mutationFn: async () => {
      const response = await api.usage.hosted.management.post();
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
    onError: (error: unknown) => {
      stellaToast.add({
        title: "Could not open hosted usage management",
        description: error instanceof Error ? error.message : undefined,
        type: "error",
      });
    },
  });

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{titleFor(reason)}</DialogTitle>
          <DialogDescription>{descriptionFor(reason)}</DialogDescription>
        </DialogHeader>

        <div className="bg-muted/40 rounded-md p-3 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Needed</span>
            <span className="font-medium">
              {required.toLocaleString()} units
            </span>
          </div>
          <div className="mt-1 flex justify-between">
            <span className="text-muted-foreground">Available</span>
            <span className="font-medium">
              {available.toLocaleString()} units
            </span>
          </div>
        </div>

        <DialogFooter>
          <DialogClose>
            <Button variant="ghost">Not now</Button>
          </DialogClose>
          {hasHostedEntitlement ? (
            <Button
              disabled={managementMutation.isPending}
              onClick={() => managementMutation.mutate()}
            >
              Manage hosted usage
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const titleFor = (reason: UsageLimitExceededReason): string => {
  switch (reason) {
    case "no_entitlement":
      return "Usage entitlement required";
    case "entitlement_inactive":
      return "Usage entitlement is not active";
    case "usage_limit_exceeded":
      return "AI usage limit reached";
  }
  const exhaustive: never = reason;
  return exhaustive;
};

const descriptionFor = (reason: UsageLimitExceededReason): string => {
  switch (reason) {
    case "no_entitlement":
      return "AI features need an active usage entitlement for this organisation.";
    case "entitlement_inactive":
      return "The organisation's usage entitlement is paused or inactive. Review hosted usage management or contact an operator.";
    case "usage_limit_exceeded":
      return "This action cannot run with the organisation's current usage state.";
  }
  const exhaustive: never = reason;
  return exhaustive;
};
