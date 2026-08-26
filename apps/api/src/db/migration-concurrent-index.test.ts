import { describe, expect, test } from "bun:test";
import nodePath from "node:path";

import { ONLINE_VALIDATED_INDEX_NAMES } from "./online-migrations";

const MIGRATIONS_DIR = nodePath.resolve(import.meta.dir, "../../drizzle");
const ZERO_DURATION = /^'?0\s*(?:us|ms|s|min|h|d)?'?$/iu;
const CONCURRENT_INDEX_OPERATION =
  /^(?:(?:CREATE\s+(?:UNIQUE\s+)?|DROP\s+)INDEX\s+CONCURRENTLY|REINDEX\s+INDEX\s+CONCURRENTLY)\b/iu;
const CONCURRENT_IF_NOT_EXISTS =
  /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+"([^"]+)"/giu;
const CONCURRENT_UNIQUE_CREATE =
  /\bCREATE\s+UNIQUE\s+INDEX\s+CONCURRENTLY(?<idempotent>\s+IF\s+NOT\s+EXISTS)?\s+"(?<name>[^"]+)"/giu;
const CONCURRENT_DROP =
  /\bDROP\s+INDEX\s+CONCURRENTLY\s+IF\s+EXISTS\s+"([^"]+)"/giu;
const CONCURRENT_REINDEX = /\bREINDEX\s+INDEX\s+CONCURRENTLY\s+"([^"]+)"/giu;
const TYPE_CHANGE =
  /^ALTER\s+TABLE\b[^;]*?\bALTER\s+(?:COLUMN\s+)?(?:(?:U&)?"(?:""|[^"])+"(?:\s+UESCAPE\s+'(?:''|[^'])*')?|[A-Z_\u0080-\u{10FFFF}][A-Z0-9_$\u0080-\u{10FFFF}]*)\s+(?:SET\s+DATA\s+)?TYPE\b/iu;
const TYPE_CHANGE_ANYWHERE =
  /\bALTER\s+TABLE\b[\s\S]*?\bALTER\s+(?:COLUMN\s+)?(?:(?:U&)?"(?:""|[^"])+"(?:\s+UESCAPE\s+'(?:''|[^'])*')?|[A-Z_\u0080-\u{10FFFF}][A-Z0-9_$\u0080-\u{10FFFF}]*)\s+(?:SET\s+DATA\s+)?TYPE\b/iu;
const TYPE_CHANGE_CLAUSE =
  /\bALTER\s+(?:COLUMN\s+)?(?:(?:U&)?"(?:""|[^"])+"(?:\s+UESCAPE\s+'(?:''|[^'])*')?|[A-Z_\u0080-\u{10FFFF}][A-Z0-9_$\u0080-\u{10FFFF}]*)\s+(?:SET\s+DATA\s+)?TYPE\b/giu;
const TRANSACTION_REVERSAL =
  /^(?:ABORT|ROLLBACK|SAVEPOINT|RELEASE\s+SAVEPOINT)\b/iu;
const TYPE_CHANGE_POLICY = {
  boundedRewrite: "stella-migration-safety: bounded-type-rewrite",
  metadataOnly: "stella-migration-safety: metadata-only-type-change",
} as const;
const TYPE_CHANGE_POLICY_STATEMENT = "STELLA_MIGRATION_SAFETY";
const CUSTOM_BOUNDED_TYPE_CHANGE_MIGRATIONS = new Set([
  // This conversion derives a 20-minute execution budget from pg_settings in
  // a DO block, which the statement scanner deliberately does not interpret.
  "20260729150000_timestamptz_everywhere/migration.sql",
]);
// Migrations may execute only these exact historical DO blocks.
// Fingerprinting the complete statement makes comments, quoting tricks, and
// dynamically assembled commands unable to bypass migration safety checks.
const APPROVED_PROCEDURAL_STATEMENTS = new Set([
  "20260429220500_global-search-unaccent/migration.sql:6eab967f03d9401b8f0791d81603f9540ac19fb872df5404f9b66ffff431d589",
  "20260429220500_global-search-unaccent/migration.sql:fe14433fc2fcc398e1d4efcd301f325a8f6e76705c158cd829b17fb9bb7f8797",
  "20260429220500_global-search-unaccent/migration.sql:2d8e7507916a4d6160ec2edebc72136c1b814cd55e2d766021ed5bbc25b5fd10",
  "20260429220500_global-search-unaccent/migration.sql:96584144b62646b9e7859c471fb271a920e6785cec5645cfd5182576f128141f",
  "20260504100000_chat-threads-organization-scope/migration.sql:56576f1e71c46aaba73327268f179c9fa6bafb717cffc7230cf6b2294c663e18",
  "20260510140000_document_rls_role_bootstrap/migration.sql:98cea54dd358cd650e49f706f9dc97990ab002e11ebead4736153aa8e40bbfe4",
  "20260510140000_document_rls_role_bootstrap/migration.sql:395c2e81d9db0b318f21466b273293c831b6715cc6d40f50db83cb39ff11c9c3",
  "20260510140000_document_rls_role_bootstrap/migration.sql:d7eda9dce4fb0c195bb88935168ca9fcf2307267adf33e3a08d697dae946fd5b",
  "20260510140000_document_rls_role_bootstrap/migration.sql:462404b62bc8a7440ce8e11aba1569886bc20b5c28c36ff2a88dc473f88dc45c",
  "20260516000000_case_law_ingestion_role/migration.sql:c3b2204559fb83fd696a107f42a35550c1ad035d337ce140010b63cb548e0a7b",
  "20260516000000_case_law_ingestion_role/migration.sql:7b418d2eab757c5c8d2105af6a199e9d7230ffaf213392eb0643bfb46018791a",
  "20260710173000_scalable_workspace_authorization/migration.sql:3b9057e5984cb105ddfdd2dc180e3e2f99655e12806fe59d7932b9bbdde7efea",
  "20260710173000_scalable_workspace_authorization/migration.sql:1fbe6a02081e270d5825863e873adb9007091344f41a9cc11296e90e9b370668",
  "20260710173000_scalable_workspace_authorization/migration.sql:162ceb09f52df96363765049625fc9fd03c2a5f00814c25c70ea50c7f043213d",
  "20260808007000_ai_memory_workspace_tenant_index/migration.sql:c2b0bcdf9034ce78b3f50acecf4254308deb21216601eaeb8aa8e0df675336ca",
  "20260808014000_legal_lists/migration.sql:6f7e9cfb9b2356f0c40c30909f6ea6c6155feb6d446921a5bc437f1913089935",
  "20260729150000_timestamptz_everywhere/migration.sql:1649cdb7d657ac6006bb5a1b76422b0b9be8fc0d7b8b338231fcd41b7778a7fe",
  "20260730090000_document_processing_mode/migration.sql:7de38e6645893bfca31e121c098e424c77a00aae03fd3400ebab26c6d6123437",
  "20260730120000_extracted_content_source_provenance/migration.sql:4094a6ecc995baccbc5cb4ef508627f026d7106e0b82b2848a594f3133a1bee0",
  "20260730120000_extracted_content_source_provenance/migration.sql:f7ed57df2f71621ff26baa780f24f69a652a3e125d29e8090057890a89477720",
  "20260730120000_extracted_content_source_provenance/migration.sql:2917a6d88b1415b2b3fa6e9e1bf547a19da3d350f85dc97e6200eb318bcfd378",
  "20260731200000_case_law_ingestion_retry_state/migration.sql:205b4776581f87ba60c7e8bd7b4d45ea50575dcc515360917b141e01850c2de7",
  "20260731220000_case_law_redaction_fence/migration.sql:2802dc5388a64131da315915a25f9c0bbda6d72d6d7a2e7081aa03036dfd64d8",
  "20260731140000_matter_activity_provenance/migration.sql:f610b6a8787606f96741173e9cf7cc3a84ba23eb4ff892b39dbb56cec39a096b",
  "20260731170000_case_law_corpus_generation_backfill/migration.sql:a37f67d4e178fc403e75d871d17a31ee964754f87589f995571b71a1d15ca144",
  "20260731170000_case_law_corpus_generation_backfill/migration.sql:a12d358dc0bc37698b3cd6a8ff5c4d0355050db0117f7671f574e0bfdfd282b6",
  "20260731170000_case_law_corpus_generation_backfill/migration.sql:75b21e27d35379209cc63a9dbf5fc1b6ad21a2945cf4cc0788f9e5a335aad806",
  "20260731170000_case_law_corpus_generation_backfill/migration.sql:d12b8d4de8e6436dfebb1177277fbc1dbbf4482afb429b38ae599c14350cf8c5",
  "20260731170000_case_law_corpus_generation_backfill/migration.sql:83417da56687155c11d3f0c999608af4a6abcdd78162f2d0a485e33ff40f9b7f",
  "20260731170000_case_law_corpus_generation_backfill/migration.sql:e395b6cbdc652a7d70833c571587cda7e4dba86323a19a1bcfe67874a90afec1",
  "20260731170000_case_law_corpus_generation_backfill/migration.sql:938744a8ba4d42a4fc2f6738ef8060d25b4cce08e0f88c393b9ae0a30d046984",
  "20260731170000_case_law_corpus_generation_backfill/migration.sql:bd1d14e9b83389dfc908098d23d61c93c1bc8c3a12a06fb8d090c7aa6de698e9",
  "20260731170000_case_law_corpus_generation_backfill/migration.sql:156772a852d5e4193fc68e5effb6881b8f9f022435c91882f16d5ad642c88993",
  "20260801140000_report_export_result_field/migration.sql:f6ad29cee9c49e07aad487cf5a8d5f32838b63a1cfa8f92a071a4f0afc277a5d",
  "20260801120000_case_law_source_ingestion_lease/migration.sql:c8cddc8405b46385e7159c745ccb8c095e88e67a6c4ff0a2d6bcd1cd124a2b63",
  "20260805100000_ocr_exports/migration.sql:a119e3e1f41e55e853ae907e400426de2443dd1575f675c10e705b945c6e0e66",
  // Adds the chat reasoning-effort CHECK only when it is absent. The body is
  // static DDL; the conditional makes a partially applied migration retryable.
  "20260808003000_chat_reasoning_effort/migration.sql:871dd7588123b5ea2a092acac856c0427e4cf8673b8494bc94cf0a6dbd6cfd0f",
  // Refuses to re-order the corpus-index rebuild's cursor while a rebuild is
  // in flight. Reads one small checkpoint table and raises; it writes nothing,
  // takes no lock beyond the read, and stopping the release is the intended
  // outcome, since the two orders cannot share one cursor slot.
  "20260817150000_corpus_generation_date_walk/migration.sql:06821016b65f9c0e7ab643794da37f29616a0ccbef91df3df8b1806197f5ac8c",
  // Adds the decision-date bounds CHECK NOT VALID only when it is absent. The
  // body is static DDL; the conditional makes the file retryable after the
  // VALIDATE that follows it outside the migrator transaction.
  "20260818090000_case_law_decision_date_bounds/migration.sql:31f2786a7f7aed2d2e55bd3161acad6ad49e606ec1bc75e9235de07cdadd96e0",
  // Fails the Better Auth cutover before any constraint or index state is
  // committed when the trusted issuer backfill is incomplete. The static body
  // performs one bounded existence read and raises; it executes no dynamic SQL.
  "20260825220000_better_auth_17_constraints/migration.sql:4c1e0d5fdbb50e29863c067586c405148beb02f76a2af8ebbced851a866abc13",
  // Refuses to seed a legacy serving route over an existing generation bound
  // to a different cluster. The static body reads two primary-key rows and
  // raises; it executes no dynamic SQL.
  "20260826004000_corpus_index_serving_generation/migration.sql:2a9afa811510709034b847b4ecdcf3f3a78d5c499cb4f584ac6ef0e9410d8419",
  // Refuses to finish the reader cutover unless both families have a serving
  // generation. The static body performs one bounded existence read over
  // corpus_index_generations and raises; it executes no dynamic SQL.
  "20260826004000_corpus_index_serving_generation/migration.sql:3cf1be3c49aad9abb99793f955b1c60e6d4fc5926ca1538e9ae2419a14242738",
]);

type TimeoutState = "bounded" | "unbounded" | "unset";
type TypeChangePolicy = "boundedRewrite" | "metadataOnly";
type SqlQuote = {
  backslashEscapes: boolean;
  character: '"' | "'";
};
type TimeoutUpdate =
  | {
      type: "checkpoint";
      name: "lock" | "statement";
    }
  | {
      type: "restore";
      name: "lock" | "statement";
    }
  | {
      type: "set";
      name: "lock" | "statement";
      scope: "local" | "session";
      state: TimeoutState;
    }
  | {
      type: "reset";
      name: "all" | "lock" | "statement";
    }
  | {
      type: "preserve";
      name: "lock" | "statement";
      scope: "local" | "session";
    };

const classifyTimeout = (value: string): TimeoutState => {
  if (ZERO_DURATION.test(value)) {
    return "unbounded";
  }
  if (/^'?[1-9][0-9]*\s*(?:us|ms|s|min|h|d)?'?$/iu.test(value)) {
    return "bounded";
  }
  return "unset";
};

const POSTGRES_IDENTIFIER_CONTINUATION = /[A-Z0-9_$\u0080-\u{10FFFF}]/iu;

const dollarQuoteDelimiterAt = (source: string, index: number) => {
  if (POSTGRES_IDENTIFIER_CONTINUATION.test(source[index - 1] ?? "")) {
    return undefined;
  }
  return /^\$(?:[A-Z_\u0080-\u{10FFFF}][A-Z0-9_\u0080-\u{10FFFF}]*)?\$/iu
    .exec(source.slice(index))
    ?.at(0);
};

const sqlQuoteAt = (
  source: string,
  index: number,
  character: '"' | "'",
): SqlQuote => {
  const prefix = source[index - 1] ?? "";
  const beforePrefix = source[index - 2] ?? "";
  const isEscapeString =
    character === "'" &&
    prefix.toLowerCase() === "e" &&
    !POSTGRES_IDENTIFIER_CONTINUATION.test(beforePrefix);

  return { backslashEscapes: isEscapeString, character };
};

const policyStatementForComment = (comment: string) => {
  if (comment.includes(TYPE_CHANGE_POLICY.metadataOnly)) {
    return `${TYPE_CHANGE_POLICY_STATEMENT} metadataOnly;`;
  }
  if (comment.includes(TYPE_CHANGE_POLICY.boundedRewrite)) {
    return `${TYPE_CHANGE_POLICY_STATEMENT} boundedRewrite;`;
  }
  return "";
};

const stripSqlComments = (source: string) => {
  let result = "";
  let index = 0;
  let blockCommentDepth = 0;
  let dollarQuoteDelimiter: string | undefined;
  let quote: SqlQuote | undefined;

  while (index < source.length) {
    const character = source[index] ?? "";
    const nextCharacter = source[index + 1] ?? "";

    if (blockCommentDepth > 0) {
      if (character === "/" && nextCharacter === "*") {
        blockCommentDepth += 1;
        index += 2;
      } else if (character === "*" && nextCharacter === "/") {
        blockCommentDepth -= 1;
        index += 2;
      } else {
        if (character === "\n") {
          result += "\n";
        }
        index += 1;
      }
      continue;
    }

    if (dollarQuoteDelimiter) {
      if (source.startsWith(dollarQuoteDelimiter, index)) {
        result += dollarQuoteDelimiter;
        index += dollarQuoteDelimiter.length;
        dollarQuoteDelimiter = undefined;
      } else {
        result += character;
        index += 1;
      }
      continue;
    }

    if (quote) {
      result += character;
      if (quote.backslashEscapes && character === "\\" && nextCharacter) {
        result += nextCharacter;
        index += 2;
      } else if (
        character === quote.character &&
        nextCharacter === quote.character
      ) {
        result += nextCharacter;
        index += 2;
      } else {
        if (character === quote.character) {
          quote = undefined;
        }
        index += 1;
      }
      continue;
    }

    if (character === "-" && nextCharacter === "-") {
      const newlineIndex = source.indexOf("\n", index + 2);
      const commentEnd = newlineIndex === -1 ? source.length : newlineIndex;
      const policyStatement = policyStatementForComment(
        source.slice(index + 2, commentEnd),
      );
      if (policyStatement) {
        result += `\n${policyStatement}\n`;
      }
      if (newlineIndex === -1) {
        break;
      }
      result += "\n";
      index = commentEnd + 1;
      continue;
    }
    if (character === "/" && nextCharacter === "*") {
      result += " ";
      blockCommentDepth = 1;
      index += 2;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = sqlQuoteAt(source, index, character);
      result += character;
      index += 1;
      continue;
    }
    if (character === "$") {
      const delimiter = dollarQuoteDelimiterAt(source, index);
      if (delimiter) {
        dollarQuoteDelimiter = delimiter;
        result += delimiter;
        index += delimiter.length;
        continue;
      }
    }

    result += character;
    index += 1;
  }

  return result;
};

const splitSqlStatements = (source: string) => {
  const statements = [];
  const sql = stripSqlComments(source);
  let current = "";
  let index = 0;
  let dollarQuoteDelimiter: string | undefined;
  let quote: SqlQuote | undefined;

  while (index < sql.length) {
    const character = sql[index] ?? "";
    const nextCharacter = sql[index + 1] ?? "";

    if (dollarQuoteDelimiter) {
      if (sql.startsWith(dollarQuoteDelimiter, index)) {
        current += dollarQuoteDelimiter;
        index += dollarQuoteDelimiter.length;
        dollarQuoteDelimiter = undefined;
      } else {
        current += character;
        index += 1;
      }
      continue;
    }

    if (quote) {
      current += character;
      if (quote.backslashEscapes && character === "\\" && nextCharacter) {
        current += nextCharacter;
        index += 2;
      } else if (
        character === quote.character &&
        nextCharacter === quote.character
      ) {
        current += nextCharacter;
        index += 2;
      } else {
        if (character === quote.character) {
          quote = undefined;
        }
        index += 1;
      }
      continue;
    }

    if (character === "'" || character === '"') {
      quote = sqlQuoteAt(sql, index, character);
      current += character;
      index += 1;
      continue;
    }
    if (character === "$") {
      const delimiter = dollarQuoteDelimiterAt(sql, index);
      if (delimiter) {
        dollarQuoteDelimiter = delimiter;
        current += delimiter;
        index += delimiter.length;
        continue;
      }
    }
    if (character === ";") {
      if (current.trim()) {
        statements.push(current.trim());
      }
      current = "";
      index += 1;
      continue;
    }

    current += character;
    index += 1;
  }

  if (current.trim()) {
    statements.push(current.trim());
  }

  return statements;
};

const parseTimeoutUpdate = (statement: string): TimeoutUpdate | undefined => {
  if (/^DISCARD\s+ALL$/iu.test(statement)) {
    return { type: "reset", name: "all" };
  }

  const checkpointGroups =
    /^(?:SELECT|PERFORM)\s+(?:pg_catalog\.)?set_config\(\s*'stella\.migration_(?<name>statement|lock)_timeout'\s*,\s*(?:pg_catalog\.)?current_setting\(\s*'(?<source>statement|lock)_timeout'\s*\)\s*,\s*false\s*\)$/iu.exec(
      statement,
    )?.groups;
  const checkpointName = checkpointGroups?.["name"];
  if (
    (checkpointName === "lock" || checkpointName === "statement") &&
    checkpointGroups?.["source"] === checkpointName
  ) {
    return { type: "checkpoint", name: checkpointName };
  }

  const restoreGroups =
    /^(?:SELECT|PERFORM)\s+(?:pg_catalog\.)?set_config\(\s*'(?<name>statement|lock)_timeout'\s*,\s*(?:pg_catalog\.)?current_setting\(\s*'stella\.migration_(?<source>statement|lock)_timeout'\s*\)\s*,\s*false\s*\)$/iu.exec(
      statement,
    )?.groups;
  const restoreName = restoreGroups?.["name"];
  if (
    (restoreName === "lock" || restoreName === "statement") &&
    restoreGroups?.["source"] === restoreName
  ) {
    return { type: "restore", name: restoreName };
  }

  const setGroups =
    /^SET\s+(?:(?<scope>SESSION|LOCAL)\s+)?(?<name>statement|lock)_timeout\s*(?:(?:=|TO)\s*(?<value>.+)|FROM\s+CURRENT)$/iu.exec(
      statement,
    )?.groups;
  const setName = setGroups?.["name"];
  if (setName === "lock" || setName === "statement") {
    const scope =
      setGroups?.["scope"]?.toLowerCase() === "local" ? "local" : "session";
    if (!setGroups?.["value"]) {
      return { type: "preserve", name: setName, scope };
    }
    if (/^DEFAULT$/iu.test(setGroups["value"])) {
      return scope === "session"
        ? { type: "reset", name: setName }
        : { type: "preserve", name: setName, scope };
    }
    return {
      type: "set",
      name: setName,
      scope,
      state: classifyTimeout(setGroups["value"]),
    };
  }

  const setConfigGroups =
    /^(?:SELECT|PERFORM)\s+(?:pg_catalog\.)?set_config\(\s*'(?<name>statement|lock)_timeout'\s*,\s*(?<value>'(?:''|[^'])*')\s*,\s*(?<local>true|false)\s*\)$/iu.exec(
      statement,
    )?.groups;
  const setConfigName = setConfigGroups?.["name"];
  if (setConfigName === "lock" || setConfigName === "statement") {
    return {
      type: "set",
      name: setConfigName,
      scope:
        setConfigGroups?.["local"]?.toLowerCase() === "true"
          ? "local"
          : "session",
      state: classifyTimeout(setConfigGroups?.["value"] ?? ""),
    };
  }

  const resetName =
    /^RESET\s+(?<name>ALL|statement_timeout|lock_timeout)$/iu.exec(statement)
      ?.groups?.["name"];
  if (resetName?.toLowerCase() === "all") {
    return { type: "reset", name: "all" };
  }
  if (resetName?.toLowerCase() === "lock_timeout") {
    return { type: "reset", name: "lock" };
  }
  if (resetName?.toLowerCase() === "statement_timeout") {
    return { type: "reset", name: "statement" };
  }

  return undefined;
};

const parseTypeChangePolicy = (
  statement: string,
): TypeChangePolicy | undefined => {
  const policy = new RegExp(
    `^${TYPE_CHANGE_POLICY_STATEMENT}\\s+(boundedRewrite|metadataOnly)$`,
    "u",
  )
    .exec(statement)
    ?.at(1);
  if (policy === "boundedRewrite" || policy === "metadataOnly") {
    return policy;
  }
  return undefined;
};

const isCustomStatementBudget = (statement: string) =>
  /^DO\s+\$\$\s*DECLARE\s+current_ms\s+integer\s*;\s*BEGIN\s+SELECT\s+setting::integer\s+INTO\s+current_ms\s+FROM\s+pg_settings\s+WHERE\s+name\s*=\s*'statement_timeout'\s*;\s*IF\s+current_ms\s*=\s*0\s+OR\s+current_ms\s*<\s*1200000\s+THEN\s+PERFORM\s+set_config\(\s*'statement_timeout'\s*,\s*'20min'\s*,\s*false\s*\)\s*;\s*END\s+IF\s*;\s*END\s*\$\$$/iu.test(
    statement,
  );

const isUnapprovedProceduralStatement = (
  relativePath: string,
  statement: string,
) => {
  if (!/^DO\b/iu.test(statement)) {
    return false;
  }
  if (
    CUSTOM_BOUNDED_TYPE_CHANGE_MIGRATIONS.has(relativePath) &&
    isCustomStatementBudget(statement)
  ) {
    return false;
  }

  const hash = new Bun.CryptoHasher("sha256").update(statement).digest("hex");
  return !APPROVED_PROCEDURAL_STATEMENTS.has(`${relativePath}:${hash}`);
};

const collectUnsafeConcurrentTimeouts = (
  relativePath: string,
  source: string,
) => {
  const violations = [];
  const statements = splitSqlStatements(source);
  let statementTimeout: TimeoutState = "unset";
  let lockTimeout: TimeoutState = "unset";
  let statementTimeoutCheckpoint: TimeoutState | undefined;
  let lockTimeoutCheckpoint: TimeoutState | undefined;
  let statementTimeoutRequiresRestore = false;
  let concurrentBlockOpen = false;
  let statementTimeoutRestored = false;
  let lockTimeoutRequiresRestore = false;

  for (const statement of statements) {
    if (isUnapprovedProceduralStatement(relativePath, statement)) {
      violations.push(
        `${relativePath}: procedural migration statement is not approved`,
      );
      continue;
    }
    const timeoutUpdate = parseTimeoutUpdate(statement);
    const isConcurrentOperation = CONCURRENT_INDEX_OPERATION.test(statement);
    const isUnsupportedTransactionReversal =
      TRANSACTION_REVERSAL.test(statement);
    const isStatementRestore =
      (timeoutUpdate?.type === "restore" &&
        timeoutUpdate.name === "statement" &&
        statementTimeoutCheckpoint !== undefined) ||
      (timeoutUpdate?.type === "set" &&
        timeoutUpdate.name === "statement" &&
        timeoutUpdate.scope === "session" &&
        timeoutUpdate.state === "bounded");
    const isProtocolBridge =
      (timeoutUpdate?.type === "set" && timeoutUpdate.name === "lock") ||
      (timeoutUpdate?.type === "restore" && timeoutUpdate.name === "lock") ||
      (timeoutUpdate?.type === "reset" &&
        (timeoutUpdate.name === "all" || timeoutUpdate.name === "lock")) ||
      /^(?:BEGIN|COMMIT)$/iu.test(statement);

    if (isUnsupportedTransactionReversal) {
      violations.push(
        `${relativePath}: timeout safety does not support transaction reversal`,
      );
    }

    if (timeoutUpdate?.type === "checkpoint") {
      if (timeoutUpdate.name === "statement") {
        statementTimeoutCheckpoint = statementTimeout;
      } else {
        lockTimeoutCheckpoint = lockTimeout;
      }
    } else if (timeoutUpdate?.type === "restore") {
      const checkpoint =
        timeoutUpdate.name === "statement"
          ? statementTimeoutCheckpoint
          : lockTimeoutCheckpoint;
      if (checkpoint === undefined) {
        violations.push(
          `${relativePath}: ${timeoutUpdate.name} timeout restore lacks a checkpoint`,
        );
      } else if (timeoutUpdate.name === "statement") {
        statementTimeout = checkpoint;
        statementTimeoutRequiresRestore = false;
      } else {
        lockTimeout = checkpoint;
        lockTimeoutRequiresRestore = false;
      }
    } else if (
      timeoutUpdate?.type === "set" &&
      timeoutUpdate.scope === "session"
    ) {
      if (timeoutUpdate.name === "statement") {
        statementTimeout = timeoutUpdate.state;
        statementTimeoutRequiresRestore = timeoutUpdate.state === "unbounded";
      } else {
        lockTimeout = timeoutUpdate.state;
        lockTimeoutRequiresRestore = timeoutUpdate.state !== "bounded";
      }
    } else if (timeoutUpdate?.type === "reset") {
      if (timeoutUpdate.name === "all" || timeoutUpdate.name === "statement") {
        statementTimeout = "unset";
      }
      if (timeoutUpdate.name === "all" || timeoutUpdate.name === "lock") {
        lockTimeout = "unset";
        if (concurrentBlockOpen) {
          lockTimeoutRequiresRestore = true;
        }
      }
    }

    if (concurrentBlockOpen) {
      if (isStatementRestore) {
        statementTimeoutRestored = true;
      }
      if (statementTimeoutRestored && !lockTimeoutRequiresRestore) {
        concurrentBlockOpen = false;
      } else if (
        !isConcurrentOperation &&
        !isStatementRestore &&
        !isProtocolBridge
      ) {
        violations.push(
          `${relativePath}: timeouts are not restored immediately after concurrent index operations`,
        );
        concurrentBlockOpen = false;
      }
    }

    if (timeoutUpdate || isUnsupportedTransactionReversal) {
      continue;
    }
    if (!isConcurrentOperation) {
      continue;
    }

    if (statementTimeout !== "unbounded") {
      violations.push(
        `${relativePath}: concurrent index operation has a timeout`,
      );
    }
    concurrentBlockOpen = true;
    statementTimeoutRestored = false;
    lockTimeoutRequiresRestore = lockTimeout === "unbounded";
  }

  if (concurrentBlockOpen && lockTimeoutRequiresRestore) {
    violations.push(`${relativePath}: lock timeout is not restored`);
  }
  if (
    (concurrentBlockOpen && !statementTimeoutRestored) ||
    (!concurrentBlockOpen && statementTimeoutRequiresRestore)
  ) {
    violations.push(`${relativePath}: statement timeout is not restored`);
  }

  return violations;
};

const collectUnsafeConcurrentIndexes = async (): Promise<string[]> => {
  const violations: string[] = [];
  const migrationFiles = new Bun.Glob("20*/migration.sql");

  for await (const relativePath of migrationFiles.scan({
    cwd: MIGRATIONS_DIR,
  })) {
    const source = await Bun.file(
      nodePath.join(MIGRATIONS_DIR, relativePath),
    ).text();
    const sqlWithoutLineComments = stripSqlComments(source);
    for (const match of sqlWithoutLineComments.matchAll(
      CONCURRENT_IF_NOT_EXISTS,
    )) {
      const name = match.at(1);
      if (!name || !ONLINE_VALIDATED_INDEX_NAMES.has(name)) {
        violations.push(
          `${relativePath}: ${name ?? "unknown index"} uses IF NOT EXISTS without an online validity postcondition`,
        );
      }
    }

    const droppedIndexes = new Set(
      [...sqlWithoutLineComments.matchAll(CONCURRENT_DROP)].flatMap((match) => {
        const name = match.at(1);
        return name ? [name] : [];
      }),
    );
    const concurrentUniqueCreates = [
      ...sqlWithoutLineComments.matchAll(CONCURRENT_UNIQUE_CREATE),
    ];
    const concurrentReindexPositions = new Map<string, number[]>();
    for (const match of sqlWithoutLineComments.matchAll(CONCURRENT_REINDEX)) {
      const name = match.at(1);
      if (name === undefined) {
        continue;
      }
      const positions = concurrentReindexPositions.get(name) ?? [];
      positions.push(match.index);
      concurrentReindexPositions.set(name, positions);
    }
    const firstForeignKeyIndex =
      sqlWithoutLineComments.search(/\bFOREIGN\s+KEY\b/iu);
    const createdUniqueIndexes = new Set(
      concurrentUniqueCreates.flatMap(({ groups }) => {
        const name = groups?.["name"];
        return name ? [name] : [];
      }),
    );
    if (
      concurrentUniqueCreates.some(({ groups }) => groups?.["idempotent"]) &&
      [...droppedIndexes].some((name) => !createdUniqueIndexes.has(name))
    ) {
      violations.push(
        `${relativePath}: unique replacement drop must follow online validity postconditions`,
      );
    }
    for (const match of concurrentUniqueCreates) {
      const { groups } = match;
      const name = groups?.["name"];
      if (!name) {
        continue;
      }
      if (!groups["idempotent"]) {
        violations.push(
          `${relativePath}: unique index ${name} is not retry-idempotent`,
        );
      }
      if (
        groups["idempotent"] &&
        firstForeignKeyIndex !== -1 &&
        !(concurrentReindexPositions.get(name) ?? []).some(
          (position) =>
            position > match.index && position < firstForeignKeyIndex,
        )
      ) {
        violations.push(
          `${relativePath}: unique index ${name} is used before retry validity repair`,
        );
      }
      if (droppedIndexes.has(name)) {
        violations.push(
          `${relativePath}: retry can remove valid unique index ${name}`,
        );
      }
    }
    violations.push(...collectUnsafeConcurrentTimeouts(relativePath, source));
  }

  return violations.sort();
};

const collectUnsafeTypeChangesInMigration = (
  relativePath: string,
  source: string,
) => {
  const violations = [];
  const isCustomBoundedMigration =
    CUSTOM_BOUNDED_TYPE_CHANGE_MIGRATIONS.has(relativePath);
  const statements = splitSqlStatements(source);

  let lockTimeout: TimeoutState = "unset";
  let statementTimeout: TimeoutState = "unset";
  let lockTimeoutCheckpoint: TimeoutState | undefined;
  let statementTimeoutCheckpoint: TimeoutState | undefined;
  let statementTimeoutRequiresRestore = false;
  let metadataOnlyBlockOpen = false;
  let activePolicy: TypeChangePolicy | undefined;
  let activePolicyUsed = false;
  let sawCustomStatementBudget = false;

  for (const statement of statements) {
    const typeChangeClauseCount = [...statement.matchAll(TYPE_CHANGE_CLAUSE)]
      .length;
    if (TRANSACTION_REVERSAL.test(statement)) {
      violations.push(
        `${relativePath}: timeout safety does not support transaction reversal`,
      );
      continue;
    }
    if (isUnapprovedProceduralStatement(relativePath, statement)) {
      violations.push(
        `${relativePath}: procedural migration statement is not approved`,
      );
      continue;
    }
    if (/^DO\b/iu.test(statement) && TYPE_CHANGE_ANYWHERE.test(statement)) {
      violations.push(
        `${relativePath}: procedural type changes are not supported by the timeout safety policy`,
      );
      continue;
    }

    const declaredPolicy = parseTypeChangePolicy(statement);
    if (declaredPolicy) {
      if (metadataOnlyBlockOpen) {
        violations.push(
          `${relativePath}: statement timeout is not restored immediately after metadata-only type changes`,
        );
        metadataOnlyBlockOpen = false;
      }
      if (activePolicy && !activePolicyUsed) {
        violations.push(`${relativePath}: type change policy is unused`);
      }
      activePolicy = declaredPolicy;
      activePolicyUsed = false;
      continue;
    }

    const timeoutUpdate = parseTimeoutUpdate(statement);
    const isTypeChange = TYPE_CHANGE.test(statement);
    const isImmediateRestore =
      (timeoutUpdate?.type === "restore" &&
        timeoutUpdate.name === "statement" &&
        statementTimeoutCheckpoint !== undefined) ||
      (timeoutUpdate?.type === "set" &&
        timeoutUpdate.name === "statement" &&
        timeoutUpdate.scope === "session" &&
        timeoutUpdate.state === "bounded");

    if (
      activePolicy === "boundedRewrite" &&
      activePolicyUsed &&
      !isTypeChange
    ) {
      activePolicy = undefined;
      activePolicyUsed = false;
    }

    if (metadataOnlyBlockOpen) {
      if (!isTypeChange && !isImmediateRestore) {
        violations.push(
          `${relativePath}: statement timeout is not restored immediately after metadata-only type changes`,
        );
        metadataOnlyBlockOpen = false;
        activePolicy = undefined;
        activePolicyUsed = false;
      } else if (isImmediateRestore) {
        metadataOnlyBlockOpen = false;
        activePolicy = undefined;
        activePolicyUsed = false;
      }
    }

    if (timeoutUpdate?.type === "checkpoint") {
      if (timeoutUpdate.name === "lock") {
        lockTimeoutCheckpoint = lockTimeout;
      } else {
        statementTimeoutCheckpoint = statementTimeout;
      }
      continue;
    }
    if (timeoutUpdate?.type === "restore") {
      const checkpoint =
        timeoutUpdate.name === "lock"
          ? lockTimeoutCheckpoint
          : statementTimeoutCheckpoint;
      if (checkpoint === undefined) {
        violations.push(
          `${relativePath}: ${timeoutUpdate.name} timeout restore lacks a checkpoint`,
        );
      } else if (timeoutUpdate.name === "lock") {
        lockTimeout = checkpoint;
      } else {
        statementTimeout = checkpoint;
        statementTimeoutRequiresRestore = false;
      }
      continue;
    }
    if (timeoutUpdate?.type === "set") {
      const nextState =
        timeoutUpdate.scope === "session" ? timeoutUpdate.state : "unset";
      if (timeoutUpdate.name === "lock") {
        lockTimeout = nextState;
      } else {
        statementTimeout = nextState;
        statementTimeoutRequiresRestore = nextState === "unbounded";
      }
      continue;
    }
    if (timeoutUpdate?.type === "reset") {
      if (timeoutUpdate.name === "all" || timeoutUpdate.name === "lock") {
        lockTimeout = "unset";
      }
      if (timeoutUpdate.name === "all" || timeoutUpdate.name === "statement") {
        statementTimeout = "unset";
      }
      continue;
    }
    if (isCustomStatementBudget(statement)) {
      sawCustomStatementBudget = true;
      statementTimeout = "bounded";
      continue;
    }
    if (!isTypeChange) {
      continue;
    }

    if (!isCustomBoundedMigration && !activePolicy) {
      violations.push(
        `${relativePath}: type change lacks an explicit execution policy`,
      );
      continue;
    }
    if (lockTimeout !== "bounded") {
      violations.push(
        `${relativePath}: type change has an unbounded lock wait`,
      );
    }
    if (isCustomBoundedMigration) {
      if (!sawCustomStatementBudget || statementTimeout !== "bounded") {
        violations.push(
          `${relativePath}: custom type rewrite lacks its bounded execution budget`,
        );
      }
      continue;
    }
    if (activePolicy === "metadataOnly" && typeChangeClauseCount > 1) {
      violations.push(
        `${relativePath}: multiple type changes in one statement are not supported by the metadata-only timeout policy`,
      );
      continue;
    }
    activePolicyUsed = true;
    if (activePolicy === "metadataOnly" && statementTimeout !== "unbounded") {
      violations.push(
        `${relativePath}: type change has a bounded execution timeout`,
      );
    }
    if (activePolicy === "metadataOnly") {
      metadataOnlyBlockOpen = true;
    }
    if (activePolicy === "boundedRewrite" && statementTimeout !== "bounded") {
      violations.push(
        `${relativePath}: type rewrite lacks a bounded execution timeout`,
      );
    }
  }

  if (activePolicy && !activePolicyUsed) {
    violations.push(`${relativePath}: type change policy is unused`);
  }
  if (metadataOnlyBlockOpen || statementTimeoutRequiresRestore) {
    violations.push(`${relativePath}: statement timeout is not restored`);
  }

  return violations;
};

const collectUnsafeTypeChanges = async () => {
  const violations = [];
  const migrationFiles = new Bun.Glob("20*/migration.sql");

  for await (const relativePath of migrationFiles.scan({
    cwd: MIGRATIONS_DIR,
  })) {
    const source = await Bun.file(
      nodePath.join(MIGRATIONS_DIR, relativePath),
    ).text();
    violations.push(
      ...collectUnsafeTypeChangesInMigration(relativePath, source),
    );
  }

  return violations.sort();
};

describe("concurrent index migration safety", () => {
  test("enforces bounded-lock, unbounded-build, and validity-aware retries", async () => {
    expect(await collectUnsafeConcurrentIndexes()).toEqual([]);
  });
});

describe("lock-sensitive migration DDL", () => {
  const customStatementBudget = `DO $$
DECLARE current_ms integer;
BEGIN
  SELECT setting::integer INTO current_ms
  FROM pg_settings WHERE name = 'statement_timeout';
  IF current_ms = 0 OR current_ms < 1200000 THEN
    PERFORM set_config('statement_timeout', '20min', false);
  END IF;
END
$$;`;

  test("classifies zero-duration timeout unit forms as unbounded", () => {
    for (const value of ["0", "'0'", "0us", "'0ms'", "0s", "'0min'"]) {
      expect(classifyTimeout(value)).toBe("unbounded");
    }
    for (const value of ["1ms", "'5s'", "20min"]) {
      expect(classifyTimeout(value)).toBe("bounded");
    }
  });

  test("recognizes both PostgreSQL type-change spellings", () => {
    expect(
      TYPE_CHANGE.test(
        'ALTER TABLE "example" ALTER COLUMN "value" TYPE timestamptz',
      ),
    ).toBe(true);
    expect(
      TYPE_CHANGE.test(
        'ALTER TABLE "example" ALTER COLUMN "value" SET DATA TYPE varchar(64)',
      ),
    ).toBe(true);
    expect(
      TYPE_CHANGE.test('ALTER TABLE "example" ALTER "value" TYPE timestamptz'),
    ).toBe(true);
    expect(
      TYPE_CHANGE.test(
        "ALTER TABLE example ALTER COLUMN café TYPE timestamptz",
      ),
    ).toBe(true);
    expect(
      TYPE_CHANGE.test(
        'ALTER TABLE example ALTER COLUMN "a""b" TYPE timestamptz',
      ),
    ).toBe(true);
    expect(
      TYPE_CHANGE.test(
        String.raw`ALTER TABLE example ALTER COLUMN U&"d\0061t" TYPE timestamptz`,
      ),
    ).toBe(true);
  });

  test("requires immediate timeout restoration after metadata-only blocks", () => {
    const safePrefix = `
-- ${TYPE_CHANGE_POLICY.metadataOnly}
SET lock_timeout = '1s';
SET statement_timeout = 0;
ALTER TABLE "example" ALTER COLUMN "value" TYPE varchar(64);`;

    expect(
      collectUnsafeTypeChangesInMigration(
        "safe/migration.sql",
        `${safePrefix}\nSET statement_timeout = '5s';\nSELECT 1;`,
      ),
    ).toEqual([]);
    expect(
      collectUnsafeTypeChangesInMigration(
        "unsafe/migration.sql",
        `${safePrefix}\nSELECT 1;\nSET statement_timeout = '5s';`,
      ),
    ).toContain(
      "unsafe/migration.sql: statement timeout is not restored immediately after metadata-only type changes",
    );
  });

  test("scopes execution policies to contiguous type-change blocks", () => {
    const safeSource = `
SET lock_timeout = '1s';
-- ${TYPE_CHANGE_POLICY.metadataOnly}
SET statement_timeout = 0;
ALTER TABLE example ALTER COLUMN value TYPE varchar(64);
SET statement_timeout = '5s';
-- ${TYPE_CHANGE_POLICY.boundedRewrite}
ALTER TABLE example ALTER COLUMN created_at TYPE timestamptz;
SELECT 1;`;
    expect(
      collectUnsafeTypeChangesInMigration("safe/migration.sql", safeSource),
    ).toEqual([]);
    expect(
      collectUnsafeTypeChangesInMigration(
        "unsafe/migration.sql",
        safeSource.replace(`-- ${TYPE_CHANGE_POLICY.boundedRewrite}\n`, ""),
      ),
    ).toContain(
      "unsafe/migration.sql: type change lacks an explicit execution policy",
    );
  });

  test("rejects transaction-local timeout protocols", () => {
    const relativePath = "20260729150000_timestamptz_everywhere/migration.sql";
    expect(parseTimeoutUpdate("SET LOCAL statement_timeout = 0")).toEqual({
      type: "set",
      name: "statement",
      scope: "local",
      state: "unbounded",
    });
    expect(
      collectUnsafeTypeChangesInMigration(
        relativePath,
        `BEGIN;
        SET LOCAL lock_timeout = '1s';
        COMMIT;
        ${customStatementBudget}
        ALTER TABLE example ALTER COLUMN value TYPE timestamptz;`,
      ),
    ).toContain(`${relativePath}: type change has an unbounded lock wait`);
    expect(parseTimeoutUpdate("SET statement_timeout FROM CURRENT")).toEqual({
      type: "preserve",
      name: "statement",
      scope: "session",
    });
  });

  test("tracks every timeout form around concurrent index operations", () => {
    const unsafePrefix = "SET statement_timeout = 0; RESET statement_timeout;";
    expect(
      collectUnsafeConcurrentTimeouts(
        "reset/migration.sql",
        `${unsafePrefix} CREATE INDEX CONCURRENTLY example_idx ON example (id);`,
      ),
    ).toContain(
      "reset/migration.sql: concurrent index operation has a timeout",
    );
    expect(
      collectUnsafeConcurrentTimeouts(
        "to/migration.sql",
        `SET statement_timeout = 0;
        SET statement_timeout TO '5s';
        CREATE INDEX CONCURRENTLY example_idx ON example (id);`,
      ),
    ).toContain("to/migration.sql: concurrent index operation has a timeout");
    expect(
      collectUnsafeConcurrentTimeouts(
        "set-config/migration.sql",
        `SET statement_timeout = 0;
        SELECT set_config('statement_timeout', '5s', false);
        CREATE INDEX CONCURRENTLY example_idx ON example (id);`,
      ),
    ).toContain(
      "set-config/migration.sql: concurrent index operation has a timeout",
    );
    expect(
      collectUnsafeConcurrentTimeouts(
        "safe/migration.sql",
        `SET SESSION statement_timeout TO 0;
        CREATE INDEX CONCURRENTLY example_idx ON example (id);
        SET statement_timeout = '5s';`,
      ),
    ).toEqual([]);
    expect(
      collectUnsafeConcurrentTimeouts(
        "safe-set-config/migration.sql",
        `SELECT pg_catalog.set_config('statement_timeout', '0', false);
        CREATE INDEX CONCURRENTLY example_idx ON example (id);
        SELECT set_config('statement_timeout', '5s', false);`,
      ),
    ).toEqual([]);
    expect(
      collectUnsafeConcurrentTimeouts(
        "from-current/migration.sql",
        `SET statement_timeout = 0;
        CREATE INDEX CONCURRENTLY example_idx ON example (id);
        SET statement_timeout FROM CURRENT;`,
      ),
    ).toContain(
      "from-current/migration.sql: timeouts are not restored immediately after concurrent index operations",
    );
    expect(
      collectUnsafeConcurrentTimeouts(
        "reset-restore/migration.sql",
        `SET statement_timeout = 0;
        CREATE INDEX CONCURRENTLY example_idx ON example (id);
        RESET statement_timeout;`,
      ),
    ).toContain(
      "reset-restore/migration.sql: timeouts are not restored immediately after concurrent index operations",
    );
    expect(
      collectUnsafeConcurrentTimeouts(
        "discard-all/migration.sql",
        `SET statement_timeout = 0;
        DISCARD ALL;
        CREATE INDEX CONCURRENTLY example_idx ON example (id);`,
      ),
    ).toContain(
      "discard-all/migration.sql: concurrent index operation has a timeout",
    );
    expect(
      collectUnsafeConcurrentTimeouts(
        "unbounded-lock/migration.sql",
        `SET statement_timeout = 0;
        SET lock_timeout = 0;
        CREATE INDEX CONCURRENTLY example_idx ON example (id);
        SET statement_timeout = '5s';`,
      ),
    ).toContain("unbounded-lock/migration.sql: lock timeout is not restored");
    for (const reset of ["RESET lock_timeout", "DISCARD ALL"]) {
      expect(
        collectUnsafeConcurrentTimeouts(
          "reset-lock/migration.sql",
          `SET statement_timeout = 0;
          SET lock_timeout = '1s';
          CREATE INDEX CONCURRENTLY example_idx ON example (id);
          ${reset};
          SET statement_timeout = '5s';`,
        ),
      ).toContain("reset-lock/migration.sql: lock timeout is not restored");
    }
    expect(
      collectUnsafeConcurrentTimeouts(
        "restored-lock/migration.sql",
        `SET statement_timeout = 0;
        SET lock_timeout = 0;
        CREATE INDEX CONCURRENTLY example_idx ON example (id);
        SET statement_timeout = '5s';
        SET lock_timeout = '1s';`,
      ),
    ).toEqual([]);
  });

  test("restores the exact incoming timeout state after concurrent work", () => {
    const checkpoint = `SELECT set_config(
      'stella.migration_statement_timeout',
      current_setting('statement_timeout'),
      false
    )`;
    const restore = `SELECT set_config(
      'statement_timeout',
      current_setting('stella.migration_statement_timeout'),
      false
    )`;

    expect(parseTimeoutUpdate(checkpoint)).toEqual({
      name: "statement",
      type: "checkpoint",
    });
    expect(parseTimeoutUpdate(restore)).toEqual({
      name: "statement",
      type: "restore",
    });
    expect(
      collectUnsafeConcurrentTimeouts(
        "preserved/migration.sql",
        `${checkpoint};
        SET statement_timeout = 0;
        CREATE INDEX CONCURRENTLY example_idx ON example (id);
        ${restore};`,
      ),
    ).toEqual([]);
    expect(
      collectUnsafeConcurrentTimeouts(
        "missing-checkpoint/migration.sql",
        `SET statement_timeout = 0;
        CREATE INDEX CONCURRENTLY example_idx ON example (id);
        ${restore};`,
      ),
    ).toContain(
      "missing-checkpoint/migration.sql: statement timeout restore lacks a checkpoint",
    );
  });

  test("rejects transaction reversal in timeout protocols", () => {
    expect(
      collectUnsafeConcurrentTimeouts(
        "rollback/migration.sql",
        `BEGIN;
        SET statement_timeout = 0;
        ROLLBACK;
        CREATE INDEX CONCURRENTLY example_idx ON example (id);`,
      ),
    ).toContain(
      "rollback/migration.sql: timeout safety does not support transaction reversal",
    );
    expect(
      collectUnsafeConcurrentTimeouts(
        "savepoint/migration.sql",
        `SAVEPOINT before_timeout;
        SET statement_timeout = 0;
        CREATE INDEX CONCURRENTLY example_idx ON example (id);`,
      ),
    ).toContain(
      "savepoint/migration.sql: timeout safety does not support transaction reversal",
    );
    expect(
      collectUnsafeTypeChangesInMigration(
        "type-rollback/migration.sql",
        `BEGIN;
        SET lock_timeout = '1s';
        ROLLBACK;
        -- ${TYPE_CHANGE_POLICY.boundedRewrite}
        SET statement_timeout = '5s';
        ALTER TABLE example ALTER COLUMN value TYPE timestamptz;`,
      ),
    ).toContain(
      "type-rollback/migration.sql: timeout safety does not support transaction reversal",
    );
    expect(
      collectUnsafeTypeChangesInMigration(
        "type-abort/migration.sql",
        `BEGIN;
        SET lock_timeout = '1s';
        ABORT;
        -- ${TYPE_CHANGE_POLICY.boundedRewrite}
        SET statement_timeout = '5s';
        ALTER TABLE example ALTER COLUMN value TYPE timestamptz;`,
      ),
    ).toContain(
      "type-abort/migration.sql: timeout safety does not support transaction reversal",
    );
  });

  test("rejects timeout mutations hidden in procedural blocks", () => {
    for (const command of [
      "PERFORM set_config('lock_timeout', '0', false);",
      `PERFORM pg_catalog."set_config"('lock_timeout', '0', false);`,
      "RESET ALL;",
      "DISCARD ALL;",
      "EXECUTE 'RESET ALL';",
      "EXECUTE 'RESET ' || 'ALL';",
      "EXECUTE format('RESET %s', 'ALL');",
    ]) {
      const mutation = `DO $$ BEGIN ${command} END $$;`;
      expect(
        collectUnsafeConcurrentTimeouts(
          "concurrent/migration.sql",
          `SET statement_timeout = 0;
          ${mutation}
          CREATE INDEX CONCURRENTLY example_idx ON example (id);
          SET statement_timeout = '5s';`,
        ),
      ).toContain(
        "concurrent/migration.sql: procedural migration statement is not approved",
      );
      expect(
        collectUnsafeTypeChangesInMigration(
          "type-change/migration.sql",
          `SET lock_timeout = '1s';
          SET statement_timeout = '5s';
          ${mutation}
          -- ${TYPE_CHANGE_POLICY.boundedRewrite}
          ALTER TABLE example ALTER COLUMN value TYPE timestamptz;`,
        ),
      ).toContain(
        "type-change/migration.sql: procedural migration statement is not approved",
      );
    }
  });

  test("keeps lock waits bounded for custom execution budgets", () => {
    const relativePath = "20260729150000_timestamptz_everywhere/migration.sql";
    for (const timeoutSetup of [
      "SET lock_timeout = 0",
      "SET lock_timeout = '1s'; RESET lock_timeout",
      "SET lock_timeout = '1s'; SET lock_timeout TO 0ms",
      "SET lock_timeout = '1s'; RESET ALL",
    ]) {
      expect(
        collectUnsafeTypeChangesInMigration(
          relativePath,
          `${timeoutSetup}; ALTER TABLE example ALTER COLUMN value TYPE timestamptz;`,
        ),
      ).toContain(`${relativePath}: type change has an unbounded lock wait`);
    }
    expect(
      collectUnsafeTypeChangesInMigration(
        relativePath,
        `SET SESSION lock_timeout TO '1s';
        ${customStatementBudget}
        ALTER TABLE example ALTER COLUMN value TYPE timestamptz;`,
      ),
    ).toEqual([]);
    expect(
      collectUnsafeTypeChangesInMigration(
        relativePath,
        `SELECT set_config('lock_timeout', '1s', false);
        ${customStatementBudget}
        SELECT set_config('lock_timeout', '0', false);
        ALTER TABLE example ALTER COLUMN value TYPE timestamptz;`,
      ),
    ).toContain(`${relativePath}: type change has an unbounded lock wait`);
  });

  test("requires and preserves the custom statement budget", () => {
    const relativePath = "20260729150000_timestamptz_everywhere/migration.sql";
    const typeChange =
      "ALTER TABLE example ALTER COLUMN value TYPE timestamptz;";
    expect(
      collectUnsafeTypeChangesInMigration(
        relativePath,
        `SET lock_timeout = '1s'; ${typeChange}`,
      ),
    ).toContain(
      `${relativePath}: custom type rewrite lacks its bounded execution budget`,
    );
    expect(
      collectUnsafeTypeChangesInMigration(
        relativePath,
        `SET lock_timeout = '1s';
        ${customStatementBudget}
        RESET statement_timeout;
        ${typeChange}`,
      ),
    ).toContain(
      `${relativePath}: custom type rewrite lacks its bounded execution budget`,
    );
    const budgetWithExtraMutation = customStatementBudget.replace(
      "END IF;",
      "END IF; PERFORM set_config('statement_timeout', '0', false);",
    );
    expect(
      collectUnsafeTypeChangesInMigration(
        relativePath,
        `SET lock_timeout = '1s';
        ${budgetWithExtraMutation}
        ${typeChange}`,
      ),
    ).toContain(
      `${relativePath}: procedural migration statement is not approved`,
    );
  });

  test("requires exact approval for procedural statements", () => {
    const relativePath = "20260729150000_timestamptz_everywhere/migration.sql";
    expect(
      collectUnsafeTypeChangesInMigration(
        relativePath,
        `SELECT 1; -- SET lock_timeout = '1s';
        /* SET lock_timeout = '1s'; */
        ALTER TABLE example ALTER COLUMN value TYPE timestamptz;`,
      ),
    ).toContain(`${relativePath}: type change has an unbounded lock wait`);
    expect(
      collectUnsafeTypeChangesInMigration(
        relativePath,
        `SET lock_timeout = '1s';
        ${customStatementBudget}
        SELECT '-- RESET lock_timeout';
        DO $body$ BEGIN PERFORM '/* RESET ALL */'; END $body$;
        /* RESET lock_timeout; */
        ALTER TABLE example ALTER COLUMN value TYPE timestamptz;`,
      ),
    ).toContain(
      `${relativePath}: procedural migration statement is not approved`,
    );
  });

  test("applies backslash escaping only to PostgreSQL escape strings", () => {
    const ordinaryStringSource = String.raw`SELECT '\';
      ALTER TABLE example ALTER COLUMN value TYPE varchar(64);`;
    expect(splitSqlStatements(ordinaryStringSource)).toHaveLength(2);
    expect(
      collectUnsafeTypeChangesInMigration(
        "ordinary-string/migration.sql",
        ordinaryStringSource,
      ),
    ).toContain(
      "ordinary-string/migration.sql: type change lacks an explicit execution policy",
    );

    expect(
      splitSqlStatements(String.raw`SELECT E'it\'s; still quoted'; SELECT 1;`),
    ).toHaveLength(2);
  });

  test("requires token boundaries for dollar-quoted bodies", () => {
    for (const identifier of ["foo$bar$", "café$tag$"]) {
      const identifierSource = `SELECT ${identifier};
        ALTER TABLE example ALTER COLUMN value TYPE varchar(64);`;
      expect(splitSqlStatements(identifierSource)).toHaveLength(2);
      expect(
        collectUnsafeTypeChangesInMigration(
          "dollar-identifier/migration.sql",
          identifierSource,
        ),
      ).toContain(
        "dollar-identifier/migration.sql: type change lacks an explicit execution policy",
      );
    }

    expect(
      splitSqlStatements("DO $täg$ SELECT ';'; $täg$; SELECT 1;"),
    ).toHaveLength(2);
  });

  test("rejects type changes hidden inside procedural bodies", () => {
    expect(
      collectUnsafeTypeChangesInMigration(
        "procedural/migration.sql",
        `DO $$
        BEGIN
          ALTER TABLE example ALTER COLUMN value TYPE varchar(64);
        END
        $$;`,
      ),
    ).toContain(
      "procedural/migration.sql: procedural migration statement is not approved",
    );
  });

  test("requires one execution policy per type-change statement", () => {
    expect(
      collectUnsafeTypeChangesInMigration(
        "combined/migration.sql",
        `SET lock_timeout = '1s';
        -- ${TYPE_CHANGE_POLICY.metadataOnly}
        SET statement_timeout = 0;
        ALTER TABLE example
          ALTER COLUMN metadata_value TYPE varchar(64),
          ALTER COLUMN rewritten_value TYPE timestamptz;`,
      ),
    ).toContain(
      "combined/migration.sql: multiple type changes in one statement are not supported by the metadata-only timeout policy",
    );
  });

  test("bounds lock waits without interrupting acquired type changes", async () => {
    expect(await collectUnsafeTypeChanges()).toEqual([]);
  });
});
