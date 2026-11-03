import { Result } from "better-result";

import { Temporal } from "@stll/time";

import type {
  AnnotationVisibility,
  UpdateAnnotationInput,
} from "@/components/legal-reader/annotations/annotation-types";

/**
 * The server stamps both instants on create and moves `updatedAt` on every
 * later change, so a later `updatedAt` is a change made after writing.
 */
export const commentWasEdited = ({
  createdAt,
  updatedAt,
}: {
  createdAt: string;
  updatedAt: string;
}): boolean =>
  Temporal.Instant.compare(
    Temporal.Instant.from(updatedAt),
    Temporal.Instant.from(createdAt),
  ) > 0;

/** What the author saved: the comment's words and who sees it, together. */
export type CommentEdit = { body: string; visibility: AnnotationVisibility };

/** The changes an edited comment is written with. */
type CommentChange = Extract<
  UpdateAnnotationInput,
  { change: "body" | "visibility" }
>;

type SaveCommentEditOptions = {
  comment: { id: string; body: string; visibility: AnnotationVisibility };
  edit: CommentEdit;
  update: (change: CommentChange) => Promise<Result<void, Error>>;
};

/**
 * Writes an edit in the order that never shows colleagues words meant to stay
 * private: new words before sharing, unsharing before new words. The second
 * write runs only once the first has held.
 */
export const saveCommentEdit = async ({
  comment,
  edit,
  update,
}: SaveCommentEditOptions): Promise<Result<void, Error>> => {
  const writeBody = async (): Promise<Result<void, Error>> =>
    edit.body === comment.body
      ? Result.ok(undefined)
      : await update({ change: "body", body: edit.body, id: comment.id });
  const writeVisibility = async (): Promise<Result<void, Error>> =>
    edit.visibility === comment.visibility
      ? Result.ok(undefined)
      : await update({
          change: "visibility",
          id: comment.id,
          visibility: edit.visibility,
        });
  const [first, second] =
    edit.visibility === "shared"
      ? [writeBody, writeVisibility]
      : [writeVisibility, writeBody];
  const held = await first();
  if (Result.isError(held)) {
    return held;
  }
  return await second();
};
