import { createContext, type ReactNode, use } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

/**
 * Opens a part of the document on screen (an attachment, the document a
 * signed file wraps, a container's member) the way the document itself
 * opens. Absent where parts cannot be opened, such as a build without the
 * native viewer.
 */
type FilePartOpener = {
  readonly open: (part: string) => void;
  /** The part being fetched, whose control shows that it is busy. */
  readonly opening: string | null;
};

const FilePartOpenerContext = createContext<FilePartOpener | null>(null);

export const FilePartOpenerProvider = ({
  children,
  opener,
}: {
  children: ReactNode;
  opener: FilePartOpener | null;
}) => <FilePartOpenerContext value={opener}>{children}</FilePartOpenerContext>;

/** The control that opens one part; nothing where parts cannot be opened. */
export const OpenFilePart = ({
  part,
  fileName,
}: {
  part: string;
  fileName: string;
}) => {
  const opener = use(FilePartOpenerContext);
  const t = useTranslations("document");
  const link = useTranslations("link");
  if (opener === null) {
    return null;
  }
  return (
    <Button
      accessibilityLabel={t("openPart", { fileName })}
      loading={opener.opening === part}
      onPress={() => {
        opener.open(part);
      }}
      size="inline"
    >
      {link("open")}
    </Button>
  );
};
