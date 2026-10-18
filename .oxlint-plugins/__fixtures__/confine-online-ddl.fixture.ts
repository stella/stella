declare const connection: {
  execute: (statement: string) => unknown;
  query: (statement: string) => unknown;
};

connection.execute(
  // oxlint-disable-next-line confine-online-ddl/confine-online-ddl -- planted table-locking SQL must be rejected
  "ALTER TABLE public.example VALIDATE CONSTRAINT example_check",
);

// expect-clean: confine-online-ddl/confine-online-ddl
connection.query("SELECT convalidated FROM pg_constraint");
