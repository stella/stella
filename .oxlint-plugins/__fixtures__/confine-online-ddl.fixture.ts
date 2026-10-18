declare const connection: {
  execute: (statement: string) => unknown;
  query: (statement: string) => unknown;
};

// oxlint-disable-next-line confine-online-ddl/confine-online-ddl -- planted table-locking SQL must be rejected
connection.execute(
  "ALTER TABLE public.example VALIDATE CONSTRAINT example_check",
);

// expect-clean: confine-online-ddl/confine-online-ddl
connection.query("SELECT convalidated FROM pg_constraint");
