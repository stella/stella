import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { produce } from "immer";
import {
  ArrowBigLeftDashIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  FoldHorizontalIcon,
  LayoutListIcon,
  ScanEyeIcon,
  SunMoonIcon,
  UnfoldHorizontalIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import { Separator } from "@stella/ui/components/separator";

import { useTheme } from "@/components/theme-provider";
import Tooltip from "@/components/tooltip";
import { fileOptions } from "@/routes/_protected.workspaces/$workspaceId/-components/files/queries";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";

const SCALE_OFFSET_STEP = 0.2;

export const PdfViewerControls = () => {
  const t = useTranslations();
  const { field: fieldId, pdfPage: currentPage = 1 } = useSearch({
    from: "/_protected/workspaces/$workspaceId/$viewId/pdf",
    select: (s) => ({ field: s.field, pdfPage: s.pdfPage }),
  });
  const workspaceId = useParams({
    from: "/_protected/workspaces/$workspaceId/$viewId/pdf",
    select: (p) => p.workspaceId,
  });

  const { data: isImageOrigin } = useQuery({
    ...fileOptions({ workspaceId, fieldId }),
    select: (file) => file.originalMimeType.startsWith("image/"),
  });

  const { resolvedTheme } = useTheme();
  const totalPages = useWorkspaceStore((s) => s.pdfPageCount);
  const scaleOffset = useWorkspaceStore((s) => s.pdfViewer.scaleOffset);
  const sidebar = useWorkspaceStore((s) => s.pdfViewer.sidebar);
  const setPdfScaleOffset = useWorkspaceStore((s) => s.setPdfScaleOffset);
  const setPdfSidebar = useWorkspaceStore((s) => s.setPdfSidebar);
  // TODO: invertPages toggle needs a small persisted store
  // or to be lifted to the route. For now, dark mode always
  // inverts (matching the viewer prop).
  const [editingPage, setEditingPage] = useState<number | null>(null);
  const pageInputValue = editingPage ?? currentPage;
  const navigate = useNavigate({
    from: "/workspaces/$workspaceId/$viewId/pdf",
  });

  const navigateToScale = (offset: number) => {
    setPdfScaleOffset(Math.round(offset * 10) / 10);
  };

  const navigateToPage = (pageNumber: number) => {
    // eslint-disable-next-line typescript/no-floating-promises
    navigate({
      replace: true,
      search: (prev) =>
        produce(prev, (s) => {
          s.pdfPage = pageNumber;
        }),
    });
  };

  return (
    <div className="ms-auto flex items-center justify-between">
      <Tooltip
        content={t("workspaces.pdf.goBack")}
        render={
          <Button
            // eslint-disable-next-line typescript/no-misused-promises
            onClick={async () =>
              await navigate({
                to: "/workspaces/$workspaceId",
              })
            }
            size="icon"
            variant="ghost"
          />
        }
      >
        <ArrowBigLeftDashIcon />
      </Tooltip>
      <Separator className="mx-1 h-4" orientation="vertical" />
      <Tooltip
        content={t("workspaces.pdf.zoomOut")}
        render={
          <Button
            disabled={scaleOffset <= -0.8}
            onClick={() => {
              navigateToScale(scaleOffset - SCALE_OFFSET_STEP);
            }}
            size="icon"
            variant="ghost"
          />
        }
      >
        <ZoomOutIcon />
      </Tooltip>
      <Tooltip
        content={t("workspaces.pdf.zoomIn")}
        render={
          <Button
            disabled={scaleOffset >= 2}
            onClick={() => {
              navigateToScale(scaleOffset + SCALE_OFFSET_STEP);
            }}
            size="icon"
            variant="ghost"
          />
        }
      >
        <ZoomInIcon />
      </Tooltip>
      <Tooltip
        content={t("workspaces.pdf.resetZoom")}
        render={
          <Button
            disabled={scaleOffset === 0}
            onClick={() => navigateToScale(0)}
            size="icon"
            variant="ghost"
          />
        }
      >
        {scaleOffset > 0 ? <FoldHorizontalIcon /> : <UnfoldHorizontalIcon />}
      </Tooltip>
      <Separator className="mx-1 h-4" orientation="vertical" />
      <Tooltip
        content={t("workspaces.pdf.previousPage")}
        render={
          <Button
            disabled={currentPage <= 1}
            onClick={() => {
              setEditingPage(null);
              navigateToPage(currentPage - 1);
            }}
            size="icon"
            variant="ghost"
          />
        }
      >
        <ChevronUpIcon />
      </Tooltip>
      <Tooltip
        content={t("workspaces.pdf.nextPage")}
        render={
          <Button
            disabled={currentPage >= totalPages}
            onClick={() => {
              setEditingPage(null);
              navigateToPage(currentPage + 1);
            }}
            size="icon"
            variant="ghost"
          />
        }
      >
        <ChevronDownIcon />
      </Tooltip>
      <div className="ms-1.5 me-2 flex gap-x-1.5 text-sm">
        <input
          aria-label={t("common.currentPage")}
          autoComplete="off"
          className="me-1 w-14 rounded border px-1 text-end"
          inputMode="numeric"
          onBlur={() => {
            if (
              editingPage !== null &&
              editingPage >= 1 &&
              editingPage <= totalPages
            ) {
              navigateToPage(editingPage);
            }
            setEditingPage(null);
          }}
          onChange={(e) => {
            const value = +e.target.value;
            if (Number.isNaN(value)) {
              return;
            }
            setEditingPage(value);
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter") {
              return;
            }
            e.currentTarget.blur();
          }}
          value={pageInputValue}
        />
        <span>/</span>
        <span>{totalPages}</span>
      </div>
      {resolvedTheme === "dark" && !isImageOrigin && (
        <>
          <Separator className="mx-1 h-4" orientation="vertical" />
          <Tooltip
            content={t("workspaces.pdf.adjustForDarkMode")}
            render={<Button disabled size="icon" variant="ghost" />}
          >
            <SunMoonIcon />
          </Tooltip>
        </>
      )}
      <Separator className="mx-1 h-4" orientation="vertical" />
      <Tooltip
        content={t("workspaces.pdf.entitySidebar")}
        render={
          <Button
            onClick={() =>
              setPdfSidebar(sidebar === "entity" ? "none" : "entity")
            }
            size="icon"
            variant={sidebar === "entity" ? "default" : "ghost"}
          />
        }
      >
        <LayoutListIcon />
      </Tooltip>
      <Tooltip
        content={t("workspaces.pdf.anonymizeSidebar")}
        render={
          <Button
            onClick={() =>
              setPdfSidebar(sidebar === "anonymize" ? "none" : "anonymize")
            }
            size="icon"
            variant={sidebar === "anonymize" ? "default" : "ghost"}
          />
        }
      >
        <ScanEyeIcon />
      </Tooltip>
    </div>
  );
};
