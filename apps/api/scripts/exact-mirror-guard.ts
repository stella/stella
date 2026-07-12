// exactMirror route guard.
//
// Elysia builds an "exactMirror" serializer for every route's body/response
// schema. For some schemas the mirror cannot be built: Elysia catches the
// failure, logs `console.warn("Failed to create exactMirror...")`, and falls
// back to slow per-request serialization. The usual trigger is a recursive
// schema (`t.Recursive`, or a `Type.Unsafe` wrapping a self-referential
// TypeBox node) in a route contract; on the export route this fallback has
// previously taken the whole API down at boot. The failure is runtime-only:
// typecheck and lint both pass.
//
// This guard constructs the real app (every route mounted, exactly as
// `src/server.ts` builds it — importing the module is side-effect-free thanks
// to its `import.meta.main` boot guard, so no DB/Redis/S3/listen), then forces
// every route's schema mirror to build by calling `route.compile()` on each
// entry of `app.routes`. Per-route schema validators compile lazily, so this
// iteration is what actually exercises exactMirror; a route count of zero
// compiled means the trigger never ran and is itself treated as a failure
// (silence must mean "all mirrors built", not "compilation skipped"). Any
// `console.warn` carrying the exactMirror failure signature during the build
// is captured and attributed to the route being compiled at that moment.
//
// Modes:
//   bun apps/api/scripts/exact-mirror-guard.ts             check every route (CI gate; exit 1 on failure)
//   bun apps/api/scripts/exact-mirror-guard.ts --self-test prove the detector catches a recursive schema
//
// CI-only by design (it builds the whole app): wired into
// `.github/workflows/ci.yml` and `bun run verify`, not oxlint.

// Side-effect import: seed env defaults so the app constructs without real
// services. The app's own boot (migrations, S3, workers, listen) stays behind
// `import.meta.main` in src/server.ts and never runs here.
import "../src/tests/setup-env";
import { Type } from "@sinclair/typebox";
import { Result } from "better-result";
import { t } from "elysia";

const EXACT_MIRROR_FAILURE_SIGNATURE = "Failed to create exactMirror";
const APP_CONSTRUCTION_SCOPE = "(app construction / model schemas)";

// Structural view of what the guard needs from an Elysia instance. Keeping it
// structural (rather than the full `Elysia<...>` generic) lets both the real
// app and the self-test fixture flow in without casts.
type CompilableRoute = {
  readonly method: string;
  readonly path: string;
  readonly compile: () => unknown;
};

type CompilableApp = {
  readonly modules: unknown;
  readonly routes: readonly CompilableRoute[];
};

type ExactMirrorReport = {
  totalRoutes: number;
  compiledRoutes: number;
  mirrorFailures: string[];
  compileErrors: { route: string; message: string }[];
};

const installMirrorInterception = (
  scope: { current: string },
  onFailure: (scope: string) => void,
): (() => void) => {
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
    dir: console.dir,
    trace: console.trace,
  };

  const scan = (args: unknown[]): boolean => {
    const [first] = args;
    if (
      typeof first === "string" &&
      first.includes(EXACT_MIRROR_FAILURE_SIGNATURE)
    ) {
      onFailure(scope.current);
      return true;
    }
    return false;
  };

  // Swallow the noisy schema dumps Elysia prints after the warning; re-emit
  // genuine errors so an unrelated failure during the build still surfaces.
  console.log = (...args: unknown[]) => {
    scan(args);
  };
  console.info = (...args: unknown[]) => {
    scan(args);
  };
  console.warn = (...args: unknown[]) => {
    scan(args);
  };
  console.debug = (...args: unknown[]) => {
    scan(args);
  };
  console.trace = (...args: unknown[]) => {
    scan(args);
  };
  console.dir = (...args: unknown[]) => {
    scan(args);
  };
  console.error = (...args: unknown[]) => {
    if (!scan(args)) {
      original.error(...args);
    }
  };

  return () => {
    Object.assign(console, original);
  };
};

const findExactMirrorFailures = async (
  buildApp: () => CompilableApp | Promise<CompilableApp>,
): Promise<ExactMirrorReport> => {
  const scope = { current: APP_CONSTRUCTION_SCOPE };
  const mirrorFailureScopes = new Set<string>();
  const restore = installMirrorInterception(scope, (failed) => {
    mirrorFailureScopes.add(failed);
  });

  const compileErrors: { route: string; message: string }[] = [];
  let totalRoutes = 0;
  let compiledRoutes = 0;

  try {
    const app = await buildApp();
    // Resolve any lazily-loaded modules so their routes are registered before
    // the iteration below; harmless when there are none.
    await Promise.resolve(app.modules);

    totalRoutes = app.routes.length;
    for (const route of app.routes) {
      scope.current = `${route.method} ${route.path}`;
      const compiled = Result.try({
        try: () => route.compile(),
        catch: (cause) =>
          cause instanceof Error ? cause.message : String(cause),
      });
      if (compiled.isErr()) {
        compileErrors.push({ route: scope.current, message: compiled.error });
      } else {
        compiledRoutes++;
      }
    }
  } finally {
    restore();
  }

  return {
    totalRoutes,
    compiledRoutes,
    mirrorFailures: [...mirrorFailureScopes].sort(),
    compileErrors,
  };
};

const reportToExitCode = (report: ExactMirrorReport): number => {
  // A zero compiled count means the trigger never exercised exactMirror, so a
  // green run would be meaningless. Discovering zero routes at all is the same
  // failure at the discovery stage: never let 0/0 pass as clean.
  const noRoutesDiscovered = report.totalRoutes === 0;
  const triggerDidNotRun = noRoutesDiscovered || report.compiledRoutes === 0;
  const clean =
    report.mirrorFailures.length === 0 &&
    report.compileErrors.length === 0 &&
    !triggerDidNotRun;

  if (clean) {
    console.log(
      `exact-mirror-guard: OK. Built exactMirror for ${report.compiledRoutes}/${report.totalRoutes} routes; no failures.`,
    );
    return 0;
  }

  if (report.mirrorFailures.length > 0) {
    console.error(
      "\nexact-mirror-guard: Elysia could not build exactMirror for the schema(s) on these route(s):",
    );
    for (const route of report.mirrorFailures) {
      console.error(`  ${route}`);
    }
    console.error(
      "\nA route whose body/response schema exactMirror cannot build falls back\n" +
        "to slow per-request serialization (and has previously taken the API down\n" +
        "at boot). The usual cause is a recursive schema (t.Recursive, or a\n" +
        "Type.Unsafe wrapping a self-referential TypeBox node) in the route\n" +
        "contract. Keep recursive schemas out of route body/response contracts:\n" +
        "use a fixed finite nesting (see apps/api/src/lib/conditions/contract.ts).",
    );
  }

  if (noRoutesDiscovered) {
    console.error(
      "\nexact-mirror-guard: discovered 0 routes — the guard did not exercise exactMirror at all. This is a guard bug, not a schema bug; fix route discovery before trusting a green run.",
    );
  } else if (triggerDidNotRun) {
    console.error(
      `\nexact-mirror-guard: compiled 0 of ${report.totalRoutes} routes — the guard did not actually exercise exactMirror. This is a guard bug, not a schema bug; fix the trigger before trusting a green run.`,
    );
  }

  if (report.compileErrors.length > 0) {
    console.error(
      "\nexact-mirror-guard: could not compile these route(s), so their exactMirror could not be verified:",
    );
    for (const { route, message } of report.compileErrors) {
      console.error(`  ${route}: ${message}`);
    }
  }

  return 1;
};

// Self-test fixture: a route whose body carries a recursive condition schema,
// the exact shape (`t.Recursive` wrapped in `Type.Unsafe`) that broke
// exactMirror for `tConditionNode`. Proves the detector flags the bug class
// through the same code path the real check uses.
const SELF_TEST_ROUTE = "/exact-mirror-self-test/recursive";

const buildRecursiveFixtureApp = async (): Promise<CompilableApp> => {
  const { Elysia } = await import("elysia");
  const recursiveNode = Type.Unsafe(
    t.Recursive((self) =>
      t.Union([
        t.Object({ type: t.Literal("leaf"), value: t.String() }),
        t.Object({ type: t.Literal("group"), children: t.Array(self) }),
      ]),
    ),
  );

  return new Elysia().post(SELF_TEST_ROUTE, () => "ok", {
    body: t.Object({ filters: t.Array(recursiveNode) }),
  });
};

const runSelfTest = async (): Promise<number> => {
  const report = await findExactMirrorFailures(buildRecursiveFixtureApp);
  const detected = report.mirrorFailures.some((route) =>
    route.includes(SELF_TEST_ROUTE),
  );

  if (detected) {
    console.log(
      `exact-mirror-guard --self-test: PASS. Detected the recursive-schema exactMirror failure on ${report.mirrorFailures.join(", ")}.`,
    );
    return 0;
  }

  console.error(
    "exact-mirror-guard --self-test: FAIL. The detector did not flag a known\n" +
      "recursive-schema route. The trigger or the console interception is\n" +
      "broken; a green CI run would be meaningless until this is fixed.",
  );
  return 1;
};

const main = async (): Promise<number> => {
  if (process.argv.includes("--self-test")) {
    return runSelfTest();
  }

  const report = await findExactMirrorFailures(
    async () => (await import("../src/server")).default,
  );
  return reportToExitCode(report);
};

process.exit(await main());
