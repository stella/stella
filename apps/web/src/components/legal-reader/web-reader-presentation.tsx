import type { ReactElement, ReactNode } from "react";

import { ReaderPresentationProvider } from "@stll/decision-reader/reader-adapters";
import type {
  PermalinkCopyState,
  ReaderPresentationAdapters,
} from "@stll/decision-reader/reader-adapters";

import { useCopyControl } from "@/components/copy-control";
import { useWebReaderMessages } from "@/components/legal-reader/web-reader-messages";
import { detached } from "@/lib/detached";

/**
 * A block's permalink mark: a press writes the block's address into the
 * location and copies it. The link is shown nowhere as text, so no
 * selection the reader copies can be it; only the press confirms.
 */
const PermalinkCopy = ({
  anchorId,
  render,
}: {
  anchorId: string;
  render: (state: PermalinkCopyState) => ReactElement;
}) => {
  const control = useCopyControl({ confirmation: "in-place" });
  return render({
    copied: control.copied,
    copy: () => {
      window.history.replaceState(null, "", `#${anchorId}`);
      const url = new URL(window.location.href);
      url.hash = anchorId;
      detached(control.copy(url.href), "web-reader.copy-permalink");
    },
  });
};

export const useWebReaderPresentationAdapters =
  (): ReaderPresentationAdapters => ({
    messages: useWebReaderMessages(),
    renderPermalinkCopy: (props) => <PermalinkCopy {...props} />,
  });

export const WebReaderPresentationProvider = ({
  children,
}: {
  children: ReactNode;
}) => (
  <ReaderPresentationProvider adapters={useWebReaderPresentationAdapters()}>
    {children}
  </ReaderPresentationProvider>
);
