// Shared with workflow guards that run before dependency installation.
type RootCheckGateOptions = { job: string; name: string };
export const rootCheckGate = ({ job, name }: RootCheckGateOptions) =>
  `(needs.ci-plan.outputs.root_checks == '' || contains(fromJSON(needs.ci-plan.outputs.root_checks || '[]'), '${job}/${name}'))`;
