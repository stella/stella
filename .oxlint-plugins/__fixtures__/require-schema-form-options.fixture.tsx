import { FormApi } from "@tanstack/form-core";
// Passive fixtures: unused suppressions fail CI if the enforcement regresses.
import {
  useForm,
  useForm as useAliasedForm,
  createFormHook,
} from "@tanstack/react-form";
import * as forms from "@tanstack/react-form";
import { schemaFormOptions as unrelatedOptions } from "unrelated-module";

import {
  schemaFormOptions,
  schemaFormOptions as configure,
} from "@/lib/form-options";
import * as formOwner from "@/lib/form-options";

declare const config: unknown;
declare const opaqueOptions: unknown;

const constructorAlias = useAliasedForm;
const namespaceAlias = forms;
const { useForm: destructuredFactory } = namespaceAlias;
const helperAlias = configure;

export const useGoodForms = () => [
  useForm(schemaFormOptions(config)),
  useAliasedForm(configure(config)),
  constructorAlias(helperAlias(config)),
  forms.useForm(formOwner.schemaFormOptions(config)),
  namespaceAlias["useForm"](schemaFormOptions(config)),
  destructuredFactory(schemaFormOptions(config)),
  new FormApi(schemaFormOptions(config)),
];

export const useBadForms = () => {
  // oxlint-disable-next-line require-schema-form-options/require-schema-form-options -- fixture: schema validation without revalidation is inert
  useForm({ validators: { onDynamic: config } });
  // oxlint-disable-next-line require-schema-form-options/require-schema-form-options -- fixture: hand-wired logic does not establish submission normalization
  useAliasedForm({
    validationLogic: forms.revalidateLogic(),
    validators: { onDynamic: config },
  });
  // oxlint-disable-next-line require-schema-form-options/require-schema-form-options -- fixture: forms without validators also require an explicit schema contract
  constructorAlias({ defaultValues: {} });
  // oxlint-disable-next-line require-schema-form-options/require-schema-form-options -- fixture: omitted options bypass the helper
  useForm();
  // oxlint-disable-next-line require-schema-form-options/require-schema-form-options -- fixture: namespace aliases cannot bypass the owner
  namespaceAlias.useForm(opaqueOptions);
  // oxlint-disable-next-line require-schema-form-options/require-schema-form-options -- fixture: namespace destructuring cannot bypass the owner
  destructuredFactory(opaqueOptions);
  // oxlint-disable-next-line require-schema-form-options/require-schema-form-options -- fixture: core constructors follow the same contract
  new FormApi({});
  // oxlint-disable-next-line require-schema-form-options/require-schema-form-options -- fixture: spreads can override helper invariants
  useForm({ ...schemaFormOptions(config), validationLogic: undefined });
  const options = schemaFormOptions(config);
  // oxlint-disable-next-line require-schema-form-options/require-schema-form-options -- fixture: stored options can be mutated before construction
  useForm(options);
  let mutableHelper = schemaFormOptions;
  mutableHelper = unrelatedOptions;
  // oxlint-disable-next-line require-schema-form-options/require-schema-form-options -- fixture: reassigned helper aliases do not establish ownership
  useForm(mutableHelper(config));
  // oxlint-disable-next-line require-schema-form-options/require-schema-form-options -- fixture: a matching helper name from another module is not the owner
  useForm(unrelatedOptions(config));
  // oxlint-disable-next-line require-schema-form-options/require-schema-form-options -- fixture: native formOptions does not supply the schema contract
  useForm(forms.formOptions(config));
  // oxlint-disable-next-line require-schema-form-options/require-schema-form-options -- fixture: custom form factories must be integrated with the central owner
  createFormHook(config);
};

export const useShadowedHelper = (
  schemaFormOptions: (value: unknown) => unknown,
) => {
  // oxlint-disable-next-line require-schema-form-options/require-schema-form-options -- fixture: a parameter shadows the real helper
  return useForm(schemaFormOptions(config));
};

// Unrelated functions and shadowed imports are outside the rule's scope.
export const useUnrelatedForm = (useForm: (value: unknown) => unknown) =>
  useForm(config);
