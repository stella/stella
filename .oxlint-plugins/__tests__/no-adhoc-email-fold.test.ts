import { expect, test } from "bun:test";

import oxlintConfig from "../../oxlint.config.ts";
import { lintSingleRule } from "./lint-single-rule.ts";

const RULE = "no-adhoc-email-fold";
const RULE_ID = `${RULE}/${RULE}`;
const OWNER = "apps/api/src/lib/email/normalized-email.ts";

test("rejects every hand-written fold of an email-named value", async () => {
  const source = [
    "email.toLowerCase();",
    "email.trim().toLowerCase();",
    "email?.trim().toLowerCase();",
    "user.email.toLowerCase();",
    "result.user.email.trimStart().trimEnd().toLowerCase();",
    'profile["email"].toLowerCase();',
    "userEmail.toLocaleLowerCase();",
    "file.uploaderEmail.toLowerCase();",
    "senderMailbox.toLowerCase();",
    "(email as string).toLowerCase();",
    'email["toLowerCase"]();',
    "email.toLocaleLowerCase('tr');",
  ].join("\n");
  expect(await lintSingleRule(RULE, source)).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
  ]);
});

test("rejects a lowercase action in an address schema, in any order", async () => {
  const source = [
    "v.pipe(v.string(), v.trim(), v.toLowerCase(), v.email());",
    "v.pipe(v.string(), v.email(), v.toLowerCase());",
    'v.pipe(v.string(), v.toLowerCase(), v.email("Invalid email"));',
  ].join("\n");
  expect(await lintSingleRule(RULE, source)).toEqual([1, 2, 3]);
});

test("rejects a hand-written SQL case fold of an address column", async () => {
  const source = [
    `sql\`lower(\${user.email}) = \${key}\`;`,
    `sql\`select 1 where upper( \${account.email} ) = \${key}\`;`,
    `sql.raw\`LOWER(\${email})\`;`,
  ].join("\n");
  expect(await lintSingleRule(RULE, source)).toEqual([1, 2, 3]);
});

test("accepts the owner's calls and folds of values not named like an address", async () => {
  const source = [
    "normalizeEmail(email);",
    "normalizeEmail(user.email) === normalizeEmail(config.email);",
    "emailColumnMatches(user.email, normalizeEmail(email));",
    "v.pipe(emailAddressSchema, v.check((email) => !email.includes('*')));",
    "user.name.toLowerCase();",
    "header.trim().toLowerCase();",
    "tenantId.toLowerCase();",
    "v.pipe(v.string(), v.trim(), v.toLowerCase(), v.regex(/^[a-z]+$/u));",
    "v.pipe(v.string(), v.email());",
    `sql\`lower(\${user.name}) = \${name}\`;`,
    `sql\`\${user.email} = \${key}\`;`,
    `other\`lower(\${user.email})\`;`,
    "email.trim();",
    "toLowerCase(email);",
  ].join("\n");
  expect(await lintSingleRule(RULE, source)).toEqual([]);
});

const ruleOverride = () => {
  const overrides = oxlintConfig.overrides;
  const matching = overrides.filter(
    (override) => override.rules?.[RULE_ID] !== undefined,
  );
  expect(matching).toHaveLength(1);
  return matching[0];
};

test("covers the whole API outside the owner and the test files", () => {
  const override = ruleOverride();
  expect(override?.rules?.[RULE_ID]).toBe("error");
  expect(override?.files).toContain("apps/api/**/*.ts");
  expect(
    override !== undefined && "excludeFiles" in override
      ? override.excludeFiles
      : undefined,
  ).toEqual([OWNER, "apps/api/**/*.test.ts"]);
});
