import { useRef, useState } from "react";

import {
  BreadcrumbItem,
  BreadcrumbSeparator,
} from "@stll/ui/components/breadcrumb";
import {
  ColorPicker,
  ColorPickerContent,
  DEFAULT_PRESETS,
} from "@stll/ui/components/color-picker";
import { Input } from "@stll/ui/components/input";
import { Popover, PopoverPopup } from "@stll/ui/components/popover";
import { toastManager } from "@stll/ui/components/toast";
import { useQuery } from "@tanstack/react-query";
import { Link, useMatch } from "@tanstack/react-router";
import type { ResolveParams } from "@tanstack/react-router";
import { LayersIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { BreadcrumbLink } from "@/components/breadcrumbs/shared";
import { MatterNumberHint } from "@/components/matter-number-hint";
import { APIError } from "@/lib/errors";
import {
  getMatterPickerColor,
  resolveMatterColor,
  toStoredMatterColor,
} from "@/lib/matter-colors";
import { useUpdateWorkspace } from "@/routes/_protected.workspaces/-mutations";
import { workspaceOptions } from "@/routes/_protected.workspaces/-queries";

const breadcrumbInputClassName =
  "border-input bg-background text-foreground inline-flex rounded-md border text-sm shadow-xs/5 transition-colors has-focus-visible:border-ring";

const matterNameInputClassName = `${breadcrumbInputClassName} font-semibold`;

export const WorkspaceBreadcrumb = ({
  workspaceId,
}: ResolveParams<"/workspaces/$workspaceId">) => {
  const t = useTranslations();
  const match = useMatch({
    from: "/_protected/workspaces/$workspaceId/",
    shouldThrow: false,
  });
  const [value, setValue] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const escapedNameRef = useRef(false);
  const [refValue, setRefValue] = useState("");
  const [isEditingRef, setIsEditingRef] = useState(false);
  const [refError, setRefError] = useState("");
  const [refInputEl, setRefInputEl] = useState<HTMLInputElement | null>(null);
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const [iconAnchor, setIconAnchor] = useState<HTMLSpanElement | null>(null);
  const { data: workspace } = useQuery(workspaceOptions(workspaceId));
  const updateWorkspace = useUpdateWorkspace();

  if (!workspace) {
    return (
      <BreadcrumbLink to="/workspaces/$workspaceId">
        {workspaceId}
      </BreadcrumbLink>
    );
  }

  const displayName = workspace.name ?? workspaceId;

  const startEditingName = () => {
    escapedNameRef.current = false;
    setValue(displayName);
    setIsEditing(true);
  };

  const handleSaveProjectName = () => {
    if (escapedNameRef.current) {
      escapedNameRef.current = false;
      setValue(displayName);
      setIsEditing(false);
      return;
    }

    setIsEditing(false);

    const workspaceName = value.trim();

    if (!workspaceName || workspaceName === workspace.name) {
      return;
    }

    updateWorkspace.mutate({
      workspaceId,
      name: workspaceName,
    });
  };

  const handleSaveReference = () => {
    const trimmed = refValue.trim();

    if (!trimmed || trimmed === workspace.reference) {
      setIsEditingRef(false);
      setRefError("");
      return;
    }

    setRefError("");
    updateWorkspace.mutate(
      {
        workspaceId,
        reference: trimmed,
      },
      {
        onSuccess: () => {
          setIsEditingRef(false);
        },
        onError: (error) => {
          if (APIError.is(error) && error.status === 409) {
            setRefError(t("workspaces.referenceTaken"));
            refInputEl?.focus();
            return;
          }

          const message =
            APIError.is(error) && error.status < 500
              ? error.message
              : t("errors.actionFailed");
          toastManager.add({ title: message, type: "error" });
          setIsEditingRef(false);
        },
      },
    );
  };

  const handleColorChange = (color: string) => {
    updateWorkspace.mutate({
      workspaceId,
      color: toStoredMatterColor(color),
    });
  };

  const activeColor = resolveMatterColor(workspaceId, workspace.color);
  const activeSwatch = getMatterPickerColor(workspaceId, workspace.color);
  const changeColorLabel = t("common.changeColor");

  const colorPicker = match ? (
    <ColorPicker
      defaultExpanded={false}
      onSelect={handleColorChange}
      value={activeSwatch}
    >
      <button
        aria-label={changeColorLabel}
        className="hover:bg-muted cursor-pointer rounded p-0.5 transition-colors"
        title={changeColorLabel}
        type="button"
      >
        <LayersIcon
          className="size-3.5 shrink-0"
          style={{ color: activeColor }}
        />
      </button>
    </ColorPicker>
  ) : (
    <LayersIcon className="size-3.5 shrink-0" style={{ color: activeColor }} />
  );

  const clientSegment = workspace.client ? (
    <>
      <BreadcrumbItem className="min-w-8 shrink">
        <Link
          className="hover:text-foreground min-w-0 truncate transition-colors"
          onClick={() => {
            try {
              const raw = localStorage.getItem("matters_overview_config");
              const parsed: unknown = raw ? JSON.parse(raw) : null;
              const config: Record<string, unknown> =
                typeof parsed === "object" && parsed !== null
                  ? // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
                    (parsed as Record<string, unknown>)
                  : {};
              config["clientFilter"] = workspace.client?.id ?? null;
              localStorage.setItem(
                "matters_overview_config",
                JSON.stringify(config),
              );
            } catch {
              // localStorage may throw in private browsing
            }
          }}
          title={workspace.client.displayName}
          to="/workspaces"
        >
          {workspace.client.displayName}
        </Link>
      </BreadcrumbItem>
      <BreadcrumbSeparator className="shrink-0" />
    </>
  ) : (
    <>
      <BreadcrumbItem className="min-w-8 shrink">
        <span
          className="text-muted-foreground min-w-0 truncate"
          title={t("workspaces.parties.personalLabel")}
        >
          {t("workspaces.parties.personalLabel")}
        </span>
      </BreadcrumbItem>
      <BreadcrumbSeparator className="shrink-0" />
    </>
  );

  const referenceSegment = isEditingRef ? (
    <Input
      className={`${breadcrumbInputClassName} w-28 text-sm`}
      onBlur={handleSaveReference}
      onChange={(e) => {
        setRefValue(e.target.value);
        setRefError("");
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          handleSaveReference();
        }
        if (e.key === "Escape") {
          setIsEditingRef(false);
          setRefError("");
        }
      }}
      placeholder={t("workspaces.referencePlaceholder")}
      ref={(el) => {
        setRefInputEl(el);
        el?.focus();
      }}
      size="sm"
      unstyled
      value={refValue}
    />
  ) : workspace.reference ? (
    <button
      className="text-muted-foreground/60 hover:text-muted-foreground cursor-text text-sm"
      onClick={() => {
        setRefValue(workspace.reference ?? "");
        setRefError("");
        setIsEditingRef(true);
      }}
      type="button"
    >
      {workspace.reference}
    </button>
  ) : null;

  const referenceHint = (
    <MatterNumberHint
      anchor={refInputEl}
      error={refError}
      open={isEditingRef}
      value={refValue}
      variant="popover"
    />
  );

  if (!match) {
    return (
      <>
        {clientSegment}
        <BreadcrumbItem className="shrink-0">
          {isEditing ? (
            <>
              <span
                className="flex shrink-0"
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setColorPickerOpen(true);
                }}
                ref={setIconAnchor}
              >
                <LayersIcon
                  className="size-3.5"
                  style={{ color: activeColor }}
                />
              </span>
              <Input
                className={`${matterNameInputClassName} w-fit`}
                disabled={updateWorkspace.isPending}
                onBlur={() => handleSaveProjectName()}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    handleSaveProjectName();
                  }
                  if (e.key === "Escape") {
                    escapedNameRef.current = true;
                    e.currentTarget.blur();
                  }
                }}
                ref={(el) => {
                  el?.focus();
                }}
                size="sm"
                unstyled
                value={value || displayName}
              />
            </>
          ) : (
            <Link
              activeOptions={{ exact: true, includeSearch: false }}
              activeProps={{ className: "text-foreground font-semibold" }}
              className="hover:text-foreground inline-flex max-w-80 items-center gap-1.5 font-semibold transition-colors"
              onContextMenu={(e) => {
                e.preventDefault();
                startEditingName();
              }}
              params={{ workspaceId }}
              title={displayName}
              to="/workspaces/$workspaceId"
            >
              <span
                className="flex shrink-0"
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setColorPickerOpen(true);
                }}
                ref={setIconAnchor}
              >
                <LayersIcon
                  className="size-3.5"
                  style={{ color: activeColor }}
                />
              </span>
              <span className="truncate">{displayName}</span>
              {workspace.reference && !isEditingRef ? (
                <span
                  className="text-muted-foreground/60 shrink-0 text-sm"
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setRefValue(workspace.reference ?? "");
                    setRefError("");
                    setIsEditingRef(true);
                  }}
                >
                  {workspace.reference}
                </span>
              ) : null}
            </Link>
          )}
          {isEditingRef ? referenceSegment : null}
          {referenceHint}
        </BreadcrumbItem>
        <Popover onOpenChange={setColorPickerOpen} open={colorPickerOpen}>
          <PopoverPopup
            align="start"
            anchor={iconAnchor}
            className="w-auto"
            sideOffset={8}
          >
            <ColorPickerContent
              columns={9}
              defaultExpanded={false}
              onSelect={handleColorChange}
              presets={DEFAULT_PRESETS}
              value={activeSwatch}
            />
          </PopoverPopup>
        </Popover>
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
            className={`${matterNameInputClassName} w-fit`}
            disabled={updateWorkspace.isPending}
            onBlur={() => handleSaveProjectName()}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                handleSaveProjectName();
              }
              if (e.key === "Escape") {
                escapedNameRef.current = true;
                e.currentTarget.blur();
              }
            }}
            ref={(el) => {
              el?.focus();
            }}
            size="sm"
            unstyled
            value={value || displayName}
          />
          {referenceSegment}
          {referenceHint}
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
      </BreadcrumbItem>
    </>
  );
};
