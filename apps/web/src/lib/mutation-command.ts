/**
 * An intentional multi-field PATCH with at least one supplied field.
 * Single-operation mutations should use a discriminated union instead.
 */
export type NonEmptyPatch<Fields extends object> = {
  [Key in keyof Fields]-?: Pick<Fields, Key> & Partial<Omit<Fields, Key>>;
}[keyof Fields];
