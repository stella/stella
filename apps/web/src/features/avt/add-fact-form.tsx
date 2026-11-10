/**
 * Add an anchor fact by hand: a fact item on the view's list, scored like an
 * extracted one. Its date, confidence and sources are described afterwards in
 * its row, as for any other fact.
 */

import * as React from "react";

import { useQueryClient } from "@tanstack/react-query";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { LIST_ITEM_TYPE } from "@stll/api-contract/entity-options";
import { Button } from "@stll/ui/button";
import { Form } from "@stll/ui/form";
import { Input } from "@stll/ui/input";

import { api } from "@/lib/api";
import { invokeCapability } from "@/lib/capabilities/capability-request";
import { detached } from "@/lib/detached";
import { unwrapApiResponse } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { toSafeId } from "@/lib/safe-id";
import { legalListKeys } from "@/lib/workspaces/queries/legal-lists";

/** Characters a list item's name may hold, the task endpoint's cap. */
const FACT_NAME_MAX_LENGTH = 255;

type AddFactFormProps = {
  workspaceId: string;
  listId: string;
  onClose: () => void;
};

export const AddFactForm = ({
  workspaceId,
  listId,
  onClose,
}: AddFactFormProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const [name, setName] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const statement = name.trim();

  const add = async () => {
    if (statement === "" || saving) {
      return;
    }
    setSaving(true);
    const body = {
      name: statement,
      listId: toSafeId<"legalList">(listId),
      listItemType: LIST_ITEM_TYPE.FACT,
    };
    // The task endpoint takes no idempotency key; the capability header
    // declares the write.
    const sent = await Result.tryPromise(
      async () =>
        await invokeCapability("tasks.create", async (request) =>
          unwrapApiResponse(
            await api
              .tasks({ workspaceId: toSafeId<"workspace">(workspaceId) })
              .put(body, request),
          ),
        ),
    );
    setSaving(false);
    if (sent.isErr()) {
      notifyUserError(sent.error, t("errors.actionFailed"));
      return;
    }
    // Stays open for the next fact; a reviewer often adds several.
    setName("");
    await queryClient.invalidateQueries({
      queryKey: legalListKeys.items(workspaceId, listId),
    });
  };

  return (
    <Form
      className="sm:flex-row sm:items-center"
      density="compact"
      onSubmit={(event) => {
        event.preventDefault();
        detached(add(), "avt.add-fact");
      }}
    >
      <Input
        aria-label={t("avt.anchorFacts.addFact")}
        autoFocus
        className="min-w-0 flex-1"
        disabled={saving}
        maxLength={FACT_NAME_MAX_LENGTH}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            onClose();
          }
        }}
        placeholder={t("avt.anchorFacts.addFactPlaceholder")}
        value={name}
      />
      <div className="flex gap-2">
        <Button disabled={statement === ""} loading={saving} type="submit">
          {t("common.add")}
        </Button>
        <Button onClick={onClose} type="button" variant="ghost">
          {t("common.cancel")}
        </Button>
      </div>
    </Form>
  );
};
