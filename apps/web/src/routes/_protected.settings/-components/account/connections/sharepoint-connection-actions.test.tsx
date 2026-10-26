import { renderToStaticMarkup } from "react-dom/server";

import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { IntlProvider } from "use-intl";
import * as v from "valibot";

import { SharepointConnectionActions } from "./sharepoint-connection-actions";

const locales = new URL("../../../../../i18n/langs/", import.meta.url);

test("provider revocation guidance remains visible after disconnect and organization disable in every locale", () => {
  for (const file of readdirSync(locales).filter((candidate) =>
    candidate.endsWith(".json"),
  )) {
    const messages = JSON.parse(readFileSync(new URL(file, locales), "utf-8"));
    const hint = v.parse(
      v.object({
        settings: v.object({
          connections: v.object({ microsoft365RevokeHint: v.string() }),
        }),
      }),
      messages,
    ).settings.connections.microsoft365RevokeHint;
    expect(typeof hint).toBe("string");
    expect(hint.length).toBeGreaterThan(20);
    for (const state of [
      { connected: true, enabled: true },
      { connected: false, enabled: true },
      { connected: false, enabled: false },
    ]) {
      const markup = renderToStaticMarkup(
        <IntlProvider
          locale={file.replace(".json", "")}
          messages={messages}
          timeZone="UTC"
        >
          <SharepointConnectionActions
            {...state}
            canManage={true}
            pending={false}
            onDisconnect={() => {}}
            onDisable={() => {}}
          />
        </IntlProvider>,
      );
      expect(markup).toContain("Microsoft");
      expect(markup).toContain(hint.replaceAll("&", "&amp;"));
    }
  }
});
