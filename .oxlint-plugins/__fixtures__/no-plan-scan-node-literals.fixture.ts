// oxlint-disable-next-line no-plan-scan-node-literals/no-plan-scan-node-literals -- fixture: plan tests must use the normalized access-path helper
expect(node.type).toBe("Index Scan");

// expect-clean: no-plan-scan-node-literals/no-plan-scan-node-literals
const _unrelated = "Seq Scan";
