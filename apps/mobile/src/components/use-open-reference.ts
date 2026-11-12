import { Result } from "better-result";
import { useRouter } from "expo-router";
import { Alert } from "react-native";
import { useLocale, useTranslations } from "use-intl";

import { pickCaseLawDecisionHit } from "@stll/api-contract/case-law-decision-route";

import { useSession } from "@/connection/session-provider";
import { defaultCaseLawCountry, listDecisions } from "@/state/case-law";
import { decisionRoute, referenceTarget } from "@/state/chat-references";
import type { ChatTextReference } from "@/state/chat-references";
import { readEntityDetail } from "@/state/entity-detail";
import { entityRoute } from "@/state/search";

/**
 * Opens a reference in chat text in the app's own screens: a document to
 * its pages, a matter, a decision. An item whose label does not say what it
 * is is read first, so a document still opens to its pages and a task to
 * its details; when it cannot be read, its details sheet says so. A decision
 * named by its docket is found by a search, as the web finds it. Undefined
 * for a reference that opens nothing (a person, a skill, a source).
 */
export const useOpenReference = (
  reference: ChatTextReference,
): (() => void) | undefined => {
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations("link");
  const { end, state } = useSession();
  const target = referenceTarget(reference);
  if (target === undefined) {
    return undefined;
  }
  if (target.type === "route") {
    return () => {
      router.push(target.href);
    };
  }
  if (target.type === "find") {
    return () => {
      const serverUrl =
        state.status === "signed-in"
          ? state.source.session()?.serverUrl
          : undefined;
      if (serverUrl === undefined) {
        return;
      }
      void (async () => {
        const found = await listDecisions({
          country: defaultCaseLawCountry(locale),
          fetch,
          query: target.docket,
          serverUrl,
        });
        const hit = Result.isOk(found)
          ? pickCaseLawDecisionHit(
              target.docket,
              found.value.decisions.map((decision) => ({
                ...decision,
                ecli: null,
              })),
            )
          : null;
        if (hit === null) {
          Alert.alert(t("openFailed"));
          return;
        }
        router.push(decisionRoute(hit.id, hit.caseNumber));
      })();
    };
  }
  return () => {
    if (state.status !== "signed-in") {
      return;
    }
    const { source } = state;
    const { entityId, matterId, name } = target;
    void (async () => {
      const detail = await readEntityDetail({
        fetch,
        source,
        workspaceId: matterId,
        entityId,
      });
      if (Result.isError(detail) && detail.error._tag === "SignedOutError") {
        end(source);
        return;
      }
      router.push(
        entityRoute({
          entityId,
          entityKind: Result.isOk(detail) ? detail.value.kind : "unknown",
          matterName: null,
          name:
            Result.isOk(detail) && detail.value.name !== null
              ? detail.value.name
              : name,
          workspaceId: matterId,
        }),
      );
    })();
  };
};
