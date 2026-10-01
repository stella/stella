import { panic } from "better-result";

import { readRepairArguments } from "./repair-flags";

type ParserOptions = {
  args: readonly string[];
  environment?: Readonly<Record<string, string | undefined>>;
  now?: () => Date;
};

const readArguments = ({
  args,
  environment = {},
  now = () => new Date(),
}: ParserOptions) => {
  const { value, integer, uuid } = readRepairArguments(args);
  const after = value("after");
  return { value, integer, uuid, after, now, environment, args };
};

type BackfillPlan = { name: string; tableName: string; initialSize: number };

const withRuntime = <Plan extends BackfillPlan>(plan: Plan) => ({
  ...plan,
  open: <Runtime>(
    createRuntime: (options: BackfillPlan) => Runtime,
    target?: { name: string; tableName: string },
  ) =>
    createRuntime({
      name: target?.name ?? plan.name,
      tableName: target?.tableName ?? plan.tableName,
      initialSize: plan.initialSize,
    }),
});

export const backfillEntrypoints = {
  "citation-authority": (options: ParserOptions) => {
    const { value, integer, after, now } = readArguments(options);
    if (
      after !== undefined &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
        after,
      )
    ) {
      panic("--after requires a decision id");
    }
    const rawAsOf = value("as-of");
    const asOf = rawAsOf === undefined ? now() : new Date(rawAsOf);
    if (Number.isNaN(asOf.getTime())) {
      panic("--as-of requires an ISO timestamp");
    }
    return withRuntime({
      name: `citation-authority:${asOf.toISOString()}:${after ?? "start"}`,
      tableName: "case_law_decisions",
      initialSize: integer("batch", 5000),
      after,
      asOf,
    });
  },
  "citation-keys": (options: ParserOptions) => {
    const { args } = readArguments(options);
    const unsupported = args.filter((arg) => arg !== "--recanonicalize");
    if (unsupported.length > 0) {
      panic(`Unsupported argument: ${unsupported.join(" ")}`);
    }
    const scope = args.includes("--recanonicalize") ? "stale" : "missing";
    return withRuntime({
      name: `citation-keys:${scope}`,
      tableName: "case_law_decisions",
      initialSize: 5000,
      scope,
    });
  },
  "source-document-ids": (options: ParserOptions) => {
    const { value } = readArguments(options);
    return withRuntime({
      name: "source-document-ids",
      tableName: "case_law_decisions",
      initialSize: 2000,
      adapter: value("adapter") ?? null,
    });
  },
  "legislation-work-names": (options: ParserOptions) => {
    const { args, integer, uuid } = readArguments(options);
    const after = uuid("after");
    if (
      args.some(
        (arg) => arg.startsWith("--apply=") || arg.startsWith("--dry-run="),
      )
    ) {
      panic("--apply and --dry-run do not accept values");
    }
    if (args.includes("--apply") && args.includes("--dry-run")) {
      panic("--apply contradicts --dry-run");
    }
    return withRuntime({
      name: `legislation-work-names:${after ?? "start"}`,
      tableName: "legislation_documents",
      initialSize: integer("page", 1000),
      limit: integer("limit", 200_000),
      apply: args.includes("--apply"),
      after,
    });
  },
  "property-roles": (options: ParserOptions) => {
    const { environment } = readArguments(options);
    const initialSize = Number(
      environment["PROPERTY_ROLE_BACKFILL_BATCH_SIZE"] ?? 100,
    );
    if (!Number.isSafeInteger(initialSize) || initialSize < 1) {
      panic("PROPERTY_ROLE_BACKFILL_BATCH_SIZE requires a positive integer");
    }
    return withRuntime({
      name: "property-roles",
      tableName: "properties",
      initialSize,
    });
  },
  "statute-citation-counts": (_options: ParserOptions) =>
    withRuntime({
      name: "statute-citation-counts",
      tableName: "case_law_decisions",
      initialSize: 500,
    }),
  "statute-slugs": (_options: ParserOptions) =>
    withRuntime({
      name: "statute-slugs",
      tableName: "legislation_documents",
      initialSize: 200,
    }),
};
