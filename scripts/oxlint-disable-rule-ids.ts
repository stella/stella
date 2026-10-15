import type { OxlintConfig } from "oxlint";

import { BASE_SCOPE, isRecord, readScopes } from "./oxlint-config-scopes.ts";
import {
  PLUGIN_ALIASES,
  builtinRules,
  ruleCanonicalizer,
} from "./oxlint-rule-ids.ts";

const configScopes = (layer: unknown): ReturnType<typeof readScopes> => {
  if (!isRecord(layer)) {
    return [];
  }
  const parents = Array.isArray(layer["extends"]) ? layer["extends"] : [];
  return [...parents.flatMap(configScopes), ...readScopes(layer)];
};

/** Config spellings win over their inherited presets and overrides. */
export const canonicalDisableRuleIds = (config: OxlintConfig) => {
  const builtins = builtinRules();
  const identity = ruleCanonicalizer(builtins);
  const scopes = new Set([
    ...builtins.map((rule) => rule.scope),
    ...Object.keys(PLUGIN_ALIASES),
  ]);
  const canonical = new Map<string, string>();
  const layers = configScopes(config);
  for (const layer of layers) {
    if (layer.scope !== BASE_SCOPE) {
      continue;
    }
    for (const key of Object.keys(layer.rules)) {
      canonical.set(identity(key), key);
    }
  }
  // Override-only rules use the last configured spelling; base rules keep theirs.
  for (const layer of layers.toReversed()) {
    for (const key of Object.keys(layer.rules)) {
      const id = identity(key);
      if (!canonical.has(id)) {
        canonical.set(id, key);
      }
    }
  }

  const aliases = new Map<string, string>();
  const names = new Map<string, string[]>();
  for (const [id, key] of canonical) {
    aliases.set(id, key);
    aliases.set(key, key);
    const separator = id.lastIndexOf("/");
    const name = id.slice(separator + 1);
    const owners = names.get(name) ?? [];
    owners.push(key);
    names.set(name, owners);
    for (const alias of scopes) {
      if (identity(`${alias}/${name}`) === id) {
        aliases.set(`${alias}/${name}`, key);
      }
    }
  }
  for (const [name, owners] of names) {
    const soleOwner = owners.at(0);
    if (!aliases.has(name) && owners.length === 1 && soleOwner !== undefined) {
      aliases.set(name, soleOwner);
    }
  }
  return Object.fromEntries(aliases);
};

export const withCanonicalDisableRuleIds = <T extends OxlintConfig>(
  config: T,
) => ({
  ...config,
  settings: {
    ...config.settings,
    "stella/canonical-disable-rule-ids": canonicalDisableRuleIds(config),
  },
});
