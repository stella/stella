import { useState } from "react";

import { panic } from "better-result";
import { PlusIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@stll/ui/menu";
import { PropertyIcon } from "@stll/workspace-ui/property-icon";

import { useRequireAccount } from "@/components/auth/use-require-account";
import { BulkAddColumns } from "@/components/workspaces/bulk-add-columns";
import { ADD_COLUMN_RAIL_PLUS_CLASS_NAME } from "@/components/workspaces/table/add-column-rail";
import type {
  AvailableQuestionColumns,
  QuestionColumnSurface,
  QuestionSuggestionScope,
} from "@/features/case-law/research/question-columns.logic";
import { useQuestionColumnsCountLimit } from "@/features/case-law/research/use-question-column-limit";

/**
 * What pressing the add-question control does here, or null where there is no
 * control to draw: a surface with nothing to ask of, and a member the
 * organization has not granted `create` whose search already shows every
 * question it has.
 *
 * Callers ask this before reserving room for the control. The table's rail is
 * a transparent absolute strip over the last columns, so a rail placed for a
 * control that renders nothing would swallow pointer input on those cells.
 */
type QuestionColumnAddAction =
  /** The account gate, before a composer there is no organization for. */
  | { mode: "gate"; suggestion: QuestionSuggestionScope }
  /** The composer straight away: there is no other question to offer. */
  | { mode: "compose"; surface: AvailableQuestionColumns }
  /** The organization's other questions, and the composer where granted. */
  | { mode: "pick"; surface: AvailableQuestionColumns };

export const questionColumnAddAction = (
  surface: QuestionColumnSurface,
): QuestionColumnAddAction | null => {
  switch (surface.type) {
    case "hidden":
      return null;
    case "gated":
      return { mode: "gate", suggestion: surface.suggestion };
    case "available":
      // Showing a question the organization already has needs no grant.
      if (surface.addable.length > 0) {
        return { mode: "pick", surface };
      }
      // Writing one does: a member the organization has not granted `create`
      // gets the table without it, not a trigger that fails on submit.
      return surface.grants.create ? { mode: "compose", surface } : null;
    default:
      surface satisfies never;
      return panic(`Unhandled question column surface: ${String(surface)}`);
  }
};

type AddQuestionColumnTrigger = "labelled" | "rail";

type AddQuestionColumnProps = {
  surface: QuestionColumnSurface;
  /** The toolbar's labelled button, or the table's own end rail. */
  triggerVariant: AddQuestionColumnTrigger;
};

/**
 * The one way a question column is added, wherever the control is drawn.
 *
 * A member with the grant opens the composer; where the organization holds
 * questions this search does not show, the same trigger opens a menu of them
 * first, so a question asked before joins this search in one press. A reader
 * without an account gets the same trigger in the same place and presses it
 * into the account gate, so the results table never quietly loses the
 * affordance it has for everyone else. Every branch reads
 * `questionColumnAddAction`, so what is drawn and what a caller reserves room
 * for cannot disagree.
 */
export const AddQuestionColumn = ({
  surface,
  triggerVariant,
}: AddQuestionColumnProps) => {
  const { accountDialog, ensureAccount } = useRequireAccount();
  const action = questionColumnAddAction(surface);

  if (action === null) {
    return null;
  }

  switch (action.mode) {
    case "compose":
      return (
        <BulkAddColumns
          target={{
            kind: "organisation",
            suggestion: action.surface.suggestion,
            onCreated: action.surface.onAddToSearch,
          }}
          triggerVariant={triggerVariant}
        />
      );
    case "pick":
      return (
        <PickQuestionColumn
          surface={action.surface}
          triggerVariant={triggerVariant}
        />
      );
    case "gate":
      return (
        <>
          <BulkAddColumns
            // Held closed: the press is answered by the gate, and the composer
            // opens on the next visit, with an organization behind it.
            open={false}
            onOpenChange={(open) => {
              if (open) {
                ensureAccount("writeResearchQuestion");
              }
            }}
            target={{ kind: "organisation", suggestion: action.suggestion }}
            triggerVariant={triggerVariant}
          />
          {accountDialog}
        </>
      );
    default:
      action satisfies never;
      return panic(`Unhandled add-question action: ${String(action)}`);
  }
};

type PickQuestionColumnProps = {
  surface: AvailableQuestionColumns;
  triggerVariant: AddQuestionColumnTrigger;
};

/**
 * The organization's questions this search does not show, each one press from
 * joining it, under the composer for a member who may write a new one.
 */
const PickQuestionColumn = ({
  surface,
  triggerVariant,
}: PickQuestionColumnProps) => {
  const t = useTranslations();
  const [composing, setComposing] = useState(false);
  const isLimitReached = useQuestionColumnsCountLimit(true);
  const mayCompose = surface.grants.create && !isLimitReached;

  return (
    <>
      <Menu>
        <PickQuestionTrigger triggerVariant={triggerVariant} />
        <MenuPopup align="end" className="max-w-80">
          {mayCompose && (
            <>
              <MenuItem onClick={() => setComposing(true)}>
                <PlusIcon />
                {t("workspaces.properties.newColumn")}
              </MenuItem>
              <MenuSeparator />
            </>
          )}
          <MenuGroup>
            <MenuGroupLabel>
              {t("caseLaw.research.savedQuestions")}
            </MenuGroupLabel>
            {surface.addable.map((column) => (
              <MenuItem
                key={column.id}
                onClick={() => surface.onAddToSearch([column.id])}
              >
                <PropertyIcon
                  className="size-3.5 shrink-0"
                  type={column.content.type}
                />
                <span className="min-w-0 truncate" title={column.question}>
                  {column.question}
                </span>
              </MenuItem>
            ))}
          </MenuGroup>
        </MenuPopup>
      </Menu>
      {composing && (
        <BulkAddColumns
          onOpenChange={(open) => {
            if (!open) {
              setComposing(false);
            }
          }}
          open
          target={{
            kind: "organisation",
            suggestion: surface.suggestion,
            onCreated: surface.onAddToSearch,
          }}
          triggerVariant="none"
        />
      )}
    </>
  );
};

/** The composer's own two triggers, opening the menu instead of the dialog. */
const PickQuestionTrigger = ({
  triggerVariant,
}: {
  triggerVariant: AddQuestionColumnTrigger;
}) => {
  const t = useTranslations();
  const label = t("workspaces.properties.newColumn");

  switch (triggerVariant) {
    case "labelled":
      return (
        <MenuTrigger
          aria-label={label}
          render={
            <Button
              size="xs"
              type="button"
              variant="muted"
            />
          }
        >
          <PlusIcon className="size-3" />
          <span className="hidden sm:inline">{label}</span>
        </MenuTrigger>
      );
    case "rail":
      return (
        <MenuTrigger
          aria-label={label}
          render={
            <button
              className="group/add-column-rail ring-ring focus-visible:ring-offset-background absolute inset-0 z-10 cursor-pointer border-0 bg-transparent p-0 outline-none focus-visible:ring-2 focus-visible:ring-offset-1"
              data-add-property-trigger
              data-row-expansion-ignore
              type="button"
            />
          }
        >
          <PlusIcon className={ADD_COLUMN_RAIL_PLUS_CLASS_NAME} />
        </MenuTrigger>
      );
    default:
      triggerVariant satisfies never;
      return panic(`Unhandled add-question trigger: ${String(triggerVariant)}`);
  }
};
