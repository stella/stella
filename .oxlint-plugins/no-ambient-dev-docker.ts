import { eslintCompatPlugin } from "@oxlint/plugins";
import parseShell from "shell-quote/parse.js";

import {
  filenameForContext,
  isIdentifierReference,
  memberPropertyName,
  resolveImportedExpressionForEnforcement,
  resolveVariable,
  type ScopeContext,
  stableInitializer,
  staticStringValue,
  unwrapExpression,
} from "./utils.ts";

const DOCKER_EXECUTABLE = /(?:^|[/\\])docker(?:\.exe)?$/u;
const SHELL_CONFIGURATION = new Set([
  "cwd",
  "env",
  "quiet",
  "nothrow",
  "throws",
]);
const COMMAND_PREFIXES = new Set(["command", "exec", "env", "sudo"]);
const PREFIX_OPTIONS_WITH_VALUE = new Set([
  "-u",
  "--unset",
  "-g",
  "--group",
  "--user",
]);

type ShellTagOptions = {
  context: ScopeContext;
  value: unknown;
  seen?: Set<unknown>;
};

const isShellTag = ({
  context,
  value,
  seen = new Set<unknown>(),
}: ShellTagOptions): boolean => {
  const node = unwrapExpression(value);
  if (node === null || seen.has(node)) {
    return false;
  }
  seen.add(node);
  const imported = resolveImportedExpressionForEnforcement(context, node);
  if (imported?.source === "bun" && imported.imported === "$") {
    return true;
  }
  if (isIdentifierReference(node)) {
    const variable = resolveVariable(context, node);
    return (
      variable !== null &&
      isShellTag({ context, value: stableInitializer(variable), seen })
    );
  }
  if (node.type === "CallExpression") {
    const callee = unwrapExpression(node.callee);
    return (
      callee?.type === "MemberExpression" &&
      SHELL_CONFIGURATION.has(memberPropertyName(callee) ?? "") &&
      isShellTag({ context, value: callee.object, seen })
    );
  }
  if (node.type !== "MemberExpression" || memberPropertyName(node) !== "$") {
    return false;
  }
  const receiver = unwrapExpression(node.object);
  if (!isIdentifierReference(receiver) || receiver.name !== "Bun") {
    return false;
  }
  const variable = resolveVariable(context, receiver);
  return variable === null || variable.defs.length === 0;
};

const executesDocker = (source: string): boolean => {
  let commandPosition = true;
  let skipWord = false;
  for (const token of parseShell(
    source.replace(/\\\r?\n/gu, "").replace(/\n/gu, "\n;"),
    (name) => `$${name}`,
  )) {
    if (typeof token !== "string") {
      if ("comment" in token) {
        // shell-quote returns the remaining source as one comment token.
        const newline = token.comment.indexOf("\n");
        if (
          newline !== -1 &&
          executesDocker(token.comment.slice(newline + 1))
        ) {
          return true;
        }
      }
      if ("op" in token) {
        if (["<", ">", ">>", "<<<", ">&", "<&"].includes(token.op)) {
          skipWord = true;
        } else if (token.op !== "glob") {
          commandPosition = true;
          skipWord = false;
        }
      }
      continue;
    }
    if (skipWord) {
      skipWord = false;
      continue;
    }
    if (!commandPosition) {
      continue;
    }
    if (DOCKER_EXECUTABLE.test(token)) {
      return true;
    }
    if (
      COMMAND_PREFIXES.has(token) ||
      /^[A-Za-z_][A-Za-z0-9_]*=/u.test(token)
    ) {
      continue;
    }
    if (token.startsWith("-")) {
      skipWord = PREFIX_OPTIONS_WITH_VALUE.has(token);
      continue;
    }
    commandPosition = false;
  }
  return false;
};

export default eslintCompatPlugin({
  meta: { name: "no-ambient-dev-docker" },
  rules: {
    "no-ambient-dev-docker": {
      meta: {
        type: "problem",
        messages: {
          direct:
            "Construct development Docker commands through dev-docker so the endpoint and captured environment stay pinned together.",
        },
      },
      createOnce(context) {
        let scoped = false;
        return {
          before() {
            const filename = filenameForContext(context);
            scoped =
              filename.endsWith(
                "/.oxlint-plugins/__fixtures__/no-ambient-dev-docker.fixture.ts",
              ) ||
              (/\/packages\/scripts\/src\/(?:dev-[^/]+|agent-session)\.ts$/u.test(
                filename,
              ) &&
                !filename.endsWith(".test.ts") &&
                !filename.endsWith("/dev-docker.ts"));
          },
          TemplateLiteral(node) {
            const parent = unwrapExpression(node.parent);
            if (
              parent?.type === "TaggedTemplateExpression" &&
              isShellTag({ context, value: parent.tag })
            ) {
              return;
            }
            const value = staticStringValue(node);
            if (scoped && value !== null && DOCKER_EXECUTABLE.test(value)) {
              context.report({ node, messageId: "direct" });
            }
          },
          TaggedTemplateExpression(node) {
            if (!scoped || !isShellTag({ context, value: node.tag })) {
              return;
            }
            const command = node.quasi.quasis
              .map(({ value }) => value.cooked ?? value.raw)
              .join("__template_value__");
            if (executesDocker(command)) {
              context.report({ node, messageId: "direct" });
            }
          },
          Literal(node) {
            if (
              scoped &&
              typeof node.value === "string" &&
              DOCKER_EXECUTABLE.test(node.value)
            ) {
              context.report({ node, messageId: "direct" });
            }
          },
        };
      },
    },
  },
});
