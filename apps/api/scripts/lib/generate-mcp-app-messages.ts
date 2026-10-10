import { panic } from "better-result";
import path from "node:path";

import MCP_APP_MESSAGES from "@stll/api-contract/mcp-app-messages";

import {
  READER_MESSAGE_KEYS,
  READER_TEMPLATE_KEYS,
} from "../../src/mcp/apps/decision-reader/message-keys";

export const generateMcpAppMessages = async () => {
  const generatedRoot = path.resolve(
    import.meta.dirname,
    "../../src/mcp/apps/shared/generated",
  );
  await Bun.write(
    path.join(generatedRoot, "messages.json"),
    `${JSON.stringify(MCP_APP_MESSAGES, null, 2)}\n`,
  );
  const readerMessages = new Map<string, Map<string, string>>();
  const localeRoot = path.resolve(
    import.meta.dirname,
    "../../../web/src/i18n/langs",
  );
  for (const file of [
    ...new Bun.Glob("*.json").scanSync({ cwd: localeRoot }),
  ].toSorted()) {
    const locale = path.basename(file, ".json");
    const catalogue: unknown = await Bun.file(
      path.join(localeRoot, file),
    ).json();
    const messages = new Map<string, string>();
    for (const key of [
      ...Object.values(READER_MESSAGE_KEYS),
      ...READER_TEMPLATE_KEYS,
    ]) {
      let value = catalogue;
      for (const segment of key.split(".")) {
        if (typeof value !== "object" || value === null) {
          panic(`Reader message ${key} is missing in ${locale}`);
        }
        value = Reflect.get(value, segment);
      }
      if (typeof value !== "string") {
        panic(`Reader message ${key} is missing in ${locale}`);
      }
      messages.set(key, value);
    }
    readerMessages.set(locale, messages);
  }
  await Bun.write(
    path.join(generatedRoot, "reader-messages.json"),
    `${JSON.stringify(
      Object.fromEntries(
        [...readerMessages].map(([locale, messages]) => [
          locale,
          Object.fromEntries(messages),
        ]),
      ),
      null,
      2,
    )}\n`,
  );
};
