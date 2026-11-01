// `clock_timestamp()` advances within a statement, so two columns of one row
// write that each call it store two different instants: an expiry set to
// `clock_timestamp() + ttl` next to `updated_at = clock_timestamp()` lands a
// little short of one TTL after it. One row write takes one statement time.
//
// Flagged (in `.set({...})`, `.values({...})`, or a `set:`/`values:` option):
//   .set({ expiresAt: sql`clock_timestamp() + ${ttl}`, updatedAt: sql`clock_timestamp()` })
// Allowed:
//   .set({ expiresAt: sql`statement_timestamp() + ${ttl}`, updatedAt: sql`statement_timestamp()` })
//   .set({ updatedAt: sql`clock_timestamp()` })

import { eslintCompatPlugin } from "@oxlint/plugins";

const ROW_WRITE_KEYS = new Set(["set", "values"]);

const MESSAGE =
  "`clock_timestamp()` advances within a statement, so each column here " +
  "gets a different instant. Use `statement_timestamp()` for every time " +
  "column of one row write.";

type Node = { type: string; [key: string]: unknown };

const isNode = (value: unknown): value is Node =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  typeof value.type === "string";

const readsClock = (value: unknown): boolean => {
  if (!isNode(value) || value.type !== "TaggedTemplateExpression") {
    return false;
  }
  const { tag, quasi } = value;
  if (!isNode(tag) || tag.type !== "Identifier" || tag["name"] !== "sql") {
    return false;
  }
  if (!isNode(quasi) || !Array.isArray(quasi["quasis"])) {
    return false;
  }
  return quasi["quasis"].some((element) => {
    // A template element's value is a plain { raw, cooked } record.
    const text: unknown = isNode(element) ? element["value"] : undefined;
    return (
      typeof text === "object" &&
      text !== null &&
      "raw" in text &&
      typeof text.raw === "string" &&
      text.raw.includes("clock_timestamp(")
    );
  });
};

const propertyName = (node: Node): string | undefined => {
  const key = node["key"];
  if (node["computed"] === true || !isNode(key)) {
    return undefined;
  }
  return key.type === "Identifier" && typeof key["name"] === "string"
    ? key["name"]
    : undefined;
};

export default eslintCompatPlugin({
  meta: { name: "one-statement-time-per-row-write" },
  rules: {
    "one-statement-time-per-row-write": {
      meta: {
        type: "problem",
        messages: { twoInstants: MESSAGE },
      },
      createOnce(context) {
        const check = (object: unknown) => {
          if (!isNode(object) || !Array.isArray(object["properties"])) {
            return;
          }
          const clockReads = object["properties"].filter(
            (property) =>
              isNode(property) &&
              property.type === "Property" &&
              readsClock(property["value"]),
          );
          for (const property of clockReads.slice(1)) {
            context.report({ node: property, messageId: "twoInstants" });
          }
        };
        return {
          CallExpression(node) {
            const { callee } = node;
            if (
              callee.type === "MemberExpression" &&
              !callee.computed &&
              callee.property.type === "Identifier" &&
              ROW_WRITE_KEYS.has(callee.property.name)
            ) {
              const [first] = node.arguments;
              if (first?.type === "ArrayExpression") {
                for (const element of first.elements) {
                  check(element);
                }
              } else {
                check(first);
              }
            }
          },
          Property(node) {
            const name = propertyName(node);
            if (name !== undefined && ROW_WRITE_KEYS.has(name)) {
              check(node.value);
            }
          },
        };
      },
    },
  },
});
