import { createCheckResult } from "../utils/checkResult.js";
import { normalizeWhitespace } from "../utils/text.js";
import type { AuditContext } from "../types.js";

const imageOnlyNote =
	"It is image-only: its text comes from the image's alt attribute, which Google reads as the heading text. That is valid, but a text H1 is more robust for other crawlers and screen readers.";

export function checkH1(context: AuditContext) {
	// h1Texts already reads <img alt> as heading text and drops H1s with no text at all.
	const h1Values = context.h1Texts ?? [];
	const h1Elements = context.$ ? context.$("h1").toArray() : [];
	const imageOnlyCount = context.$
		? h1Elements.filter((el) => !normalizeWhitespace(context.$!(el).text()) && context.$!(el).find("img[alt]").length > 0).length
		: 0;

	if (h1Values.length === 0) {
		const emptyCount = h1Elements.length;
		return createCheckResult({
			id: "h1",
			label: "H1 Header Tag Usage",
			category: "Structure",
			status: "fail",
			summary: emptyCount > 0
				? `This page has ${ emptyCount } H1 ${ emptyCount === 1 ? "tag" : "tags" } but no H1 text: no text content, and no image alt text.`
				: "This page has 0 H1 tags.",
			explanation: "The H1 should describe the main topic of the page.",
			recommendation: emptyCount > 0
				? "Give the H1 text, or if it holds a logo image, add alt text naming the page or brand."
				: "Add one visible H1 that matches the page topic and search intent.",
			codeExample: "<h1>Page Main Topic</h1>",
			aiPrompt: emptyCount > 0
				? "This page has an <h1> with no readable text. Add text to the H1 that clearly describes the main topic of the page, or if the H1 contains a logo image, give that image an alt attribute naming the page or brand."
				: "This page is missing an H1 heading tag. Add one <h1> tag that clearly describes the main topic of the page. The H1 should match the page title and include relevant keywords.",
		});
	}

	if (h1Values.length > 1) {
		return createCheckResult({
			id: "h1",
			label: "H1 Header Tag Usage",
			category: "Structure",
			status: "pass",
			summary: `This page has ${ h1Values.length } H1 tags.`,
			explanation:
				"Multiple H1 tags are valid in HTML5; Google has stated publicly that pages can use any number of H1 tags."
				+ (imageOnlyCount > 0 ? ` ${ imageOnlyCount } of them ${ imageOnlyCount === 1 ? "is" : "are" } image-only, named by the image's alt text.` : ""),
			recommendation:
				"Ensure each H1 accurately describes the section it belongs to.",
			codeExample: "<article>\n  <h1>Main Topic</h1>\n</article>\n<article>\n  <h1>Another Main Topic</h1>\n</article>",
			aiPrompt: "This page has multiple H1 tags. This is valid in HTML5 and for SEO, just ensure each H1 accurately reflects its respective section's content.",
		});
	}

	return createCheckResult({
		id: "h1",
		label: "H1 Header Tag Usage",
		category: "Structure",
		status: "pass",
		summary:
			"This page has 1 H1 tag. Recommended 1 clear primary H1.",
		explanation: `Found H1: "${ h1Values[0] }"${ imageOnlyCount > 0 ? `. ${ imageOnlyNote }` : "" }`,
		recommendation:
			"Keep the H1 specific and aligned with the page title.",
	});
}
