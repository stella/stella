import { Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import { usePublicSignInRequest } from "@/components/public-sign-in-request";
import { KnowledgeLandingView } from "@/features/knowledge/views/knowledge-landing-view";
import type { KnowledgeLandingCard } from "@/features/knowledge/views/knowledge-landing-view";
import { useMountEffect } from "@/hooks/use-effect";
import { knowledgeSections } from "@/lib/knowledge/navigation";
import type { KnowledgeSection } from "@/lib/knowledge/navigation";
import { normalizeRedirectTo } from "@/lib/redirect";

// Readable without an account: the catalogue behind each of these is the same
// for every visitor.
const OPEN_SECTIONS: readonly KnowledgeSection["key"][] = [
  "tools",
  "templates",
  "playbooks",
];

// An organization's own: shown so the visitor knows they exist, opened with an
// account.
const ACCOUNT_SECTIONS: readonly KnowledgeSection["key"][] = [
  "clauses",
  "styles",
];

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

  useMountEffect(() => {
    if (from !== undefined && requestSignIn !== null) {
      requestSignIn(normalizeRedirectTo(from));
    }
  });

  const cards: KnowledgeLandingCard[] = [];
  for (const section of knowledgeSections) {
    const content = {
      key: section.key,
      icon: section.icon,
      title: t(section.titleKey),
      description:
        section.key === "styles"
          ? t("styleSets.description")
          : t(`knowledge.sections.${section.key}.description`),
    };
    if (OPEN_SECTIONS.includes(section.key)) {
      cards.push({ ...content, to: section.to });
    } else if (
      ACCOUNT_SECTIONS.includes(section.key) &&
      requestSignIn !== null
    ) {
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
