import { useMemo } from "react";

import { calcPrice } from "@pydantic/genai-prices";
import type { ModelPrice, TieredPrices } from "@pydantic/genai-prices";
import { useTranslations } from "use-intl";

import {
  encodeModelSelection,
  MODEL_OPTIONS_BY_PROVIDER,
  ROLE_KEYS,
} from "@/components/ai-config-role-models.logic";
import type {
  ProviderValue,
  RoleModelSelections,
  RoleValue,
} from "@/components/ai-config-role-models.logic";
import { getProviderIcon } from "@/components/ai-provider-icons";

// "Typical call" = one chat turn through an agent loop with tool
// calls: large system prompt + tool schemas + a few intermediate
// tool responses + a moderate final answer.
const TYPICAL_INPUT_TOKENS = 20_000;
const TYPICAL_OUTPUT_TOKENS = 2000;

// OpenRouter typically charges the underlying provider's price plus a
// 5.5% routing fee (BYOK pass-through). We don't have an OpenRouter
// entry in genai-prices for most models, so we look up the bare
// model id (`provider/model` → `model`) and apply this multiplier.
const OPENROUTER_MARKUP = 1.055;

const formatPerMTok = (
  raw: number | TieredPrices | undefined,
  markup: number,
): string => {
  if (raw === undefined) {
    return "—";
  }
  if (typeof raw === "number") {
    return formatUsd(raw * markup);
  }
  // Tiered: show base price; range is rare and noisy in a compact panel.
  return formatUsd(raw.base * markup);
};

const formatUsd = (value: number): string => {
  if (value === 0) {
    return "$0";
  }
  if (value < 0.01) {
    return `$${value.toPrecision(2)}`;
  }
  if (value < 1) {
    return `$${value.toFixed(3)}`;
  }
  if (value < 100) {
    return `$${value.toFixed(2)}`;
  }
  return `$${value.toFixed(0)}`;
};

type ModelRow = {
  modelId: string;
  inputPerM: string;
  outputPerM: string;
  perCall: string;
  hasPrice: boolean;
};

type LookupResult = {
  calc: NonNullable<ReturnType<typeof calcPrice>>;
  markup: number;
};

const lookupPrice = (modelId: string): LookupResult | null => {
  const usage = {
    input_tokens: TYPICAL_INPUT_TOKENS,
    output_tokens: TYPICAL_OUTPUT_TOKENS,
  };
  const direct = calcPrice(usage, modelId);
  if (direct) {
    return { calc: direct, markup: 1 };
  }
  // OpenRouter catalog IDs are "<provider>/<model>"; the genai-prices
  // DB only knows them under the bare model name plus the original
  // provider's price. Fall back to the suffix and add OpenRouter's
  // BYOK markup so the user sees an accurate effective price.
  const slashIndex = modelId.indexOf("/");
  if (slashIndex !== -1) {
    const fallback = calcPrice(usage, modelId.slice(slashIndex + 1));
    if (fallback) {
      return { calc: fallback, markup: OPENROUTER_MARKUP };
    }
  }
  return null;
};

const buildRow = (modelId: string): ModelRow => {
  const result = lookupPrice(modelId);
  if (!result) {
    return {
      modelId,
      inputPerM: "—",
      outputPerM: "—",
      perCall: "—",
      hasPrice: false,
    };
  }
  const { calc, markup } = result;
  const price: ModelPrice = calc.model_price;
  return {
    modelId,
    inputPerM: formatPerMTok(price.input_mtok, markup),
    outputPerM: formatPerMTok(price.output_mtok, markup),
    perCall: formatUsd(calc.total_price * markup),
    hasPrice: true,
  };
};

type PricesPanelProps = {
  providers: readonly ProviderValue[];
  roleModels: RoleModelSelections;
};

export const PricesPanel = ({ providers, roleModels }: PricesPanelProps) => {
  const tOrganization = useTranslations("organization");
  const t = useTranslations();

  const groups = useMemo(
    () =>
      providers.map((provider) => ({
        provider,
        rows: MODEL_OPTIONS_BY_PROVIDER[provider].map((modelId) =>
          buildRow(modelId),
        ),
      })),
    [providers],
  );

  const selectedKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const selection of Object.values(roleModels)) {
      if (selection) {
        keys.add(encodeModelSelection(selection));
      }
    }
    return keys;
  }, [roleModels]);

  const selectedRows = useMemo(
    () =>
      ROLE_KEYS.flatMap((role: RoleValue) => {
        const selection = roleModels[role];
        if (!selection) {
          return [];
        }
        return [
          {
            role,
            provider: selection.provider,
            ...buildRow(selection.modelId),
          },
        ];
      }),
    [roleModels],
  );

  if (providers.length === 0) {
    return (
      <div className="flex w-full max-w-[420px] flex-col items-center gap-2 px-6 text-center">
        <p className="text-foreground text-sm font-medium">
          {tOrganization("aiConfig.prices.empty")}
        </p>
        <p className="text-muted-foreground text-xs">
          {tOrganization("aiConfig.prices.emptyHint")}
        </p>
      </div>
    );
  }

  return (
    <div className="bg-background w-[460px] max-w-full overflow-hidden rounded-xl shadow-lg">
      <div className="border-b px-5 py-4">
        <p className="text-foreground text-sm font-semibold tracking-wide uppercase">
          {tOrganization("aiConfig.prices.title")}
        </p>
        <p className="text-muted-foreground mt-1 text-xs">
          {tOrganization("aiConfig.prices.typicalCallHint", {
            input: TYPICAL_INPUT_TOKENS.toLocaleString(),
            output: TYPICAL_OUTPUT_TOKENS.toLocaleString(),
          })}
        </p>
      </div>

      <div className="text-muted-foreground grid grid-cols-[1fr_4rem_4rem_4rem] gap-x-2 px-5 py-2 text-xs font-medium tracking-wide uppercase">
        <span>{tOrganization("aiConfig.prices.model")}</span>
        <span className="text-end">
          {tOrganization("aiConfig.prices.inMtok")}
        </span>
        <span className="text-end">
          {tOrganization("aiConfig.prices.outMtok")}
        </span>
        <span className="text-end">
          {tOrganization("aiConfig.prices.perCall")}
        </span>
      </div>

      <div className="max-h-[460px] overflow-y-auto">
        {selectedRows.length > 0 && (
          <div className="border-t">
            <div className="bg-primary/5 flex items-center gap-2 px-5 py-2">
              <span className="text-foreground text-sm font-medium">
                {tOrganization("aiConfig.prices.selectedHeading")}
              </span>
            </div>
            {selectedRows.map((row) => {
              const RoleProviderIcon = getProviderIcon(row.provider);
              return (
                <div
                  key={row.role}
                  className="grid grid-cols-[1fr_4rem_4rem_4rem] gap-x-2 px-5 py-1.5 text-sm"
                >
                  <span
                    className="text-foreground flex min-w-0 items-center gap-2 truncate"
                    title={row.modelId}
                  >
                    <RoleProviderIcon className="text-foreground size-3.5 shrink-0" />
                    <span className="text-muted-foreground text-xs uppercase">
                      {tOrganization(`aiConfig.roles.${row.role}`)
                        .split(" ")
                        .at(0)}
                    </span>
                    <span className="font-mono text-xs">{row.modelId}</span>
                  </span>
                  <span className="text-muted-foreground text-end">
                    {row.inputPerM}
                  </span>
                  <span className="text-muted-foreground text-end">
                    {row.outputPerM}
                  </span>
                  <span
                    className={`text-end ${
                      row.hasPrice
                        ? "text-foreground font-medium"
                        : "text-muted-foreground"
                    }`}
                  >
                    {row.perCall}
                  </span>
                </div>
              );
            })}
          </div>
        )}
        {groups.map(({ provider, rows }) => {
          const ProviderIcon = getProviderIcon(provider);
          return (
            <div key={provider} className="border-t">
              <div className="bg-muted/30 flex items-center gap-2 px-5 py-2">
                <ProviderIcon className="text-foreground size-4 shrink-0" />
                <span className="text-foreground text-sm font-medium">
                  {tOrganization(`aiConfig.providers.${provider}`)}
                </span>
              </div>
              {rows.map((row) => {
                const selectionKey = encodeModelSelection({
                  provider,
                  modelId: row.modelId,
                });
                const isSelected = selectedKeys.has(selectionKey);
                return (
                  <div
                    key={row.modelId}
                    className={`grid grid-cols-[1fr_4rem_4rem_4rem] gap-x-2 px-5 py-1.5 text-sm ${
                      isSelected ? "bg-primary/5" : ""
                    }`}
                  >
                    <span
                      className={`min-w-0 truncate font-mono text-xs ${
                        isSelected
                          ? "text-foreground font-medium"
                          : "text-foreground"
                      }`}
                      title={row.modelId}
                    >
                      {row.modelId}
                    </span>
                    <span className="text-muted-foreground text-end">
                      {row.inputPerM}
                    </span>
                    <span className="text-muted-foreground text-end">
                      {row.outputPerM}
                    </span>
                    <span
                      className={`text-end ${
                        row.hasPrice
                          ? "text-foreground font-medium"
                          : "text-muted-foreground"
                      }`}
                    >
                      {row.perCall}
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      <div className="border-t px-5 py-2.5">
        <p className="text-foreground-strong-muted text-xs">
          <a
            className="hover:text-foreground underline underline-offset-2"
            href="https://github.com/pydantic/genai-prices"
            rel="noreferrer"
            target="_blank"
          >
            @pydantic/genai-prices
          </a>{" "}
          · {t("organization.aiConfig.prices.source")}
        </p>
      </div>
    </div>
  );
};
