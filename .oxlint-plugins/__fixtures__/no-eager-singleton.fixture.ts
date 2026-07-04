// Passive regression fixture for `no-eager-singleton/no-eager-singleton`.
//
// Each `oxlint-disable-next-line` below intentionally suppresses a case the
// rule MUST flag. If the rule regresses, the matching disable becomes unused
// and `--report-unused-disable-directives-severity=error` fails CI. The
// allowed cases carry no disable, so a false positive would fail the
// fixture too.

declare const drizzle: (opts: unknown) => unknown;
declare const betterAuth: (opts: unknown) => unknown;
declare const createRedisClient: (opts?: unknown) => unknown;
declare const postgres: (url: string) => unknown;
declare const RedisClient: new (opts?: unknown) => unknown;
declare const Queue: new (name: string, opts?: unknown) => unknown;
declare const Worker: new (name: string, opts?: unknown) => unknown;
declare const S3Client: new (opts?: unknown) => unknown;
declare const SQL: new (opts?: unknown) => unknown;
declare const client: unknown;

// MUST flag: top-level `const x = drizzle(...)`.
// oxlint-disable-next-line no-eager-singleton/no-eager-singleton
export const eagerDb = drizzle({ client });

// MUST flag: top-level `betterAuth(...)` call.
// oxlint-disable-next-line no-eager-singleton/no-eager-singleton
export const eagerAuth = betterAuth({});

// MUST flag: top-level `createRedisClient(...)` call.
// oxlint-disable-next-line no-eager-singleton/no-eager-singleton
export const eagerRedis = createRedisClient();

// MUST flag: top-level `postgres(...)` call.
// oxlint-disable-next-line no-eager-singleton/no-eager-singleton
export const eagerPostgres = postgres("postgres://localhost");

// MUST flag: top-level `new RedisClient(...)`.
// oxlint-disable-next-line no-eager-singleton/no-eager-singleton
export const eagerRedisClient = new RedisClient();

// MUST flag: top-level `new Queue(...)`.
// oxlint-disable-next-line no-eager-singleton/no-eager-singleton
export const eagerQueue = new Queue("jobs");

// MUST flag: top-level `new Worker(...)`.
// oxlint-disable-next-line no-eager-singleton/no-eager-singleton
export const eagerWorker = new Worker("jobs");

// MUST flag: top-level `new S3Client(...)`.
// oxlint-disable-next-line no-eager-singleton/no-eager-singleton
export const eagerS3 = new S3Client({});

// MUST flag: top-level `new SQL(...)`.
// oxlint-disable-next-line no-eager-singleton/no-eager-singleton
export const eagerSql = new SQL({});

// MUST flag: still module-eval-time even nested in a top-level conditional.
declare const condition: boolean;
if (condition) {
  // oxlint-disable-next-line no-eager-singleton/no-eager-singleton
  drizzle({ client });
}

// Allowed — behind a function boundary (ordinary lazy getter).
export const getDb = () => drizzle({ client });

// Allowed — the `let _x; const getX = () => (_x ??= ctor())` singleton
// pattern: the constructor call lives inside the arrow function body.
let _auth: unknown;
export const getAuth = () => {
  _auth ??= betterAuth({});
  return _auth;
};

// Allowed — constructed inside an ordinary function declaration.
function buildS3() {
  return new S3Client({});
}
void buildS3;

// Allowed — unrelated identifiers that happen to share a denylisted name
// as a property, not as the called/constructed identifier itself.
declare const someLib: { drizzle: (opts: unknown) => unknown };
export const notFlagged = someLib.drizzle({ client });
