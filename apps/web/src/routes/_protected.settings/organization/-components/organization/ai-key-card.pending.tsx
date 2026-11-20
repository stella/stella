import type { ReactNode } from "react";

import { ButtonFace, InputFace, LabelFace } from "@stll/ui/control-face";
import { EyeIcon } from "@stll/ui/icons";
import { SettingsPanel, SettingsSection } from "@stll/ui/settings";

import { PendingText } from "@/components/pending-text";
import type { PendingTextKey } from "@/components/pending-text";

/*
 * The AI page's API key sections (DeepL, web search and fetch), each beside
 * its pending phase: the section's heading and quiet line, and the key
 * field's surface (caption over a secret field). The live sections put their
 * `Label` and `SecretInput` in the field's card and show the stored key's
 * mask above it once read; the pending phase the faces, empty.
 */

/** A key section's heading and its one quiet line, in both phases. */
export const AIKeySectionHeading = ({
  description,
  title,
}: {
  title: PendingTextKey;
  description: PendingTextKey;
}) => (
  <div>
    <h3 className="text-base font-medium">
      <PendingText barClassName="w-28" id={title} />
    </h3>
    <p className="text-muted-foreground text-sm">
      <PendingText barClassName="w-80 max-w-full" id={description} />
    </p>
  </div>
);

/** A key field's surface: its caption over the secret field. */
export const AIKeyFieldFrame = ({
  input,
  label,
}: {
  /** The caption (a `Label` bound to the field), or its face. */
  label: ReactNode;
  /** The secret field, or its face. */
  input: ReactNode;
}) => (
  <SettingsSection>
    <SettingsPanel>
      <div className="flex flex-col gap-3">
        {label}
        {input}
      </div>
    </SettingsPanel>
  </SettingsSection>
);

/** A key field's surface while the stored key is read: caption, empty field. */
const AIKeyFieldPending = ({
  label,
  placeholder,
}: {
  label: PendingTextKey;
  placeholder: PendingTextKey;
}) => (
  <AIKeyFieldFrame
    input={
      // `SecretInput`'s box: the field with the reveal toggle at its end.
      <span className="relative inline-flex w-full">
        <InputFace>
          <PendingText barClassName="w-32" id={placeholder} />
        </InputFace>
        <ButtonFace
          className="absolute end-1 top-1/2 z-1 -translate-y-1/2"
          size="icon-xs"
          variant="ghost"
        >
          <EyeIcon />
        </ButtonFace>
      </span>
    }
    label={
      <LabelFace>
        <PendingText barClassName="w-20" id={label} />
      </LabelFace>
    }
  />
);

/** A key section's copy: its heading, its line, its field's caption and
 *  placeholder. */
type AIKeySectionCopy = {
  title: PendingTextKey;
  description: PendingTextKey;
  label: PendingTextKey;
  placeholder: PendingTextKey;
};

/** DeepL's key section copy. */
export const DEEPL_KEY_SECTION = {
  title: "translate.settings.title",
  description: "translate.settings.description",
  label: "translate.settings.apiKeyLabel",
  placeholder: "translate.settings.apiKeyPlaceholder",
} as const satisfies AIKeySectionCopy;

/** The DeepL key section while its stored key is read. */
export const DeepLKeyCardPending = () => (
  <div className="flex flex-col gap-4">
    <AIKeySectionHeading
      description={DEEPL_KEY_SECTION.description}
      title={DEEPL_KEY_SECTION.title}
    />
    <AIKeyFieldPending
      label={DEEPL_KEY_SECTION.label}
      placeholder={DEEPL_KEY_SECTION.placeholder}
    />
  </div>
);

/** The web search keys section's copy. */
export const WEB_SEARCH_KEYS_SECTION = {
  title: "webSearch.settings.title",
  description: "webSearch.settings.description",
  label: "organization.aiConfig.apiKey",
  placeholder: "organization.aiConfig.apiKeyPlaceholder",
} as const satisfies AIKeySectionCopy;

/** The web search section's key fields, in order, by kind. */
export const WEB_SEARCH_KEY_FIELDS = [
  { kind: "search", title: "webSearch.settings.searchTitle" },
  { kind: "fetch", title: "webSearch.settings.fetchTitle" },
] as const satisfies readonly { kind: string; title: PendingTextKey }[];

/** A web search key field's title, in both phases. */
export const WebSearchKeyFieldTitle = ({
  title,
}: {
  title: PendingTextKey;
}) => (
  <h4 className="text-sm font-medium">
    <PendingText barClassName="w-24" id={title} />
  </h4>
);

/** The web search and fetch keys while their stored keys are read. */
export const WebSearchKeysCardPending = () => (
  <div className="flex flex-col gap-6">
    <AIKeySectionHeading
      description={WEB_SEARCH_KEYS_SECTION.description}
      title={WEB_SEARCH_KEYS_SECTION.title}
    />
    {WEB_SEARCH_KEY_FIELDS.map((field) => (
      <div className="flex flex-col gap-3" key={field.kind}>
        <WebSearchKeyFieldTitle title={field.title} />
        <AIKeyFieldPending
          label={WEB_SEARCH_KEYS_SECTION.label}
          placeholder={WEB_SEARCH_KEYS_SECTION.placeholder}
        />
      </div>
    ))}
  </div>
);
