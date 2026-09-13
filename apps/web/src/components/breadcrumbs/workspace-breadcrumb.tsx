import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { Link, useMatch } from "@tanstack/react-router";
import type { ResolveParams } from "@tanstack/react-router";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { BreadcrumbItem, BreadcrumbSeparator } from "@stll/ui/breadcrumb";
import { Input } from "@stll/ui/input";
import { stellaToast } from "@stll/ui/toast";
import { cn } from "@stll/ui/utils";

import { BreadcrumbLink } from "@/components/breadcrumbs/shared";
import { MatterIcon } from "@/components/matter-icon";
import { MatterNumberHint } from "@/components/matter-number-hint";
import Tooltip from "@/components/tooltip";
import {
  MatterColorContextPicker,
  MatterColorPicker,
} from "@/components/workspaces/matter-color-picker";
import { resolveReferenceEdit } from "@/components/workspaces/matter-metadata-sheet.logic";
import { ReferenceChangeConfirmation } from "@/components/workspaces/reference-change-confirmation";
import { useInlineRename } from "@/hooks/use-inline-rename";
import { detached } from "@/lib/detached";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { useUpdateWorkspace } from "@/lib/workspaces/mutations";
import { workspaceOptions } from "@/lib/workspaces/queries";
import { useReferenceConflictMessage } from "@/lib/workspaces/use-reference-conflict-message";
import { useConfigStore } from "@/stores/config-store";

const breadcrumbInputClassName =
  "border-input bg-background text-foreground inline-flex rounded-md border text-sm shadow-xs/5 transition-colors has-focus-visible:border-ring";

const matterNameInputClassName = `${breadcrumbInputClassName} font-semibold`;

type ReferenceConfirmation =
  | { status: "closed" }
  | {
      status: "confirming";
      newReference: string;
      setError: (message: string) => void;
      workspaceId: string;
    };

export const WorkspaceBreadcrumb = ({
  workspaceId,
}: ResolveParams<"/workspaces/$workspaceId">) => {
  const t = useTranslations();
  const match = useMatch({
    from: "/_protected/workspaces/$workspaceId/",
    shouldThrow: false,
  });
  const [refInputEl, setRefInputEl] = useState<HTMLInputElement | null>(null);
  const { data: workspace } = useQuery(workspaceOptions(workspaceId));
  const updateWorkspace = useUpdateWorkspace();
  const updateMattersConfig = useConfigStore((s) => s.updateMatters);
  const referenceConflictMessage = useReferenceConflictMessage();
  const [referenceConfirmation, setReferenceConfirmation] =
    useState<ReferenceConfirmation>({ status: "closed" });

  const nameRename = useInlineRename({
    initial: workspace?.name ?? "",
    onCommit: (value) => {
      updateWorkspace.mutate({
        workspaceId,
        update: { type: "name", value },
      });
    },
  });

  const refRename = useInlineRename({
    initial: workspace?.reference ?? "",
    onCommit: (value, { setError }) => {
      if (!workspace) {
        return;
      }
      const edit = resolveReferenceEdit({
        currentReference: workspace.reference,
        nextReference: value,
        stampedVersionCount: workspace.stampedVersionCount,
      });
      switch (edit.type) {
        case "discard":
          refRename.cancel();
          return;
        case "confirm":
          setReferenceConfirmation({
            status: "confirming",
            newReference: edit.reference,
            setError,
            workspaceId,
          });
          return;
        case "save":
          updateWorkspace.mutate(
            {
              workspaceId,
              update: { type: "reference", value: edit.reference },
            },
            {
              onError: (error) => {
                const conflict = referenceConflictMessage(
                  error,
                  edit.reference,
                );
                if (conflict !== null) {
                  setError(conflict);
                  refInputEl?.focus();
                  return;
                }

                const message = userErrorFromThrown(
                  error,
                  t("errors.actionFailed"),
                );
                stellaToast.add({ title: message, type: "error" });
              },
            },
          );
          return;
        default:
          edit satisfies never;
          panic(`Unhandled reference edit: ${String(edit)}`);
      }
    },
  });

  const cancelReferenceChange = () => {
    setReferenceConfirmation({ status: "closed" });
    refRename.cancel();
  };

  const confirmReferenceChange = () => {
    if (
      referenceConfirmation.status !== "confirming" ||
      referenceConfirmation.workspaceId !== workspaceId
    ) {
      return;
    }
    const { newReference, setError } = referenceConfirmation;
    setReferenceConfirmation({ status: "closed" });
    updateWorkspace.mutate(
      {
        workspaceId,
        update: {
          type: "reference",
          value: newReference,
        },
      },
      {
        onError: (error) => {
          const conflict = referenceConflictMessage(error, newReference);
          if (conflict !== null) {
            setError(conflict);
            refInputEl?.focus();
            return;
          }
          stellaToast.add({
            title: userErrorFromThrown(error, t("errors.actionFailed")),
            type: "error",
          });
        },
      },
    );
  };

  if (!workspace) {
    return (
      <BreadcrumbLink to="/workspaces/$workspaceId">
        {workspaceId}
      </BreadcrumbLink>
    );
  }

  const displayName = workspace.name;

  const startEditingName = () => {
    nameRename.startEditing(displayName);
  };

  const isEditing = nameRename.state.mode === "edit";
  const nameValue =
    nameRename.state.mode === "edit" ? nameRename.state.draft : "";
  const isEditingRef = refRename.state.mode === "edit";
  const refDraft = refRename.state.mode === "edit" ? refRename.state.draft : "";
  const refError =
    refRename.state.mode === "edit" ? (refRename.state.error ?? "") : "";

  const changeColorLabel = t("common.changeColor");

  const colorPicker = match ? (
    <MatterColorPicker matter={workspace}>
      <Tooltip
        content={changeColorLabel}
        render={
          <button
            aria-label={changeColorLabel}
            className="hover:bg-muted cursor-pointer rounded p-0.5 transition-colors"
            type="button"
          >
            <MatterIcon
              className="size-3.5 shrink-0"
              matter={{ id: workspaceId, color: workspace.color }}
            />
          </button>
        }
      />
    </MatterColorPicker>
  ) : (
    <MatterIcon
      className="size-3.5 shrink-0"
      matter={{ id: workspaceId, color: workspace.color }}
    />
  );

  const { client } = workspace;
  const clientSegment = client ? (
    <>
      <BreadcrumbItem className="min-w-8 shrink">
        <Link
          className="hover:text-foreground min-w-0 truncate transition-colors"
          onClick={() => {
            // Clear active filters and group by client so the full grouped
            // list is shown; the route then scrolls to and flashes this
            // company's group on arrival. `filters` is the applied state
            // (clientFilter has no readers).
            updateMattersConfig({ groupBy: "client", filters: {} });
          }}
          search={{ focusClient: client.id }}
          title={client.displayName}
          to="/workspaces"
        >
          <BidiText>{client.displayName}</BidiText>
        </Link>
      </BreadcrumbItem>
      <BreadcrumbSeparator className="shrink-0" />
    </>
  ) : (
    <>
      <BreadcrumbItem className="min-w-8 shrink">
        <Link
          className="hover:text-foreground text-muted-foreground min-w-0 truncate transition-colors"
          onClick={() => {
            updateMattersConfig({ clientFilter: null });
          }}
          to="/workspaces"
          title={t("workspaces.parties.personalLabel")}
        >
          {t("workspaces.parties.personalLabel")}
        </Link>
      </BreadcrumbItem>
      <BreadcrumbSeparator className="shrink-0" />
    </>
  );

  const referenceSegment = (() => {
    if (isEditingRef) {
      return (
        <Input
          className={cn(breadcrumbInputClassName, "w-28 text-sm")}
          onBlur={() => {
            detached(refRename.commit(), "workspace-breadcrumb.commit");
          }}
          onChange={(e) => refRename.setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              detached(refRename.commit(), "workspace-breadcrumb.commit");
            }
            if (e.key === "Escape") {
              refRename.cancel();
            }
          }}
          placeholder={t("workspaces.referencePlaceholder")}
          ref={(el) => {
            setRefInputEl(el);
            el?.focus();
          }}
          size="sm"
          unstyled
          value={refDraft}
        />
      );
    }
    if (workspace.reference) {
      return (
        <button
          className="text-foreground-muted hover:text-muted-foreground cursor-text text-sm"
          onClick={() => refRename.startEditing(workspace.reference)}
          type="button"
        >
          {workspace.reference}
        </button>
      );
    }
    return null;
  })();

  const referenceHint = (
    <MatterNumberHint
      anchor={refInputEl}
      error={refError}
      open={isEditingRef}
      value={refDraft}
      variant="popover"
    />
  );
  const referenceConfirmationDialog =
    referenceConfirmation.status === "confirming" &&
    referenceConfirmation.workspaceId === workspaceId ? (
      <ReferenceChangeConfirmation
        newReference={referenceConfirmation.newReference}
        oldReference={workspace.reference}
        onCancel={cancelReferenceChange}
        onConfirm={confirmReferenceChange}
        stampedVersionCount={workspace.stampedVersionCount}
      />
    ) : null;

  if (!match) {
    return (
      <>
        {clientSegment}
        <BreadcrumbItem className="shrink-0">
          {(() => {
            if (isEditing) {
              return (
                <>
                  <MatterColorContextPicker
                    label={changeColorLabel}
                    matter={workspace}
                  >
                    <MatterIcon
                      className="size-3.5"
                      matter={{ id: workspaceId, color: workspace.color }}
                    />
                  </MatterColorContextPicker>
                  <Input
                    className={cn(matterNameInputClassName, "w-fit")}
                    disabled={updateWorkspace.isPending}
                    onBlur={() => {
                      detached(
                        nameRename.commit(),
                        "workspace-breadcrumb.commit",
                      );
                    }}
                    onChange={(e) => nameRename.setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.currentTarget.blur();
                      }
                      if (e.key === "Escape") {
                        nameRename.cancel();
                        e.currentTarget.blur();
                      }
                    }}
                    autoFocus
                    size="sm"
                    unstyled
                    value={nameValue}
                  />
                </>
              );
            }
            return (
              <>
                <MatterColorContextPicker
                  label={changeColorLabel}
                  matter={workspace}
                >
                  <MatterIcon
                    className="size-3.5"
                    matter={{ id: workspaceId, color: workspace.color }}
                  />
                </MatterColorContextPicker>
                <Link
                  activeOptions={{
                    exact: true,
                    includeSearch: false,
                  }}
                  activeProps={{
                    className: "text-foreground font-semibold",
                  }}
                  className="hover:text-foreground inline-flex max-w-80 items-center gap-1.5 font-semibold transition-colors"
                  onContextMenu={(e) => {
                    e.preventDefault();
                    startEditingName();
                  }}
                  params={{
                    workspaceId,
                  }}
                  title={displayName}
                  to="/workspaces/$workspaceId"
                >
                  <BidiText as="span" className="truncate">
                    {displayName}
                  </BidiText>
                  {workspace.reference && !isEditingRef ? (
                    <span
                      className="text-foreground-muted shrink-0 text-sm"
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        refRename.startEditing(workspace.reference);
                      }}
                    >
                      {workspace.reference}
                    </span>
                  ) : null}
                </Link>
              </>
            );
          })()}
          {isEditingRef ? referenceSegment : null}
          {referenceHint}
          {referenceConfirmationDialog}
        </BreadcrumbItem>
      </>
    );
  }

  if (isEditing) {
    return (
      <>
        {clientSegment}
        <BreadcrumbItem className="shrink-0">
          {colorPicker}
          <Input
            className={cn(matterNameInputClassName, "w-fit")}
            disabled={updateWorkspace.isPending}
            onBlur={() => {
              detached(nameRename.commit(), "workspace-breadcrumb.commit");
            }}
            onChange={(e) => nameRename.setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.currentTarget.blur();
              }
              if (e.key === "Escape") {
                nameRename.cancel();
                e.currentTarget.blur();
              }
            }}
            autoFocus
            size="sm"
            unstyled
            value={nameValue}
          />
          {referenceSegment}
          {referenceHint}
          {referenceConfirmationDialog}
        </BreadcrumbItem>
      </>
    );
  }

  return (
    <>
      {clientSegment}
      <BreadcrumbItem className="shrink-0">
        {colorPicker}
        <Link
          activeOptions={{ exact: true, includeSearch: false }}
          activeProps={{ className: "text-foreground font-semibold" }}
          className="hover:text-foreground max-w-80 truncate font-semibold transition-colors"
          dir="auto"
          onClick={() => {
            startEditingName();
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            startEditingName();
          }}
          params={{ workspaceId }}
          title={displayName}
          to="/workspaces/$workspaceId"
        >
          {displayName}
        </Link>
        {referenceSegment}
        {referenceHint}
        {referenceConfirmationDialog}
      </BreadcrumbItem>
    </>
  );
};
