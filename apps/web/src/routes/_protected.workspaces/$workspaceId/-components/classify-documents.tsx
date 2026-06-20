import { useSuspenseQuery } from "@tanstack/react-query";
import { ChevronDownIcon, TagsIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import type { OptionColor } from "@stll/api/types";
import { Button } from "@stll/ui/components/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "@stll/ui/components/menu";
import { stellaToast } from "@stll/ui/components/toast";

import type { WorkspaceProperty, WorkspacePropertyOption } from "@/lib/types";
import { usePropertiesCountLimit } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-limits";
import { useStartWorkflow } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-start-workflow";
import { useCreateProperty } from "@/routes/_protected.workspaces/$workspaceId/-mutations/properties";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";

type ClassifyDocumentsProps = {
  workspaceId: string;
};

const DOCUMENT_TYPE_NAME = "Document Type";

const STARTER_OPTION_PRESETS = [
  ["Lease", "amber"],
  ["NDA", "violet"],
  ["Employment", "blue"],
  ["Services agreement", "teal"],
  ["IP assignment", "fuchsia"],
  ["Financing", "green"],
  ["Corporate", "indigo"],
  ["Other", "gray"],
] as const satisfies readonly [value: string, color: OptionColor][];

const STARTER_OPTIONS: readonly WorkspacePropertyOption[] =
  STARTER_OPTION_PRESETS.map(([value, color]) => ({ value, color }));

const CLASSIFICATION_PROMPT =
  "Classify this document into exactly one of the listed legal document types. " +
  "Read the document's content, headings, and parties to decide. " +
  "Pick the single best-fitting type; choose Other only when none of the specific types apply.";

const isDocumentTypeClassifier = (property: WorkspaceProperty): boolean =>
  property.content.type === "single-select" &&
  property.tool.type === "ai-model" &&
  property.name.trim().toLowerCase() === DOCUMENT_TYPE_NAME.toLowerCase();

export const ClassifyDocuments = ({ workspaceId }: ClassifyDocumentsProps) => {
  const t = useTranslations();
  const isLimitReached = usePropertiesCountLimit(workspaceId);
  const { data: properties } = useSuspenseQuery(propertiesOptions(workspaceId));
  const createProperty = useCreateProperty({ workspaceId });
  const startWorkflow = useStartWorkflow(workspaceId);

  const existingClassifier = properties.find(isDocumentTypeClassifier);
  const fileProperty = properties.find((p) => p.content.type === "file");

  // Without a file source to read from, an AI classifier has nothing to
  // extract from, so the action stays hidden until documents exist.
  if (!fileProperty) {
    return null;
  }

  // Re-running an existing classifier is always available; only the
  // create path is gated by the workspace property limit.
  if (!existingClassifier && isLimitReached) {
    return null;
  }

  // Default run leaves `force` unset, so the per-entity gate only computes
  // documents still missing a classification (e.g. ones added since the
  // last run). "Reclassify" forces a full redo the user explicitly asked
  // for.
  const runClassifier = (force: boolean) => {
    if (!existingClassifier) {
      return;
    }
    void startWorkflow({
      propertyIds: [existingClassifier.id],
      ...(force && { force: true }),
    });
  };

  const createClassifier = () => {
    createProperty.mutate(
      {
        name: DOCUMENT_TYPE_NAME,
        contentType: "single-select",
        toolType: "ai-model",
        prompt: CLASSIFICATION_PROMPT,
        dependencies: [
          { dependsOnPropertyId: fileProperty.id, condition: null },
        ],
        options: [...STARTER_OPTIONS],
        fallback: null,
      },
      {
        onSuccess: (data) => {
          void startWorkflow({ propertyIds: [data.id] });
        },
        onError: () => {
          stellaToast.add({
            title: t("errors.actionFailed"),
            type: "error",
          });
        },
      },
    );
  };

  if (!existingClassifier) {
    return (
      <Button
        className="text-muted-foreground hover:bg-accent gap-1 px-2 font-normal"
        loading={createProperty.isPending}
        onClick={createClassifier}
        size="xs"
        type="button"
        variant="ghost"
      >
        <TagsIcon className="size-3" />
        {t("workspaces.properties.classify.action")}
      </Button>
    );
  }

  return (
    <div className="flex items-center">
      <Button
        className="text-muted-foreground hover:bg-accent gap-1 px-2 font-normal"
        onClick={() => runClassifier(false)}
        size="xs"
        type="button"
        variant="ghost"
      >
        <TagsIcon className="size-3" />
        {t("workspaces.properties.classify.action")}
      </Button>
      <Menu>
        <MenuTrigger
          render={
            <Button
              aria-label={t("workspaces.properties.classify.rerun")}
              className="text-muted-foreground hover:bg-accent"
              size="icon-xs"
              type="button"
              variant="ghost"
            />
          }
        >
          <ChevronDownIcon className="size-3" />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem onClick={() => runClassifier(true)}>
            {t("workspaces.properties.classify.rerun")}
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
};
