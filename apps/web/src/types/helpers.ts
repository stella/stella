export type FlattenKeys<
  T extends Record<string, unknown>,
  Key = keyof T,
> = Key extends string
  ? T[Key] extends Record<string, unknown>
    ? `${Key}.${FlattenKeys<T[Key]>}`
    : `${Key}`
  : never;
