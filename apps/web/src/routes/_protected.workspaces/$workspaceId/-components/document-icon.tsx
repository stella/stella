import {
  File,
  FileImage,
  FileSpreadsheet,
  FileText,
  MailIcon,
} from "lucide-react";

import { MarkdownIcon } from "@/components/markdown-icon";
import { getDocumentIconKind } from "@/routes/_protected.workspaces/$workspaceId/-components/document-icon.logic";

type DocxIconProps = {
  className?: string | undefined;
  style?: React.CSSProperties | undefined;
  width?: number | string;
  height?: number | string;
};

export const DocxIcon = ({
  className,
  style,
  width,
  height,
}: DocxIconProps) => (
  <svg
    aria-hidden="true"
    className={className}
    fill="none"
    height={height}
    style={style}
    viewBox="0 0 48 48"
    width={width}
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M13.5 44h29c.275 0 .5-.225.5-.5V14h-8.5c-.827 0-1.5-.673-1.5-1.5V4H13.5c-.275 0-.5.225-.5.5v39c0 .275.225.5.5.5z"
      fill="#fff"
    />
    <path d="M42.293 13 34 4.707V12.5c0 .275.225.5.5.5h7.793z" fill="#fff" />
    <path
      clipRule="evenodd"
      d="m43.56 12.854-9.414-9.415A1.51 1.51 0 0 0 33.086 3H13.5c-.827 0-1.5.673-1.5 1.5v39c0 .827.673 1.5 1.5 1.5h29c.827 0 1.5-.673 1.5-1.5V13.914c0-.4-.156-.777-.44-1.06zM34 4.707 42.293 13H34.5a.501.501 0 0 1-.5-.5V4.707zM13.5 44h29c.275 0 .5-.225.5-.5V14h-8.5c-.827 0-1.5-.673-1.5-1.5V4H13.5c-.275 0-.5.225-.5.5v39a.5.5 0 0 0 .5.5z"
      fill="#605E5C"
      fillRule="evenodd"
      opacity=".64"
    />
    <path d="M39.5 30H28v1h11.5a.5.5 0 0 0 0-1z" fill="#103F91" />
    <path d="M39.5 27H28v1h11.5a.5.5 0 0 0 0-1z" fill="#185ABD" />
    <path d="M39.5 24H28v1h11.5a.5.5 0 0 0 0-1z" fill="#2B7CD3" />
    <path d="M39.5 21H28v1h11.5a.5.5 0 0 0 0-1z" fill="#41A5EE" />
    <path
      d="M6 37h18a2 2 0 0 0 2-2V17a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v18a2 2 0 0 0 2 2z"
      fill="#185ABD"
    />
    <path
      d="M11.829 29.322c.033.262.055.49.065.684h.038c.045-.446.117-.89.214-1.328L13.921 21h2.295l1.836 7.564c.092.373.168.848.23 1.426h.03c.026-.399.09-.859.191-1.38l1.47-7.61h2.088l-2.57 11H17.05l-1.752-7.287c-.051-.21-.109-.484-.172-.822a10.585 10.585 0 0 1-.119-.736h-.03c-.02.18-.06.446-.119.798-.059.354-.106.613-.141.783L13.072 32h-2.479L8 21h2.127l1.598 7.694c.036.159.07.369.104.628z"
      fill="#F9F7F7"
    />
  </svg>
);

type PdfIconProps = {
  className?: string | undefined;
};

const PdfIcon = ({ className }: PdfIconProps) => (
  <svg
    aria-hidden="true"
    className={className}
    height="92.604164mm"
    viewBox="0 0 75.320129 92.604164"
    width="75.320129mm"
    xmlns="http://www.w3.org/2000/svg"
  >
    <g transform="translate(53.55 -183.98) scale(1.48)">
      <path
        color="#000"
        d="M-29.63 123.95c-3.55 0-6.44 2.89-6.44 6.45v49.5c0 3.55 2.89 6.45 6.44 6.45H8.22c3.55 0 6.44-2.89 6.44-6.45v-40.7s.1-1.19-.42-2.35c-.48-1.09-1.28-1.84-1.28-1.84a1.06 1.06 0 0 0-.01-.01l-9.39-9.21a1.06 1.06 0 0 0-.02-.02s-.8-.76-1.99-1.27c-1.4-.6-2.84-.54-2.84-.54l.02-.0z"
        fill="#ff2116"
        fontFamily="sans-serif"
        overflow="visible"
        paintOrder="markers fill stroke"
      />
      <path
        color="#000"
        d="M-29.63 126.06h28.38a1.06 1.06 0 0 0 .02 0s1.13.01 1.96.37c.8.34 1.37.86 1.37.87.0.0.0.0.0.0l9.37 9.19s.56.6.84 1.21c.22.49.23 1.4.23 1.4a1.06 1.06 0 0 0-.0.04v40.75c0 2.42-1.91 4.33-4.33 4.33H-29.63c-2.42 0-4.33-1.91-4.33-4.33v-49.5c0-2.42 1.91-4.33 4.33-4.33z"
        fill="#f5f5f5"
        fontFamily="sans-serif"
        overflow="visible"
        paintOrder="markers fill stroke"
      />
      <path
        d="M-23.41 161.09c-1.46-1.46.12-3.46 4.4-5.58l2.69-1.34 1.05-2.29c.58-1.26 1.44-3.32 1.91-4.57l.86-2.28-.6-1.69c-.73-2.08-.99-5.19-.53-6.32.63-1.52 2.69-1.36 3.51.27.64 1.27.57 3.57-.18 6.48l-.62 2.38.55.93c.3.51 1.18 1.72 1.95 2.69l1.45 1.8 1.8-.24c5.73-.75 7.69.52 7.69 2.34 0 2.3-4.5 2.49-8.28-.16-.85-.6-1.43-1.19-1.43-1.19s-2.37.48-3.53.8c-1.2.32-1.8.53-3.56 1.12 0 0-.62.9-1.02 1.55-1.5 2.43-3.25 4.44-4.5 5.17-1.4.82-2.87.88-3.6.14zm2.29-.82c.82-.51 2.48-2.47 3.62-4.29l.46-.74-2.11 1.06c-3.27 1.64-4.76 3.19-3.98 4.13.44.53.96.48 2.01-.17zm21.22-5.96c.8-.56.68-1.69-.22-2.15-.7-.35-1.27-.43-3.1-.4-1.12.08-2.93.3-3.24.37 0 0 .99.69 1.43.94.59.34 2.01.96 3.06 1.28 1.03.31 1.62.28 2.07-.04zm-8.53-3.55c-.48-.51-1.31-1.57-1.83-2.36-.68-.9-1.03-1.53-1.03-1.53s-.5 1.61-.91 2.57l-1.28 3.16-.37.72s1.97-.65 2.97-.91c1.06-.28 3.22-.7 3.22-.7zm-2.75-11.03c.12-1.04.18-2.07-.16-2.6-.92-1.01-2.04-.17-1.85 2.24.06.81.26 2.19.53 3.04l.49 1.55.34-1.17c.19-.64.48-2.02.64-3.06z"
        fill="#ff2116"
      />
      <path
        d="M-20.93 167.84h2.36q1.13 0 1.84.22.71.21 1.19.94.48.73.48 1.76 0 .94-.39 1.62-.39.68-1.06.98-.66.3-2.03.3h-.82v3.73h-1.58zm1.58 1.22v3.33h.78q1.05 0 1.45-.39.41-.39.41-1.27 0-.66-.27-1.06-.27-.41-.59-.5-.31-.1-1.0-.1zm5.51-1.22h2.15q1.56 0 2.49.55.94.55 1.41 1.64.48 1.09.48 2.42 0 1.4-.43 2.5-.43 1.09-1.32 1.76-.88.67-2.52.67h-2.27zm1.58 1.27v7.02h.66q1.38 0 2.0-.95.62-.96.62-2.55 0-3.51-2.62-3.51zm6.47-1.27h5.3v1.27H-4.21v2.85h2.98v1.27h-2.98v4.16h-1.58z"
        fill="#2c2c2c"
        fontFamily="Franklin Gothic Medium Cond"
        letterSpacing="0"
        wordSpacing="4.26000023"
      />
    </g>
  </svg>
);

type DocumentIconProps = {
  mimeType: string;
  fileName?: string | null | undefined;
  className?: string | undefined;
};

export function DocumentIcon({
  mimeType,
  fileName,
  className,
}: DocumentIconProps) {
  const iconKind = getDocumentIconKind(mimeType, fileName);

  if (iconKind === "pdf") {
    return <PdfIcon className={className} />;
  }

  if (iconKind === "word") {
    return <DocxIcon className={className} />;
  }

  if (iconKind === "spreadsheet") {
    return <FileSpreadsheet className={className} />;
  }

  if (iconKind === "image") {
    return <FileImage className={className} />;
  }

  if (iconKind === "email") {
    return <MailIcon className={className} />;
  }

  if (iconKind === "markdown") {
    return <MarkdownIcon className={className} />;
  }

  if (iconKind === "text") {
    return <FileText className={className} />;
  }

  return <File className={className} />;
}
