// Regression fixture: every directive must suppress a declaration substring hit.
declare const inlineStyle: string;
declare const $node: { attr: (name: string) => string };
declare const $: (selector: string) => unknown;

// oxlint-disable-next-line no-style-substring-match/no-style-substring-match
inlineStyle.includes("font-weight:bold");
// oxlint-disable-next-line no-style-substring-match/no-style-substring-match
$node.attr("style").includes("-aw-import : ignore");
// oxlint-disable-next-line no-style-substring-match/no-style-substring-match
inlineStyle.startsWith("font-weight:bold");
// oxlint-disable-next-line no-style-substring-match/no-style-substring-match
$node.attr("style").startsWith("-aw-import : ignore");
// oxlint-disable-next-line no-style-substring-match/no-style-substring-match
inlineStyle.indexOf("font-weight:bold");
// oxlint-disable-next-line no-style-substring-match/no-style-substring-match
$node.attr("style").indexOf("-aw-import : ignore");
// oxlint-disable-next-line no-style-substring-match/no-style-substring-match
$("span[style*='font-style:italic']");
// oxlint-disable-next-line no-style-substring-match/no-style-substring-match
$("span[style^='font-style:italic']");
// oxlint-disable-next-line no-style-substring-match/no-style-substring-match
$("span[style$='font-style:italic']");
// oxlint-disable-next-line no-style-substring-match/no-style-substring-match
$("span[style~='font-style:italic']");
// oxlint-disable-next-line no-style-substring-match/no-style-substring-match
$("span[style|='font-style:italic']");
// oxlint-disable-next-line no-style-substring-match/no-style-substring-match
$("span[style='font-style:italic']");

// oxlint-disable-next-line no-style-substring-match/no-style-substring-match
inlineStyle.includes("italic");

declare const text: string;
// expect-clean: no-style-substring-match/no-style-substring-match
text.includes("font-weight:bold");
