import { Suspense, useState } from "react";

import { useSuspenseQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { useObjectUrl } from "@stll/ui/effects-dom";

import { DefaultPendingComponent } from "@/components/default-pending";
import { FilePreviewUnavailable } from "@/components/inspector/inspector-pdf-error-fallback";
import type { FileTab } from "@/components/inspector/inspector-tabs-store";
import { TranscribeRecording } from "@/components/inspector/transcribe-recording";
import { RecoverableViewerBoundary } from "@/components/viewer/recoverable-viewer-boundary";
import { fileOptions } from "@/lib/files/queries";

type AudioFileViewerProps = {
  onDownload: () => void;
  tab: FileTab;
};

const AudioPlayer = ({ onDownload, tab }: AudioFileViewerProps) => {
  const t = useTranslations();
  const { data } = useSuspenseQuery(
    fileOptions({
      fieldId: tab.id,
      purpose: "native-display",
      workspaceId: tab.workspaceId,
    }),
  );
  // Played from memory: the file link streams without ranges, so a player
  // reading it could not seek.
  const src = useObjectUrl(new Blob([data.buffer], { type: data.mimeType }));
  const [unplayable, setUnplayable] = useState(false);

  const transcribe = (
    <TranscribeRecording
      entityId={tab.entityId}
      fieldId={tab.id}
      workspaceId={tab.workspaceId}
    />
  );

  if (unplayable) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center pb-6">
        <FilePreviewUnavailable
          message={t("inspector.audioUnplayable")}
          onDownload={onDownload}
        />
        {transcribe}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6">
      {/* oxlint-disable-next-line jsx-a11y/media-has-caption -- a recording has no captions until it is transcribed */}
      <audio
        aria-label={data.fileName}
        className="w-full max-w-xl"
        controls
        onError={() => setUnplayable(true)}
        src={src}
      />
      {transcribe}
    </div>
  );
};

/** A recording played from its original file. */
export const AudioFileViewer = ({ onDownload, tab }: AudioFileViewerProps) => (
  <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
    <RecoverableViewerBoundary
      key={tab.id}
      onDownload={onDownload}
      surface="inspector-audio"
    >
      <Suspense fallback={<DefaultPendingComponent />}>
        <AudioPlayer onDownload={onDownload} tab={tab} />
      </Suspense>
    </RecoverableViewerBoundary>
  </div>
);
