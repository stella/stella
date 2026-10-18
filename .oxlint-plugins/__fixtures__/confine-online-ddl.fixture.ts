declare const connection: {
  execute: (query: string) => Promise<void>;
};
declare const index: { createSql: string; name: string };
declare const validateOnlineConstraints: () => Promise<void>;

// oxlint-disable-next-line confine-online-ddl/confine-online-ddl -- fixture: a validation on the short-budget session bypasses the gate
await connection.execute('ALTER TABLE public."t" VALIDATE CONSTRAINT "c"');

// oxlint-disable-next-line confine-online-ddl/confine-online-ddl -- fixture: a concurrent drop waits for every writer on the table
await connection.execute("DROP INDEX CONCURRENTLY public.x");

// oxlint-disable-next-line confine-online-ddl/confine-online-ddl -- fixture: only the owner reads a declared build
await connection.execute(index.createSql);

// expect-clean: confine-online-ddl/confine-online-ddl
const declared = {
  createSql: 'CREATE INDEX CONCURRENTLY "x" ON public."t" USING btree (id)',
  name: "x",
};
await connection.execute("UPDATE public.t SET a = 1");
await validateOnlineConstraints();

export { declared };
