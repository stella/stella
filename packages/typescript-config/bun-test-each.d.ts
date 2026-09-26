// bun-types types a table of scalar rows as a mutable `T[]` and a table of
// non-tuple array rows as `unknown[][]`, so a readonly table (`as const`,
// `readonly T[]`) matches no `each` overload (TS2769). Merged overloads resolve
// before the originals, so the array-row overloads come first here: Bun
// spreads array rows into the callback, and a readonly array row must not fall
// through to the scalar overload.
export {};

// Bun spreads array rows but passes other rows whole, so a table mixing both
// has no single callback signature. Collapsing it to `never` rejects the call.
type ScalarTable<Row> = [Extract<Row, readonly unknown[]>] extends [never]
  ? readonly Row[]
  : never;

declare module "bun:test" {
  interface Test<T extends ReadonlyArray<unknown>> {
    each<Row extends Readonly<[unknown, ...unknown[]]>>(
      table: readonly Row[],
    ): Test<Row>;
    each<Row extends readonly unknown[]>(table: readonly Row[]): Test<Row>;
    each<const Row>(table: readonly Row[] & ScalarTable<Row>): Test<[Row]>;
  }

  interface Describe<T extends Readonly<any[]>> {
    each<Row extends Readonly<[any, ...any[]]>>(
      table: readonly Row[],
    ): Describe<[...Row]>;
    each<Row extends readonly any[]>(table: readonly Row[]): Describe<[...Row]>;
    each<const Row>(table: readonly Row[] & ScalarTable<Row>): Describe<[Row]>;
  }
}
