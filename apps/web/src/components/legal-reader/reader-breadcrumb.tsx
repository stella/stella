import { useState } from "react";
import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { ChevronRightIcon } from "@stll/ui/icons";
import { Popover, PopoverPopup, PopoverTrigger } from "@stll/ui/popover";
import { ScrollArea } from "@stll/ui/scroll-area";
import { cn } from "@stll/ui/utils";

import {
  compactReaderPath,
  fitReaderPath,
  readerProvisionNumber,
} from "./reader-breadcrumb.logic";
import type { ReaderBreadcrumbSegment } from "./reader-breadcrumb.logic";

type ReaderBreadcrumbProps = {
  path: readonly ReaderBreadcrumbSegment[];
  headings: readonly ReaderBreadcrumbSegment[];
  onJump: (anchorId: string) => void;
};

export const ReaderBreadcrumb = ({
  path,
  headings,
  onJump,
}: ReaderBreadcrumbProps) => {
  const t = useTranslations();
  const { visible, hidden } = compactReaderPath(path);
  const [layout, setLayout] = useState<ReturnType<typeof fitReaderPath>>();
  const [contentsOpen, setContentsOpen] = useState(false);
  const [middleOpen, setMiddleOpen] = useState(false);
  const current = path.at(-1);
  const currentNumber = readerProvisionNumber(current?.title ?? "");
  const currentWidth =
    current === undefined ? undefined : layout?.widths.at(-1);
  const measure = (node: HTMLElement | null) => {
    if (node === null) {
      return undefined;
    }
    const update = () => {
      if (node.clientWidth === 0) {
        return;
      }
      const labels = compactReaderPath(path).visible.flatMap(({ anchorId }) => {
        const label = node.querySelector<HTMLElement>(
          `[data-breadcrumb-measure="${CSS.escape(anchorId)}"]`,
        );
        return label === null ? [] : [label];
      });
      const number = node.querySelector<HTMLElement>(
        "[data-breadcrumb-number-measure]",
      );
      const naturalWidths = labels.map(
        (label) => label.getBoundingClientRect().width + 16,
      );
      const minimumWidths = labels.map((_, index) =>
        index === labels.length - 1
          ? Math.max(44, (number?.getBoundingClientRect().width ?? 0) + 16)
          : 16,
      );
      const fitted = fitReaderPath({
        available: node.clientWidth,
        separatorWidth: 16,
        middleWidth: hidden.length === 0 ? 0 : 60,
        naturalWidths,
        minimumWidths,
      });
      setLayout((previous) =>
        previous?.showMiddle === fitted.showMiddle &&
        previous.widths.length === fitted.widths.length &&
        previous.widths.every((width, index) => width === fitted.widths[index])
          ? previous
          : fitted,
      );
    };
    const observer = new ResizeObserver(update);
    observer.observe(node);
    for (const label of node.querySelectorAll<HTMLElement>(
      "[data-breadcrumb-measure]",
    )) {
      observer.observe(label);
    }
    update();
    return () => observer.disconnect();
  };
  const contentsRef = (node: HTMLDivElement | null) => {
    if (node === null || current === undefined) {
      return;
    }
    node
      .querySelector<HTMLElement>(
        `[data-contents-anchor="${CSS.escape(current.anchorId)}"]`,
      )
      ?.scrollIntoView({ block: "nearest" });
  };
  const entries = (
    segments: readonly ReaderBreadcrumbSegment[],
    close: () => void,
  ) => (
    <ol>
      {segments.map(({ anchorId, title }) => (
        <li key={anchorId}>
          <Button
            aria-current={
              anchorId === current?.anchorId ? "location" : undefined
            }
            className="min-h-11 w-full justify-start text-start whitespace-normal"
            data-contents-anchor={anchorId}
            onClick={() => {
              onJump(anchorId);
              close();
            }}
            variant="ghost"
          >
            <bdi>{title}</bdi>
          </Button>
        </li>
      ))}
    </ol>
  );
  const contentsControl = ({
    label,
    title,
    width,
  }: {
    label: ReactNode;
    title?: string;
    width?: number;
  }) => (
    <Popover open={contentsOpen} onOpenChange={setContentsOpen}>
      <PopoverTrigger
        aria-label={
          title === undefined
            ? t("statutes.outline")
            : `${t("statutes.outline")}: ${title}`
        }
        render={
          <Button
            className="h-11 min-w-0 sm:h-11"
            size="xs"
            style={{ width }}
            variant="ghost"
          />
        }
        title={title}
      >
        {label}
      </PopoverTrigger>
      <PopoverPopup
        align="end"
        aria-label={t("statutes.outline")}
        className="w-80 max-w-[calc(100vw-2rem)]"
        padding="sm"
      >
        <ScrollArea
          axis="vertical"
          className="max-h-72"
          viewportRef={contentsRef}
        >
          {entries(headings, () => setContentsOpen(false))}
        </ScrollArea>
      </PopoverPopup>
    </Popover>
  );
  return (
    <nav
      aria-label={t("statutes.outline")}
      className="relative min-w-0 flex-1 overflow-hidden"
      data-slot="reader-breadcrumb"
      ref={measure}
    >
      <span aria-atomic="true" aria-live="polite" className="sr-only">
        {path.map(({ title }) => title).join(" › ")}
      </span>
      <div
        aria-hidden="true"
        className="pointer-events-none invisible absolute flex w-max text-sm whitespace-nowrap sm:text-xs"
      >
        {visible.map(({ anchorId, title }) => (
          <span data-breadcrumb-measure={anchorId} key={anchorId}>
            {title}
          </span>
        ))}
        <span data-breadcrumb-number-measure>
          {readerProvisionNumber(current?.title ?? "")}
        </span>
      </div>
      <ol className="flex h-11 min-w-0 items-center">
        {visible.slice(0, -1).map((segment, index) => {
          if (layout?.widths[index] === 0) {
            return null;
          }
          return (
            <li
              className="flex min-w-0 shrink-0 items-center"
              key={segment.anchorId}
            >
              {index > 0 &&
                visible
                  .slice(0, index)
                  .some(
                    (_, previousIndex) => layout?.widths[previousIndex] !== 0,
                  ) && (
                  <DirectionalIcon
                    aria-hidden="true"
                    className="size-4 shrink-0"
                    icon={ChevronRightIcon}
                  />
                )}
              <Button
                aria-label={segment.title}
                className="h-11 min-w-0 sm:h-11"
                size="xs"
                onClick={() => onJump(segment.anchorId)}
                style={{ width: layout?.widths[index] }}
                title={segment.title}
                variant="ghost"
              >
                <bdi className="truncate">{segment.title}</bdi>
              </Button>
              {index === 0 &&
                hidden.length > 0 &&
                (layout?.showMiddle ?? true) && (
                  <>
                    <DirectionalIcon
                      aria-hidden="true"
                      className="size-4 shrink-0"
                      icon={ChevronRightIcon}
                    />
                    <Popover
                      open={middleOpen}
                      onOpenChange={(open, { reason }) => {
                        setMiddleOpen(reason === "trigger-press" || open);
                      }}
                    >
                      <PopoverTrigger
                        aria-label={t("common.showMore")}
                        onMouseEnter={() => setMiddleOpen(true)}
                        render={
                          <Button
                            className="size-11 shrink-0"
                            variant="ghost"
                          />
                        }
                      >
                        …
                      </PopoverTrigger>
                      <PopoverPopup
                        align="start"
                        aria-label={t("common.showMore")}
                        className="w-80 max-w-[calc(100vw-2rem)]"
                        padding="sm"
                      >
                        <ScrollArea axis="vertical" className="max-h-72">
                          {entries(hidden, () => setMiddleOpen(false))}
                        </ScrollArea>
                      </PopoverPopup>
                    </Popover>
                  </>
                )}
            </li>
          );
        })}
        {(current !== undefined || headings.length > 0) && (
          // Keep the Contents root and trigger mounted as scrolling changes
          // the path; Base UI associates an open popup with its trigger id.
          <li className="flex min-w-0 shrink-0 items-center">
            {visible
              .slice(0, -1)
              .some((_, index) => layout?.widths[index] !== 0) && (
              <DirectionalIcon
                aria-hidden="true"
                className="size-4 shrink-0"
                icon={ChevronRightIcon}
              />
            )}
            {contentsControl({
              label:
                current === undefined ? (
                  t("statutes.outline")
                ) : (
                  <span className="flex min-w-0 items-center">
                    <bdi
                      className={cn(
                        currentNumber === null ? "truncate" : "shrink-0",
                      )}
                    >
                      {currentNumber ?? current.title}
                    </bdi>
                    {currentNumber !== null && (
                      <bdi className="ms-1 truncate">
                        {current.title.replace(currentNumber, "").trim()}
                      </bdi>
                    )}
                  </span>
                ),
              ...(current === undefined ? {} : { title: current.title }),
              ...(currentWidth === undefined ? {} : { width: currentWidth }),
            })}
          </li>
        )}
      </ol>
    </nav>
  );
};
