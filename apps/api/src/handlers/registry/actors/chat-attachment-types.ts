/**
 * Shared types for chat file attachments passed from the
 * transport layer into the chat actor.
 */

/** A file processed by upload-context-file, forwarded by
 *  the transport alongside the user message. */
export type ProcessedAttachment =
  | {
      type: "native-file";
      dataUrl: string;
      mediaType: string;
      filename: string;
    }
  | {
      type: "extracted-text";
      filename: string;
      mediaType: string;
      views: {
        simple: string;
        original?: string;
        trackedChanges?: string;
      };
    };

export type ExtractedTextAttachment = Extract<
  ProcessedAttachment,
  { type: "extracted-text" }
>;

export type NativeFileAttachment = Extract<
  ProcessedAttachment,
  { type: "native-file" }
>;
