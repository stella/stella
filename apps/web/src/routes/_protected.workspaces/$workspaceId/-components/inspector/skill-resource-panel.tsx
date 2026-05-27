import { ScrollArea } from "@stll/ui/components/scroll-area";

import { MessageResponse } from "@/components/ai-elements/message";

import type { SkillResourceTab } from "./inspector-store";

const MARKDOWN_MIME_PREFIX = "text/markdown";
const PDF_MIME = "application/pdf";
const MARKDOWN_EXTENSIONS = [".md", ".markdown"] as const;

const isMarkdown = (mimeType: string, resourcePath: string): boolean => {
  if (mimeType.startsWith(MARKDOWN_MIME_PREFIX)) {
    return true;
  }
  const lowered = resourcePath.toLowerCase();
  return MARKDOWN_EXTENSIONS.some((ext) => lowered.endsWith(ext));
};

export const SkillResourcePanel = ({ tab }: { tab: SkillResourceTab }) => {
  const { skillName, resourcePath, mimeType, content } = tab;

  return (
    <div className="bg-background flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b px-3">
        <span className="text-foreground truncate text-xs font-medium">
          {skillName}
        </span>
        <span
          className="text-muted-foreground truncate font-mono text-[10px]"
          title={resourcePath}
        >
          {resourcePath}
        </span>
      </div>
      <SkillResourceBody
        content={content}
        mimeType={mimeType}
        resourcePath={resourcePath}
      />
    </div>
  );
};

const SkillResourceBody = ({
  content,
  mimeType,
  resourcePath,
}: {
  content: string;
  mimeType: string;
  resourcePath: string;
}) => {
  if (mimeType === PDF_MIME) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <p className="text-muted-foreground max-w-sm text-center text-sm">
          PDF preview will be available once binary skill resources are
          supported.
        </p>
      </div>
    );
  }

  if (isMarkdown(mimeType, resourcePath)) {
    return (
      <ScrollArea className="min-h-0 flex-1">
        <article className="text-foreground max-w-none px-4 py-3 text-sm leading-6">
          <MessageResponse className="text-sm" components={{}}>
            {content}
          </MessageResponse>
        </article>
      </ScrollArea>
    );
  }

  return (
    <ScrollArea className="min-h-0 flex-1">
      <pre className="text-foreground px-4 py-3 font-mono text-xs whitespace-pre-wrap">
        {content}
      </pre>
    </ScrollArea>
  );
};
