/**
 * Database functions whose bodies take table locks with DDL (policy changes,
 * ALTER TABLE, index builds and drops, explicit locks). Neither the
 * `LockTakingStatement` type nor the `confine-online-ddl` lint rule can read
 * SQL inside a function body, so each such function a migration installs is
 * declared here, and `online-ddl-functions.test.ts` fails on one
 * that is not.
 *
 * Only an `online` declaration is callable from the online phase, and only
 * through `callDeclaredFunction` in `online-ddl.ts`, which gates it on the one
 * table it locks; the lint rule reports a call to any declared function
 * spelled anywhere else. Dependency-free, so the lint rule reads it too.
 */

export type DdlFunctionDeclaration =
  | {
      online: true;
      /**
       * The one table the body locks: named here, or passed as the call's
       * only argument, so each call is gated on the table it locks.
       */
      locks: { type: "table"; tableName: string } | { type: "table-argument" };
    }
  | {
      online: false;
      /** Why the online phase never calls it. */
      reason: string;
    };

export const DDL_FUNCTIONS = {
  entity_feature_gate_finish: {
    online: false,
    reason:
      "Replaces the feature policy on every entity feature gate relation in one call; the online repair replaces each relation's policy on its own through replacePolicy instead.",
  },
} as const satisfies Record<string, DdlFunctionDeclaration>;

export type DdlFunctionName = keyof typeof DDL_FUNCTIONS;

/** The declared functions the online phase may call. */
export type OnlineDdlFunctionName = {
  [Name in DdlFunctionName]: (typeof DDL_FUNCTIONS)[Name] extends {
    online: true;
  }
    ? Name
    : never;
}[DdlFunctionName];

export const DDL_FUNCTION_NAMES: readonly string[] = Object.keys(DDL_FUNCTIONS);

/** Keep the declaration union at the lookup boundary, even with no online entries. */
export const readDdlFunctionDeclaration = (
  name: DdlFunctionName,
): DdlFunctionDeclaration => DDL_FUNCTIONS[name];
