import { useRef, useState } from "react";

import { useTranslations } from "use-intl";

import { Textarea } from "@stll/ui/textarea";

import { useMountEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { useUpdateContact } from "@/lib/contacts/mutations";
import type { ContactData } from "@/routes/_protected.contacts/-components/types";

export const ContactNotesEditor = ({ contact }: { contact: ContactData }) => {
  const t = useTranslations();
  const updateContact = useUpdateContact();
  const [scope] = useState(() => ({
    organizationId: contact.organizationId,
    contactId: contact.id,
  }));
  const [draft, setDraft] = useState(contact.notes ?? "");
  const [latestServerNotes, setLatestServerNotes] = useState(
    contact.notes ?? "",
  );
  const skipNextSaveRef = useRef(false);
  const submittedDraft = useRef<string | undefined>(undefined);

  // Reconcile the server notes prop into the local draft during render
  // (React's sanctioned "adjust state when a prop changes" pattern, tracking the
  // last-seen server value in state). When the server value changes, accept it
  // only if the user hasn't diverged from the value the server last gave us;
  // otherwise keep the in-progress edit.
  const nextServerNotes = contact.notes ?? "";
  if (nextServerNotes !== latestServerNotes) {
    if (draft === latestServerNotes) {
      setDraft(nextServerNotes);
    }
    setLatestServerNotes(nextServerNotes);
  }

  const handleSave = () => {
    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false;
      return;
    }

    const current = contact.notes ?? "";
    if (draft === current || draft === submittedDraft.current) {
      return;
    }

    submittedDraft.current = draft;
    updateContact.mutate(
      {
        ...scope,
        notes: draft.trim().length === 0 ? null : draft,
      },
      {
        onError: () => {
          submittedDraft.current = undefined;
          setDraft(current);
        },
      },
    );
  };

  const flush = useLatestCallback(handleSave);
  useMountEffect(() => () => flush());

  return (
    <Textarea
      aria-label={t("common.notes")}
      className="min-h-28"
      disabled={updateContact.isPending}
      onBlur={handleSave}
      onChange={(event) => {
        submittedDraft.current = undefined;
        setDraft(event.currentTarget.value);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          skipNextSaveRef.current = true;
          setDraft(contact.notes ?? "");
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
      placeholder="—"
      value={draft}
    />
  );
};
