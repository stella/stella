import { Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import { usePublicSignInRequest } from "@/components/public-sign-in-request";
import { publicKnowledgeSource } from "@/features/knowledge/public/public-knowledge";
import { KnowledgeLandingView } from "@/features/knowledge/views/knowledge-landing-view";
import type { KnowledgeLandingCard } from "@/features/knowledge/views/knowledge-landing-view";
import { useMountEffect } from "@/hooks/use-effect";
import { knowledgeSections } from "@/lib/knowledge/navigation";
import { normalizeRedirectTo } from "@/lib/redirect";

type PublicKnowledgeLandingProps = {
  /** A page that needs an account, asked for before this one: sign-in is
   *  offered straight away and returns there. */
  from: string | undefined;
};

/**
 * The Knowledge landing for a visitor without an account: the open catalogues
 * as links, the organization-only sections as cards that ask for an account,
 * and one line saying what an account adds.
 */
export const PublicKnowledgeLanding = ({
  from,
}: PublicKnowledgeLandingProps) => {
  const t = useTranslations();
  const requestSignIn = usePublicSignInRequest();
  const { available: templatesAvailable } =
    publicKnowledgeSource.useCatalogueTemplatesAvailable();

  useMountEffect(() => {
    if (from !== undefined && requestSignIn !== null) {
      requestSignIn(normalizeRedirectTo(from));
    }
  });

  const cards: KnowledgeLandingCard[] = [];
  for (const section of knowledgeSections) {
    if (section.key === "templates" && !templatesAvailable) {
      continue;
    }
    const content = {
      key: section.key,
      icon: section.icon,
      title: t(section.titleKey),
      description:
        section.key === "styles"
          ? t("styleSets.description")
          : t(`knowledge.sections.${section.key}.description`),
    };
    if (section.publicAccess === "catalogue") {
      cards.push({ ...content, to: section.to });
    } else if (section.publicAccess === "account" && requestSignIn !== null) {
      cards.push({
        ...content,
        note: t("knowledge.landing.withAccount"),
        onOpen: () => requestSignIn(section.to),
      });
    }
  }

  return (
    <KnowledgeLandingView
      cards={cards}
      footer={
        <div className="text-muted-foreground mt-6 flex flex-wrap items-center gap-3 text-sm">
          <p>{t("knowledge.landing.accountLine")}</p>
          {requestSignIn === null ? (
            <Button
              render={<Link search={{ redirectTo: "/knowledge" }} to="/auth" />}
              size="sm"
              variant="outline"
            >
              {t("auth.createFreeAccount")}
            </Button>
          ) : (
            <Button
              onClick={() => requestSignIn("/knowledge")}
              size="sm"
              variant="outline"
            >
              {t("auth.createFreeAccount")}
            </Button>
          )}
        </div>
      }
    />
  );
};
