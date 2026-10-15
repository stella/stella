import type { ReactElement, ReactNode } from "react";

import { panic } from "better-result";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import {
  PreviewCard,
  PreviewCardPopup,
  PreviewCardTrigger,
} from "@stll/ui/preview-card";
import { Skeleton } from "@stll/ui/skeleton";

import { useReaderAdapters, useReaderMessages } from "./reader-adapters";
import type { ProvisionWordingVersion } from "./reader-adapters";
import { ReaderInsetBox } from "./reader-inset-box";
import type {
  CitedProvisionTarget,
  ProvisionPreviewData,
  ProvisionViewPayload,
} from "./reader-types";

export type ProvisionWordingState = {
  isPending: boolean;
  wording: ProvisionPreviewData | undefined;
};
export type CitedProvisionLinkProps = ProvisionWordingState & {
  children: ReactNode;
  provision: CitedProvisionTarget;
  previewOpen: boolean;
  onPreviewOpenChange: (open: boolean) => void;
  link: ReactElement;
};
const ProvisionWordingSkeleton = () => (
  <>
    <Skeleton className="h-3 w-full" />
    <Skeleton className="h-3 w-5/6" />
  </>
);

/** The heading trail the provision sits under, then the provision itself. */
const ProvisionWording = ({ wording }: { wording: ProvisionPreviewData }) => (
  <>
    {wording.headings.length > 0 && (
      <BidiText
        as="span"
        className="text-muted-foreground truncate text-xs"
        lang={wording.language}
      >
        {wording.headings.map(({ text }) => text).join(" › ")}
      </BidiText>
    )}
    <span
      className="reader-body text-foreground flex max-h-64 flex-col gap-2 overflow-y-auto text-sm leading-relaxed text-pretty"
      lang={wording.language}
    >
      {wording.blocks.map((block) => (
        <span key={block.id}>{block.text}</span>
      ))}
    </span>
  </>
);

const CitedProvisionPreview = ({
  isPending,
  wording,
}: ProvisionWordingState) => {
  if (wording === undefined) {
    return !isPending ? null : (
      <span className="mt-2 flex flex-col gap-1.5 border-t pt-2">
        <ProvisionWordingSkeleton />
      </span>
    );
  }
  if (wording.blocks.length === 0) {
    return null;
  }
  return (
    <span className="mt-2 flex flex-col gap-1 border-t pt-2">
      <ProvisionWording wording={wording} />
    </span>
  );
};

const ProvisionVersionLabel = ({
  version,
}: {
  version: ProvisionWordingVersion;
}) => {
  const messages = useReaderMessages();
  switch (version.type) {
    case "current":
      return (
        <span className="reader-chrome text-muted-foreground text-xs">
          {messages["statutes.currentWording"]}
        </span>
      );
    case "consolidation": {
      const date = messages.formatValidityDate(version.validFrom);
      return (
        <span className="reader-chrome text-muted-foreground text-xs">
          {date === null
            ? messages["statutes.wordingVersionUnknown"]
            : messages.wordingValidFrom(date)}
        </span>
      );
    }
    default:
      version satisfies never;
      return panic("Unhandled provision wording version");
  }
};

const OpenCitedProvisionButton = ({
  provision,
}: {
  provision: ProvisionViewPayload;
}) => {
  const messages = useReaderMessages();
  const { openProvision } = useReaderAdapters();
  return (
    <span className="reader-chrome">
      <Button
        className="w-fit"
        onClick={() => openProvision(provision)}
        size="xs"
        variant="outline"
      >
        {messages["statutes.openProvision"]}
      </Button>
    </span>
  );
};

/** Rendered by the paragraph owner, never by its inline citation link. */
export const CitedProvisionExpansion = ({
  label,
  provision,
  version,
  isPending,
  wording,
}: ProvisionWordingState & {
  label: string;
  provision: CitedProvisionTarget;
  version: ProvisionWordingVersion;
}) => (
  <ReaderInsetBox
    className="my-3 flex flex-col gap-2"
    data-reader-chrome=""
    data-slot="provision-card"
  >
    <span className="reader-chrome">
      <BidiText as="span" className="text-sm font-medium">
        {label}
      </BidiText>
    </span>
    <ProvisionVersionLabel version={version} />
    {wording !== undefined && wording.blocks.length > 0 && (
      <ProvisionWording wording={wording} />
    )}
    {wording === undefined && isPending && <ProvisionWordingSkeleton />}
    <OpenCitedProvisionButton provision={provision.payload} />
  </ReaderInsetBox>
);

/** Hover or a plain click peeks at wording without interrupting the sentence. */
export const CitedProvisionLink = ({
  children,
  provision,
  previewOpen,
  onPreviewOpenChange,
  link,
  isPending,
  wording,
}: CitedProvisionLinkProps) => (
  <PreviewCard onOpenChange={onPreviewOpenChange} open={previewOpen}>
    <PreviewCardTrigger render={link}>{children}</PreviewCardTrigger>
    <PreviewCardPopup className="reader-chrome w-[min(32rem,calc(100vw-2rem))] max-w-none flex-col gap-0.5 p-3">
      <BidiText as="span" className="text-foreground text-sm font-medium">
        {provision.payload.provisionLabel}
      </BidiText>
      {provision.payload.statuteTitle !== "" && (
        <span className="text-muted-foreground text-xs">
          {provision.payload.statuteTitle}
        </span>
      )}
      <ProvisionVersionLabel
        version={{
          type: "consolidation",
          validFrom: provision.document.versionValidFrom,
        }}
      />
      <CitedProvisionPreview isPending={isPending} wording={wording} />
      <OpenCitedProvisionButton provision={provision.payload} />
    </PreviewCardPopup>
  </PreviewCard>
);
