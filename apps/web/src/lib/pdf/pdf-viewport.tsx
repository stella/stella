import {
  startTransition,
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties, ReactNode } from "react";
import { useFormStatus } from "react-dom";

import { Result } from "better-result";
import { useTranslations } from "use-intl";
import { useShallow } from "zustand/react/shallow";

import { Button } from "@stll/ui/components/button";
import { Field, FieldError, FieldLabel } from "@stll/ui/components/field";
import { Input } from "@stll/ui/components/input";
import { ScrollArea } from "@stll/ui/components/scroll-area";

import { useTheme } from "@/components/theme-provider";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { usePageVisibility } from "@/lib/pdf/hooks/use-page-visibility";
import { usePDFControlledScaleOffset } from "@/lib/pdf/hooks/use-pdf-controlled-scale-offset";
import { usePDFDocument } from "@/lib/pdf/hooks/use-pdf-document";
import { usePDFExternalPageSync } from "@/lib/pdf/hooks/use-pdf-external-page-sync";
import { usePDFFitToWidth } from "@/lib/pdf/hooks/use-pdf-fit-to-width";
import { useTextSelection } from "@/lib/pdf/hooks/use-text-selection";
import { usePDFStore } from "@/lib/pdf/pdf-context";
import type { PDFDocument } from "@/lib/pdf/pdf-loader";
import type { PDFPageProps } from "@/lib/pdf/pdf-page";
import { approximateFraction } from "@/lib/pdf/pdfjs-utils";
import { getDevicePixelRatio } from "@/lib/pdf/utils";
import { composeRefs } from "@/lib/slot";

export { usePDFStore } from "@/lib/pdf/pdf-context";

const [, roundY] = approximateFraction(getDevicePixelRatio());

type PDFViewportProps = {
  fileId: string;
  buffer: ArrayBuffer;
  page?: number | undefined;
  onPageChanged?: ((page: number) => void) | undefined;
  onPageCountChanged?: ((count: number) => void) | undefined;
  password?: string | undefined;
  scaleOffset?: number | undefined;
  invertColors?: boolean | undefined;
  className?: string | undefined;
  contentClassName?: string | undefined;
  renderPage: (props: PDFPageProps) => ReactNode;
};

type PDFViewerContentProps = Omit<
  PDFViewportProps,
  "fallback" | "fileId" | "password" | "buffer"
> & {
  document: PDFDocument;
};

type PDFViewportStyle = CSSProperties & {
  "--pdf-page-filter": string;
  "--scale-factor": number;
  "--scale-round-x": string;
  "--scale-round-y": string;
};

export const PDFViewport = ({
  fileId,
  buffer,
  password: initialPassword,
  ...contentProps
}: PDFViewportProps) => {
  const [password, setPassword] = useState(initialPassword);

  // eslint-disable-next-line no-raw-use-effect/no-raw-use-effect -- reset-on-prop: re-sync local password to the initialPassword prop. Not pure derived state — setPassword is also driven by the password prompt below, so it cannot be computed in render; keep until a key-reset is wired through every PDFViewport call site.
  useEffect(() => {
    setPassword(initialPassword);
  }, [initialPassword]);

  const { data: result, refetch } = usePDFDocument({
    key: { fileId },
    context: { buffer, password },
  });

  if (Result.isOk(result)) {
    return <PDFViewerContent {...contentProps} document={result.value} />;
  }

  if (
    result.error.code === "PASSWORD_REQUIRED" ||
    result.error.code === "INCORRECT_PASSWORD"
  ) {
    return (
      <PDFPasswordPrompt
        onSubmit={(value) => {
          setPassword(value);
          refetch();
        }}
        incorrectPassword={result.error.code === "INCORRECT_PASSWORD"}
      />
    );
  }

  throw result.error;
};

const PDFViewerContent = ({
  document,
  page,
  onPageChanged,
  onPageCountChanged,
  scaleOffset = 0,
  invertColors,
  className,
  contentClassName,
  renderPage,
}: PDFViewerContentProps) => {
  const { resolvedTheme } = useTheme();
  const shouldInvert = invertColors ?? resolvedTheme === "dark";
  const [attachmentLabels, scale, pages, setDocument] = usePDFStore(
    useShallow((s) => [s.attachmentLabels, s.scale, s.pages, s.setDocument]),
  );

  const effectiveScale = scale + scaleOffset;
  const pageIds = useMemo(() => pages.keys().toArray(), [pages]);
  const viewportStyle: PDFViewportStyle = {
    "--pdf-page-filter": shouldInvert ? "invert(1) hue-rotate(180deg)" : "none",
    "--scale-factor": effectiveScale,
    "--scale-round-x": `${roundY}px`,
    "--scale-round-y": `${roundY}px`,
  };

  const containerRef = useRef<HTMLDivElement>(null);

  useExternalSyncEffect(() => {
    startTransition(() => {
      setDocument(document);
    });
  }, [document, setDocument]);

  useTextSelection(containerRef);
  const fitToWidthRef = usePDFFitToWidth({
    containerRef,
  });
  usePDFControlledScaleOffset({
    containerRef,
    controlledScaleOffset: scaleOffset,
  });
  const { containerRef: pageVisibilityRef, lastReportedPageRef } =
    usePageVisibility({
      pageIds,
      onPageChanged,
    });
  usePDFExternalPageSync({
    page,
    pageIds,
    lastReportedPageRef,
  });

  const onPageCountChangedEvent = useEffectEvent((count: number) => {
    onPageCountChanged?.(count);
  });

  // eslint-disable-next-line no-raw-use-effect/no-raw-use-effect -- notify the parent when the derived page count changes. The mutation lives in the zustand PDF store (out of this file), so there is no local setter to fold this into; keep until the store can emit the count itself.
  useEffect(() => {
    onPageCountChangedEvent(pageIds.length);
  }, [pageIds.length]);

  const pdfContentRef = useMemo(
    () => composeRefs(containerRef, fitToWidthRef, pageVisibilityRef),
    [fitToWidthRef, pageVisibilityRef],
  );

  return (
    <ScrollArea>
      <div className={className}>
        <div
          ref={pdfContentRef}
          className={contentClassName}
          style={viewportStyle}
        >
          {pageIds.map((pageId) => {
            const label = attachmentLabels.get(pageId);

            return (
              <div key={pageId}>
                {label && <PDFBanner label={label} />}
                {renderPage({ pageId })}
              </div>
            );
          })}
          <div className="h-px" />
        </div>
      </div>
    </ScrollArea>
  );
};

const PDFBanner = ({ label }: { label: string }) => (
  <div className="bg-muted text-muted-foreground mx-auto flex items-center justify-center rounded-md px-4 py-2 text-center text-sm">
    {label}
  </div>
);

type PDFPasswordPromptProps = {
  onSubmit: (password: string) => void;
  incorrectPassword: boolean;
};

const PDFPasswordPrompt = ({
  onSubmit,
  incorrectPassword,
}: PDFPasswordPromptProps) => {
  const id = useId();
  const t = useTranslations();
  const [value, setValue] = useState("");

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 px-4 py-6">
      <form
        action={() => {
          onSubmit(value);
        }}
        className="w-full max-w-sm space-y-3"
      >
        <Field invalid={incorrectPassword}>
          <FieldLabel htmlFor={id}>
            {t("workspaces.pdf.passwordLabel")}
          </FieldLabel>
          <Input
            aria-invalid={incorrectPassword}
            autoComplete="off"
            id={id}
            onChange={(e) => {
              setValue(e.target.value);
            }}
            type="password"
            value={value}
          />
          {incorrectPassword && (
            <FieldError match>
              {t("workspaces.pdf.incorrectPassword")}
            </FieldError>
          )}
        </Field>
        <PDFPasswordSubmitButton label={t("workspaces.pdf.unlock")} />
      </form>
    </div>
  );
};

const PDFPasswordSubmitButton = ({ label }: { label: string }) => {
  const { pending } = useFormStatus();
  return (
    <Button className="w-full" disabled={pending} type="submit">
      {label}
    </Button>
  );
};
