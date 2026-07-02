import type { ReactNode } from "react";

import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { CATALOGUE_LICENSES } from "@stll/catalogue";
import { Button } from "@stll/ui/components/button";

import { pageTitle } from "@/lib/page-title";
import { createPublicToolsHead } from "@/lib/public-tools-seo";
import {
  CATALOGUE_CONTRIBUTING_URL,
  CATALOGUE_ENTRIES_URL,
} from "@/routes/tools/-components/tool-detail.logic";

export const Route = createFileRoute("/tools/contribute")({
  head: () =>
    createPublicToolsHead({
      description: "",
      path: "/tools/contribute",
      title: pageTitle("publicTools.contribute.title"),
      type: "article",
    }),
  component: ContributePage,
});

function ContributePage() {
  const t = useTranslations();

  return (
    <main className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-6">
        <div className="flex flex-col gap-2">
          <h1 className="text-lg font-semibold">
            {t("publicTools.contribute.title")}
          </h1>
          <p className="text-muted-foreground text-sm">
            {t("publicTools.contribute.intro")}
          </p>
        </div>

        <Section title={t("publicTools.contribute.skillsTitle")}>
          <p>
            <strong className="text-foreground font-medium">
              {t("publicTools.contribute.inTreeTitle")}
            </strong>{" "}
            {t("publicTools.contribute.inTreeBody")}
          </p>
          <p>
            <strong className="text-foreground font-medium">
              {t("publicTools.contribute.githubTitle")}
            </strong>{" "}
            {t("publicTools.contribute.githubBody")}
          </p>
        </Section>

        <Section title={t("publicTools.contribute.mcpTitle")}>
          <p>{t("publicTools.contribute.mcpBody")}</p>
        </Section>

        <Section title={t("publicTools.contribute.licenseTitle")}>
          <p>{t("publicTools.contribute.licenseBody")}</p>
          <ul className="flex flex-wrap gap-1.5">
            {CATALOGUE_LICENSES.map((license) => (
              <li
                className="bg-muted text-muted-foreground inline-flex items-center rounded-md px-1.5 py-0.5 font-mono text-xs"
                key={license}
              >
                {license}
              </li>
            ))}
          </ul>
        </Section>

        <Section title={t("publicTools.contribute.recommendedTitle")}>
          <p>{t("publicTools.contribute.recommendedBody")}</p>
        </Section>

        <div className="flex flex-wrap gap-3 pt-2">
          <Button asChild>
            <a
              href={CATALOGUE_CONTRIBUTING_URL}
              rel="noreferrer"
              target="_blank"
            >
              {t("publicTools.contribute.contributingLink")}
            </a>
          </Button>
          <Button asChild variant="outline">
            <a href={CATALOGUE_ENTRIES_URL} rel="noreferrer" target="_blank">
              {t("publicTools.contribute.repoLink")}
            </a>
          </Button>
        </div>
      </div>
    </main>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-base font-semibold">{title}</h2>
      <div className="text-muted-foreground flex flex-col gap-2 text-sm leading-relaxed">
        {children}
      </div>
    </section>
  );
}
