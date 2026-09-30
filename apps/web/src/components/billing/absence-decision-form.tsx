import { useId, useState } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Label } from "@stll/ui/label";
import { ReviewDecisionActions } from "@stll/ui/review-decision-actions";
import { Textarea } from "@stll/ui/textarea";
import { stellaToast } from "@stll/ui/toast";

import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import type { AbsenceEntry } from "@/lib/organization/absences";
import { useDecideAbsence } from "@/lib/organization/absences";

import { canRejectAbsence } from "./absence-form.logic";

type AbsenceDecisionFormProps = {
  entry: AbsenceEntry;
  action: "approve" | "reject";
  onClose: () => void;
};

export const AbsenceDecisionForm = ({
  entry,
  action,
  onClose,
}: AbsenceDecisionFormProps) => {
  const id = useId();
  const t = useTranslations();
  const user = useAuthenticatedUser();
  const decision = useDecideAbsence(user.activeOrganizationId);
  const [comment, setComment] = useState("");
  const valid = action === "approve" || canRejectAbsence(comment);
  const submit = () => {
    if (!valid || decision.isPending) {
      return;
    }
    decision.mutate(
      { id: entry.id, version: entry.version, action, comment },
      {
        onSuccess: () => {
          stellaToast.add({
            title: t("billing.absences.decisionSaved"),
            type: "success",
          });
          onClose();
        },
      },
    );
  };
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Label htmlFor={id}>
        {action === "reject"
          ? t("billing.absences.rejectionComment")
          : t("billing.absences.decisionComment")}
      </Label>
      <Textarea
        id={id}
        required={action === "reject"}
        maxLength={2000}
        value={comment}
        onChange={(event) => setComment(event.target.value)}
        disabled={decision.isPending}
      />
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          className="min-h-11"
          onClick={onClose}
          disabled={decision.isPending}
        >
          {t("common.cancel")}
        </Button>
        <ReviewDecisionActions
          state={decision.isPending ? "applying" : "pending"}
          disabled={!valid}
          acceptLabel={t("billing.approve")}
          rejectLabel={t("docxReview.reject")}
          onAccept={action === "approve" ? submit : undefined}
          onReject={action === "reject" ? submit : undefined}
          className="[&_button]:min-h-11"
        />
      </div>
    </form>
  );
};
