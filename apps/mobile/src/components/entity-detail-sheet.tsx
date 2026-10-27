import { Suspense, use, useState } from "react";

import { Result } from "better-result";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useFormatter, useTranslations } from "use-intl";

import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import type { ApiError } from "@/state/api-request";
import { readEntityDetail } from "@/state/entity-detail";
import type { EntityDetail } from "@/state/entity-detail";
import { isKnownEntityKind } from "@/state/matter-entities";
import { useAppColors } from "@/theme";

/** One item's essentials, read once when the sheet opens. */
export const EntityDetailSheet = ({
  entityId,
  source,
  workspaceId,
}: {
  entityId: string;
  source: AccessTokenSource;
  workspaceId: string;
}) => {
  const colors = useAppColors();
  const { end } = useSession();
  const [load] = useState(async () => {
    const result = await readEntityDetail({
      fetch,
      source,
      workspaceId,
      entityId,
    });
    if (Result.isError(result) && result.error._tag === "SignedOutError") {
      end();
    }
    return result;
  });

  return (
    <View style={[styles.sheet, { backgroundColor: colors.card }]}>
      <Suspense
        fallback={
          <ActivityIndicator color={colors.accent} style={styles.loading} />
        }
      >
        <LoadedEntity load={load} />
      </Suspense>
    </View>
  );
};

const LoadedEntity = ({
  load,
}: {
  load: Promise<Result<EntityDetail, ApiError>>;
}) => {
  const t = useTranslations("entity");
  const matter = useTranslations("matter");
  const format = useFormatter();
  const colors = useAppColors();
  const result = use(load);

  if (Result.isError(result)) {
    return result.error._tag === "SignedOutError" ? null : (
      <Text style={[styles.failed, { color: colors.muted }]}>
        {t("loadFailed")}
      </Text>
    );
  }

  const entity = result.value;
  const { kind } = entity;
  const facts = [
    isKnownEntityKind(kind)
      ? { label: t("type"), value: matter(`kind.${kind}`) }
      : undefined,
    entity.currentVersionReference === null ||
    entity.currentVersionReference === undefined
      ? undefined
      : { label: t("reference"), value: entity.currentVersionReference },
    entity.currentVersionCreatedAt === null ||
    entity.currentVersionCreatedAt === undefined
      ? undefined
      : {
          label: t("currentVersion"),
          value: format.dateTime(new Date(entity.currentVersionCreatedAt), {
            dateStyle: "medium",
            timeStyle: "short",
          }),
        },
  ].filter((fact) => fact !== undefined);

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text
        accessibilityRole="header"
        style={[styles.title, { color: colors.text }]}
      >
        {entity.name === null || entity.name === ""
          ? matter("untitled")
          : entity.name}
      </Text>
      <View style={[styles.facts, { borderColor: colors.border }]}>
        {facts.map((fact) => (
          <View
            key={fact.label}
            style={[styles.fact, { borderColor: colors.border }]}
          >
            <Text style={[styles.factLabel, { color: colors.muted }]}>
              {fact.label}
            </Text>
            <Text
              numberOfLines={2}
              style={[styles.factValue, { color: colors.text }]}
            >
              {fact.value}
            </Text>
          </View>
        ))}
      </View>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  content: {
    gap: 20,
    padding: 24,
  },
  fact: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between",
    paddingVertical: 12,
  },
  factLabel: {
    fontSize: 15,
  },
  factValue: {
    flexShrink: 1,
    fontSize: 15,
    fontWeight: "500",
    textAlign: "right",
  },
  facts: {
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  failed: {
    fontSize: 15,
    padding: 24,
  },
  loading: {
    padding: 32,
  },
  sheet: {
    flex: 1,
  },
  title: {
    fontSize: 22,
    fontWeight: "700",
  },
});
