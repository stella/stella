import { expect, test } from "bun:test";

import MCP_APP_MESSAGES from "@stll/api-contract/mcp-app-messages";

import { appFailure, formatAppFailure } from "./app-error";
import { appLocale } from "./locale";

test("failures show localized known field labels and receipts without wire paths or codes", () => {
  for (const locale of Object.keys(MCP_APP_MESSAGES)) {
    const { t } = appLocale(locale);
    const message = formatAppFailure(
      {
        ...appFailure("invalid_arguments", "receipt-456"),
        fields: [
          "courts.0",
          "court",
          "category",
          "queries.0",
          "unknown_private_path",
          "courts.unknown",
        ],
        toolCode: "internal_error",
      },
      t,
    );
    expect(message).toContain(t("court"));
    expect(message).toContain(t("filterCategory"));
    expect(message).toContain("receipt-456");
    expect(message).not.toContain("queries.0");
    expect(message).not.toContain("courts.0");
    expect(message).not.toContain("unknown_private_path");
    expect(message).not.toContain("courts.unknown");
    expect(message).not.toContain("internal_error");
    expect(message).not.toContain("{fields}");
    expect(
      formatAppFailure(
        {
          ...appFailure("tool_failure", "receipt-456"),
          toolCode: "internal_error",
        },
        t,
      ),
    ).not.toContain("internal_error");
  }
});

test("shared failures describe requests across search, reader and timeline surfaces", () => {
  const { t } = appLocale("en");
  for (const type of [
    "invalid_arguments",
    "permission_denied",
    "conflict",
  ] as const) {
    expect(formatAppFailure(appFailure(type, "receipt-456"), t)).not.toContain(
      "search",
    );
    expect(formatAppFailure(appFailure(type, "receipt-456"), t)).toContain(
      "request",
    );
  }
});
