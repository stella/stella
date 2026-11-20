// The field's classes, with no React or Base UI: the field (./field.tsx)
// renders them, and a loading view draws a field's face
// (./control-face.tsx) from the same classes, so a field's column in a
// pending view and the field that replaces it share one box.

/** A field's column: its caption, its control and its quiet lines. */
export const FIELD_CLASS_NAME = "flex flex-col items-start gap-2";

/** A field's quiet line under its control. */
export const FIELD_DESCRIPTION_CLASS_NAME = "text-muted-foreground text-xs";
