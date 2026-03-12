import { useState } from "react";

import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, useMatch } from "@tanstack/react-router";
import type { ResolveParams } from "@tanstack/react-router";
import { LayersIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import {
  BreadcrumbItem,
  BreadcrumbSeparator,
} from "@stella/ui/components/breadcrumb";
import { Input } from "@stella/ui/components/input";
import {
  Popover,
  PopoverPopup,
  PopoverTrigger,
} from "@stella/ui/components/popover";

import { BreadcrumbLink } from "@/components/breadcrumbs/shared";
import { getMatterSwatch, MATTER_SWATCHES } from "@/lib/matter-colors";
import { useUpdateWorkspace } from "@/routes/_protected.workspaces/-mutations";
import { workspaceOptions } from "@/routes/_protected.workspaces/-queries";

const resolveColor = (color: string | null | undefined, id: string) =>
  color ? `var(${color})` : `var(${getMatterSwatch(id)})`;

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
  const [refValue, setRefValue] = useState("");
  const [isEditingRef, setIsEditingRef] = useState(false);
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const { data: workspace } = useSuspenseQuery(workspaceOptions(workspaceId));
  const updateWorkspace = useUpdateWorkspace();
  const displayName = workspace.name ?? workspaceId;

  const handleSaveProjectName = () => {
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
    setIsEditingRef(false);

    const trimmed = refValue.trim();
    const current = workspace.reference ?? "";

    if (trimmed === current) {
      return;
    }

    updateWorkspace.mutate({
      workspaceId,
      reference: trimmed || null,
    });
  };

  const handleColorChange = (swatch: string) => {
    setColorPickerOpen(false);
    updateWorkspace.mutate({
      workspaceId,
      color: swatch,
    });
  };

  const activeColor = resolveColor(workspace.color, workspaceId);

  const colorPicker = match ? (
    <Popover onOpenChange={setColorPickerOpen} open={colorPickerOpen}>
      <PopoverTrigger
        className="hover:bg-muted cursor-pointer rounded p-0.5 transition-colors"
        render={<button type="button" />}
      >
        <LayersIcon
          className="size-3.5 shrink-0"
          style={{ color: activeColor }}
        />
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-auto" sideOffset={8}>
        <div className="flex gap-1.5">
          {MATTER_SWATCHES.map((swatch) => (
            <button
              className="size-5 rounded-full transition-transform hover:scale-125"
              key={swatch}
              onClick={() => handleColorChange(swatch)}
              style={{
                backgroundColor: `var(${swatch})`,
              }}
              type="button"
            />
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  ) : (
    <LayersIcon className="size-3.5 shrink-0" style={{ color: activeColor }} />
  );

  const clientSegment = workspace.client ? (
    <>
      <BreadcrumbItem>
        <Link
          className="hover:text-foreground max-w-48 truncate transition-colors"
          onClick={() => {
            try {
              const raw = localStorage.getItem("matters_overview_config");
              const parsed: unknown = raw ? JSON.parse(raw) : null;
              const config: Record<string, unknown> =
                typeof parsed === "object" && parsed !== null
                  ? // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: guarded by typeof/parsed check
                    (parsed as Record<string, unknown>)
                  : {};
              config.clientFilter = workspace.client?.id ?? null;
              localStorage.setItem(
                "matters_overview_config",
                JSON.stringify(config),
              );
            } catch {
              // localStorage may throw in private browsing
            }
          }}
          to="/workspaces"
        >
          {workspace.client.displayName}
        </Link>
      </BreadcrumbItem>
      <BreadcrumbSeparator />
    </>
  ) : null;

  const referenceSegment = isEditingRef ? (
    <Input
      className="w-28 text-sm"
      onBlur={handleSaveReference}
      onChange={(e) => setRefValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          handleSaveReference();
        }
        if (e.key === "Escape") {
          setIsEditingRef(false);
        }
      }}
      placeholder={t("workspaces.referencePlaceholder")}
      ref={(el) => {
        el?.focus();
      }}
      value={refValue}
    />
  ) : workspace.reference ? (
    <button
      className="text-muted-foreground/60 hover:text-muted-foreground cursor-text text-sm"
      onClick={() => {
        if (!match) {
          return;
        }
        setRefValue(workspace.reference ?? "");
        setIsEditingRef(true);
      }}
      type="button"
    >
      {workspace.reference}
    </button>
  ) : null;

  if (isEditing) {
    return (
      <>
        {clientSegment}
        {colorPicker}
        <Input
          className="w-fit"
          disabled={updateWorkspace.isPending}
          onBlur={() => handleSaveProjectName()}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              handleSaveProjectName();
            }
          }}
          ref={(el) => {
            el?.focus();
          }}
          value={value || displayName}
        />
        {referenceSegment}
      </>
    );
  }

  return (
    <>
      {clientSegment}
      {colorPicker}
      <BreadcrumbLink
        onClick={() => {
          if (!match) {
            return;
          }

          setIsEditing(true);
        }}
        to="/workspaces/$workspaceId"
      >
        {displayName}
      </BreadcrumbLink>
      {referenceSegment}
    </>
  );
};
