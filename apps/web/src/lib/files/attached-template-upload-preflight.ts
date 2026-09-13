import { prepareAttachedTemplateFiles } from "./attached-template-upload";
import { requestAttachedTemplateRemoval } from "./attached-template-upload-store";

export const ATTACHED_TEMPLATE_UPLOAD_PREFLIGHT = {
  cancelled: "cancelled",
  ready: "ready",
} as const;

export type AttachedTemplateUploadPreflight =
  | { type: typeof ATTACHED_TEMPLATE_UPLOAD_PREFLIGHT.cancelled }
  | {
      type: typeof ATTACHED_TEMPLATE_UPLOAD_PREFLIGHT.ready;
      replacements: ReadonlyMap<File, File>;
    };

/** Ask once, before upload, and return the sanitized files when approved. */
export const preflightAttachedTemplateUpload = async (
  files: readonly File[],
): Promise<AttachedTemplateUploadPreflight> => {
  const prepared = await prepareAttachedTemplateFiles(files);
  if (prepared.length === 0) {
    return {
      type: ATTACHED_TEMPLATE_UPLOAD_PREFLIGHT.ready,
      replacements: new Map(),
    };
  }

  if (!(await requestAttachedTemplateRemoval(prepared))) {
    return { type: ATTACHED_TEMPLATE_UPLOAD_PREFLIGHT.cancelled };
  }

  const replacements = new Map<File, File>();
  for (const { originalFile, file } of prepared) {
    replacements.set(originalFile, file);
  }
  return { type: ATTACHED_TEMPLATE_UPLOAD_PREFLIGHT.ready, replacements };
};
