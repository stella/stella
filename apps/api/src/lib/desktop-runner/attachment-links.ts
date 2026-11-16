import type { SignAttachmentLink } from "@/api/lib/desktop-runner/session";
import { presignDownloadUrl } from "@/api/lib/s3-presign";

/** Long enough for a large file on a slow line, short enough not to outlive it. */
const ATTACHMENT_LINK_SECONDS = 900;

/**
 * A link to one file a `run.start` copies to the member's computer. The send
 * that started the run recorded the download; a redelivery signs a new link for
 * the same copy. The socket is bound to the member and organization whose run
 * this is, and no browser session stands behind it.
 */
export const signAttachmentLink: SignAttachmentLink = async (file) =>
  await presignDownloadUrl(file.s3Key, {
    userId: file.userId,
    organizationId: file.organizationId,
    expiresIn: ATTACHMENT_LINK_SECONDS,
    scope: { organizationId: file.organizationId },
    source: { kind: "background", reason: "local_run_attachment" },
    readSessionAuthority: async () => await Promise.resolve(null),
  });
