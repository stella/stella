import { DictationVocabularyCard } from "@/routes/_protected.settings/organization/-components/organization/dictation-vocabulary-card";

import { DictationPageShell } from "./-organization.dictation.pending";

export const OrganizationDictationPage = () => (
  <DictationPageShell>
    <DictationVocabularyCard />
  </DictationPageShell>
);
