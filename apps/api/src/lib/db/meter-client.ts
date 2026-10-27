import { AsyncLocalStorage } from "node:async_hooks";

import { currentQueryCount } from "@/api/lib/db-query-counter";
import { recordDbResult } from "@/api/lib/observability/request-work";

const isCallable = (value: unknown): value is (...args: unknown[]) => unknown =>
  typeof value === "function";

/**
 * Observe the driver result before Drizzle maps or discards selected columns.
 * Keep the native lazy query and its cancellation/array-mode methods intact.
 */
const meterPendingQuery = (value: unknown): unknown => {
  if (
    currentQueryCount() === undefined ||
    typeof value !== "object" ||
    value === null ||
    !("then" in value)
  ) {
    return value;
  }
  const runInCaller = AsyncLocalStorage.snapshot();
  let observed = false;
  const query = new Proxy(value, {
    get: (target, property) => {
      const member: unknown = Reflect.get(target, property, target);
      if (!isCallable(member)) {
        return member;
      }
      if (property === "catch") {
        return async (rejected: unknown) =>
          await Promise.resolve(query).catch(
            isCallable(rejected)
              ? (error: unknown) => Reflect.apply(rejected, undefined, [error])
              : undefined,
          );
      }
      if (property === "finally") {
        return async (settled: unknown) =>
          await Promise.resolve(query).finally(
            isCallable(settled)
              ? async () => {
                  await Reflect.apply(settled, undefined, []);
                }
              : undefined,
          );
      }
      if (property === "then") {
        return (fulfilled: unknown, rejected: unknown) =>
          Reflect.apply(member, target, [
            (rows: unknown) => {
              if (!observed) {
                observed = true;
                runInCaller(recordDbResult, rows);
              }
              return isCallable(fulfilled)
                ? Reflect.apply(fulfilled, undefined, [rows])
                : rows;
            },
            rejected,
          ]);
      }
      return (...args: unknown[]) => {
        const result: unknown = Reflect.apply(member, target, args);
        return result === target ? query : result;
      };
    },
  });
  return query;
};

const meteredClients = new WeakSet<(...args: never[]) => unknown>();

/** Driver-local instrumentation; no prototype changes or retained document data. */
export const meterSqlClient = <T extends (...args: never[]) => unknown>(
  client: T,
): T => {
  if (meteredClients.has(client)) {
    return client;
  }
  const metered = new Proxy(client, {
    apply: (target, receiver, args) =>
      meterPendingQuery(Reflect.apply(target, receiver, args)),
    get: (target, property) => {
      const member: unknown = Reflect.get(target, property, target);
      if (!isCallable(member)) {
        return member;
      }
      const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
      if (
        descriptor !== undefined &&
        descriptor.configurable === false &&
        "writable" in descriptor &&
        descriptor.writable === false
      ) {
        return member;
      }
      if (property === "unsafe") {
        return (...args: unknown[]) =>
          meterPendingQuery(Reflect.apply(member, target, args));
      }
      if (property === "savepoint") {
        return (...args: unknown[]) =>
          Reflect.apply(
            member,
            target,
            args.map((argument) =>
              isCallable(argument)
                ? (transaction: unknown) =>
                    Reflect.apply(argument, undefined, [
                      isCallable(transaction)
                        ? meterSqlClient(transaction)
                        : transaction,
                    ])
                : argument,
            ),
          );
      }
      return member.bind(target);
    },
  });
  meteredClients.add(metered);
  return metered;
};
