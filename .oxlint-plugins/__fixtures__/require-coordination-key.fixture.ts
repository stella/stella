// Passive regression fixture for
// `require-coordination-key/require-coordination-key`.

import { coordinationKey } from "@/api/lib/redis-keys";

// Synchronous stub: the rule inspects the call shape, not the client.
const redis = {
  send: (_command: string, _args: string[]): unknown => null,
};

const SCRIPT = "return 1";
const tenant = "ws-1";

// MUST flag: a single-key command's first argument is a key position.
// oxlint-disable-next-line require-coordination-key/require-coordination-key -- fixture: GET takes a key first
export const read = () => redis.send("GET", ["workflow:ws-1:total"]);

// MUST flag: a template literal is just as unhashtagged as a plain string.
export const expire = () =>
  redis.send("EXPIRE", [
    // oxlint-disable-next-line require-coordination-key/require-coordination-key -- fixture: interpolated keys bypass the builder too
    `workflow:${tenant}:running`,
    "600",
  ]);

// MUST flag: every argument of a variadic key list is a key position, and a
// multi-key DEL is exactly what a cluster rejects across slots.
export const clear = () =>
  redis.send("DEL", [
    // oxlint-disable-next-line require-coordination-key/require-coordination-key -- fixture: DEL's first key
    "workflow:ws-1:running",
    // oxlint-disable-next-line require-coordination-key/require-coordination-key -- fixture: DEL's second key
    "workflow:ws-1:total",
  ]);

// MUST flag: a script declares its key count, and each declared key counts.
export const script = () =>
  redis.send("EVAL", [
    SCRIPT,
    "2",
    // oxlint-disable-next-line require-coordination-key/require-coordination-key -- fixture: KEYS[1]
    "workflow:ws-1:request-id",
    // oxlint-disable-next-line require-coordination-key/require-coordination-key -- fixture: KEYS[2]
    "workflow:ws-1:running",
    "argv-is-not-a-key",
  ]);

// Allowed: keys from the builder, and literals that sit in value or argument
// positions rather than key positions.
export const write = () =>
  redis.send("SET", [
    coordinationKey({ scope: "workflow-run", slot: tenant, suffix: "running" }),
    "value-literal",
    "EX",
    "600",
  ]);

// Allowed: cursor-based and keyless commands carry no key position.
export const scan = () =>
  redis.send("SCAN", ["0", "MATCH", "workflow-run:{*}:running"]);

export const ping = () => redis.send("PING", []);
