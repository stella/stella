/** Leaf addresses of a publisher record; arrays of records use `[]`. */
export type SourceRecordPaths<
  TRecord,
  TIncludeBranches extends boolean = false,
> = {
  [TKey in Extract<keyof TRecord, string>]-?: SourceValuePaths<
    NonNullable<TRecord[TKey]>,
    TKey,
    TIncludeBranches
  >;
}[Extract<keyof TRecord, string>];

type SourceValuePaths<
  TValue,
  TPath extends string,
  TIncludeBranches extends boolean,
> = TValue extends readonly (infer TItem)[]
  ? NonNullable<TItem> extends object
    ? keyof NonNullable<TItem> extends never
      ? TPath
      : | (TIncludeBranches extends true ? TPath : never)
        | `${TPath}[].${SourceRecordPaths<NonNullable<TItem>, TIncludeBranches>}`
    : TPath
  : TValue extends object
    ? keyof TValue extends never
      ? TPath
      : | (TIncludeBranches extends true ? TPath : never)
        | `${TPath}.${SourceRecordPaths<TValue, TIncludeBranches>}`
    : TPath;
