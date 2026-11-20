import type { ReactNode } from "react";

import { ButtonFace, FaceLabelPending } from "@stll/ui/control-face";
import { PlusIcon, Trash2Icon } from "@stll/ui/icons";
import {
  List,
  LIST_ITEM_ROW_CLASS,
  ListGroup,
  ListGroupDescription,
  ListGroupHeader,
  ListGroupTitle,
} from "@stll/ui/list-shell";
import { cn } from "@stll/ui/utils";

import { PendingText } from "@/components/pending-text";

/*
 * The AI providers group (`AIProviderRows`), beside its pending phase: the
 * group's header (title, the add action, one quiet line) over the list of
 * provider rows. The live group puts its add button and its rows in; the
 * pending phase the add button's face and one placeholder row in a stored
 * provider's shape (name, masked key, replace and remove), as most
 * configured organizations have.
 */

/** A provider row's box: the list row, stacking its lines. */
const AI_PROVIDER_ROW_CLASS = "flex-col items-stretch";

/** A provider row's first line: picker or name, key, actions. */
export const AI_PROVIDER_ROW_LINE_CLASS =
  "flex min-w-0 flex-wrap items-center gap-2";

/** The providers group in both phases. */
export const AIProviderRowsFrame = ({
  addAction,
  children,
  description,
}: {
  /** The add provider button, or its face. */
  addAction: ReactNode;
  /** The provider rows. */
  children: ReactNode;
  /** Whether the organization needs a key, or the generic line. */
  description: ReactNode;
}) => (
  <ListGroup>
    <ListGroupHeader>
      <div className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-0.5">
        <ListGroupTitle>
          <PendingText
            barClassName="w-24"
            id="organization.aiConfig.providersPanel"
          />
        </ListGroupTitle>
        {addAction}
        <ListGroupDescription className="col-start-1">
          {description}
        </ListGroupDescription>
      </div>
    </ListGroupHeader>
    <List>{children}</List>
  </ListGroup>
);

/** The providers group while the stored configuration is read. */
export const AIProviderRowsPending = () => (
  <AIProviderRowsFrame
    description={
      <PendingText
        barClassName="w-72 max-w-full"
        id="organization.aiConfig.providersDescription"
      />
    }
    addAction={
      <ButtonFace size="sm" variant="ghost">
        <PlusIcon />
        <PendingText
          barClassName="w-20"
          id="organization.aiConfig.addProvider"
        />
      </ButtonFace>
    }
  >
    <li aria-hidden="true" className="flex">
      <div className={cn(LIST_ITEM_ROW_CLASS, AI_PROVIDER_ROW_CLASS)}>
        <div className={AI_PROVIDER_ROW_LINE_CLASS}>
          <span className="w-36 text-sm font-medium">
            <FaceLabelPending className="w-20" />
          </span>
          <div className="min-w-36 flex-1">
            <span className="font-mono text-sm">
              <FaceLabelPending className="w-28" />
            </span>
          </div>
          <ButtonFace size="sm" variant="ghost">
            <PendingText
              barClassName="w-16"
              id="organization.aiConfig.replaceKey"
            />
          </ButtonFace>
          <ButtonFace size="icon" variant="ghost">
            <Trash2Icon />
          </ButtonFace>
        </div>
      </div>
    </li>
  </AIProviderRowsFrame>
);
