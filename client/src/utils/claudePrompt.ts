import type { AuditReport, SeoCategoryCheck, SeoCategoryId } from "../../../shared/types";
import { formatStatusLabel } from "./format";

// Same order the results page renders in, with social last (it has its own section there).
const promptCategoryOrder: SeoCategoryId[] = [
	"metadata",
	"structure",
	"content",
	"indexing",
	"technical",
	"pagespeed",
	"geo",
	"social",
];

// A check is a problem when it failed or warned. GEO checks can pass overall and
// still report issues, which the fix cards treat as warnings, so they count too.
function isProblemCheck(check: SeoCategoryCheck): boolean {
	return check.status === "fail" || check.status === "warning" || (check.status === "pass" && check.issues.length > 0);
}

function unique(values: string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function pushField(lines: string[], label: string, values: string[]) {
	const items = unique(values);
	if (items.length === 0) return;
	if (items.length === 1) {
		lines.push(`- **${ label }:** ${ items[0] }`);
		return;
	}
	lines.push(`- **${ label }:**`);
	for (const item of items) lines.push(`  - ${ item }`);
}

export function countPromptProblems(audit: AuditReport, excludedCheckIds: Set<string>): number {
	return promptCategoryOrder.reduce((total, categoryId) => {
		const category = audit.seoCategories.categories[categoryId];
		if (!category || category.status === "skipped") return total;
		return total + category.checks.filter((check) => isProblemCheck(check) && !excludedCheckIds.has(check.id)).length;
	}, 0);
}

export function buildClaudePrompt(audit: AuditReport, excludedCheckIds: Set<string>): string {
	const url = audit.finalUrl || audit.testedUrl || audit.input;
	const lines: string[] = [
		`# SEO fixes for ${ url }`,
		"",
	];

	if (audit.testedUrl && audit.testedUrl !== url) {
		lines.push(`Requested URL: ${ audit.testedUrl } (redirected to the URL above)`);
	}
	lines.push(
		`Audited with free-seo on ${ new Date().toISOString().slice(0, 10) }. Overall score: ${ audit.seoCategories.overallScore }/100 (${ formatStatusLabel(audit.seoCategories.overallStatus) }).`,
		"",
		"An SEO audit of the page above found the problems listed below, each with the fix it suggests. Please work through them in this site's code:",
		"",
		"1. Check each finding against the actual code before changing anything. The audit only read the live page from outside, so some findings may be wrong or may not apply (a social profile the business doesn't have, for example).",
		"2. Fix failures before warnings.",
		"3. Use the fix prompts as guidance rather than literal instructions, and keep changes in the site's existing style.",
		"4. When you're done, list what you changed, and anything you skipped with the reason.",
	);

	let number = 0;
	const excluded: string[] = [];

	for (const categoryId of promptCategoryOrder) {
		const category = audit.seoCategories.categories[categoryId];
		if (!category || category.status === "skipped") continue;

		const problems = category.checks.filter(isProblemCheck);
		excluded.push(...problems.filter((check) => excludedCheckIds.has(check.id)).map((check) => check.name));
		const included = problems.filter((check) => !excludedCheckIds.has(check.id));
		if (included.length === 0) continue;

		lines.push("", `## ${ category.label } (${ formatStatusLabel(category.status) }, ${ category.score }/100)`);

		for (const check of included) {
			number += 1;
			const status = check.status === "pass" ? "warning" : check.status;
			lines.push("", `### ${ number }. ${ check.name }: ${ status }`);
			pushField(lines, "Problem", check.issues);
			pushField(lines, "Details", [check.explanation]);
			pushField(lines, "Recommendation", check.recommendations);
			pushField(lines, "Fix prompt", check.prompts);
		}
	}

	if (number === 0) {
		lines.push("", "No problems were found, so there is nothing to fix.");
	}

	if (excluded.length > 0) {
		lines.push("", "## Left out on purpose", "", `These were also flagged but I've chosen to ignore them, so leave them alone: ${ unique(excluded).join(", ") }.`);
	}

	const notes = unique(audit.notes);
	if (notes.length > 0) {
		lines.push("", "## Caveats from the audit", "");
		for (const note of notes) lines.push(`- ${ note }`);
	}

	return `${ lines.join("\n") }\n`;
}
