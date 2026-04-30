import {
  startTransition,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  useTransition,
} from "react";
import type { CSSProperties, ReactNode } from "react";

import { Button } from "@stll/ui/components/button";
import { Field, FieldError, FieldLabel } from "@stll/ui/components/field";
import { Input } from "@stll/ui/components/input";
import { ScrollArea } from "@stll/ui/components/scroll-area";
import { Result } from "better-result";
import { useTranslations } from "use-intl";
import { useShallow } from "zustand/react/shallow";

import { useTheme } from "@/components/theme-provider";
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
  renderPage: (props: PDFPageProps) => ReactNode;
};

type PDFViewerContentProps = Omit<
  PDFViewportProps,
  "fallback" | "fileId" | "password" | "buffer"
> & {
  document: PDFDocument;
};

export const PDFViewport = ({
  fileId,
  buffer,
  password: initialPassword,
  ...contentProps
}: PDFViewportProps) => {
  const [password, setPassword] = useState(initialPassword);

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
  renderPage,
}: PDFViewerContentProps) => {
  const { resolvedTheme } = useTheme();
  const shouldInvert = invertColors ?? resolvedTheme === "dark";
  const [attachmentLabels, scale, pages, setDocument] = usePDFStore(
    useShallow((s) => [s.attachmentLabels, s.scale, s.pages, s.setDocument]),
  );

  const effectiveScale = scale + scaleOffset;
  const pageIds = pages.keys().toArray();

  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    startTransition(() => {
      setDocument(document);
    });
  }, [document, setDocument]);

  useTextSelection(containerRef);
  usePDFFitToWidth({
    containerRef,
  });
  usePDFControlledScaleOffset({
    containerRef,
    controlledScaleOffset: scaleOffset,
  });
  const lastReportedPageRef = usePageVisibility({
    containerRef,
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

  useEffect(() => {
    onPageCountChangedEvent(pageIds.length);
  }, [pageIds.length]);

  return (
    <ScrollArea>
      <div
        ref={containerRef}
        className={className}
        style={
          {
            "--scale-factor": effectiveScale,
            "--scale-round-x": `${roundY}px`,
            "--scale-round-y": `${roundY}px`,
            ...(shouldInvert && {
              filter: "invert(1) hue-rotate(180deg)",
            }),
            // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
          } as CSSProperties
        }
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
  const [isPending, startFormTransition] = useTransition();

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 px-4 py-6">
      <form
        className="w-full max-w-sm space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          startFormTransition(() => {
            onSubmit(value);
          });
        }}
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
        <Button className="w-full" disabled={isPending} type="submit">
          {t("workspaces.pdf.unlock")}
        </Button>
      </form>
    </div>
  );
};
