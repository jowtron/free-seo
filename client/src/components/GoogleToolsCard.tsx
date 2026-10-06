import { memo } from "react";

type ExternalTool = {
	name: string;
	href: (url: string) => string;
	when: string;
	steps: string[];
};

// All three accept the page URL in the link, so each opens on this audit's page.
// They fetch it from Google's or schema.org's servers, so it must be public.
const TOOLS: ExternalTool[] = [
	{
		name: "PageSpeed Insights",
		href: url => `https://pagespeed.web.dev/analysis?url=${ encodeURIComponent(url) }`,
		when: "The PageSpeed checks here cover the day-to-day. Open PageSpeed Insights when you need to know which file is the culprit.",
		steps: [
			"It opens with this page filled in and starts testing. If it doesn't, press Analyze.",
			"Pick Mobile or Desktop at the top. Mobile is the one Google ranks on.",
			"Under Diagnostics, expand any item to see the exact script, image or element responsible.",
			"Use the \"Show audits relevant to\" buttons (LCP, CLS, TBT) to see only what affects one metric.",
			"It also scores Accessibility, Best Practices and SEO, which this audit doesn't show.",
		],
	},
	{
		name: "Rich Results Test",
		href: url => `https://search.google.com/test/rich-results?url=${ encodeURIComponent(url) }`,
		when: "Run it by hand whenever the site's schema changes. This audit only checks that the JSON-LD parses and lists its types; it can't tell you whether Google will use it.",
		steps: [
			"It opens with this page filled in. If it doesn't start, press Test URL.",
			"It tests the live page, so deploy schema changes before testing them.",
			"Under Detected structured data, open each item. Errors (red) stop that rich result from showing; warnings (orange) are missing recommended fields.",
			"\"No items detected\" means none of the page's types are ones Google turns into rich results (MusicGroup, for example, isn't). That's not an error.",
			"Fix the errors, deploy, and test again.",
		],
	},
	{
		name: "Schema Markup Validator",
		href: url => `https://validator.schema.org/#url=${ encodeURIComponent(url) }`,
		when: "Optional: a second opinion on the Rich Results Test. It checks against the whole schema.org vocabulary, including types Google ignores.",
		steps: [
			"It opens with this page filled in. If it doesn't start, press Run test.",
			"Each detected item is listed with its errors and warnings: misspelled types, properties that don't exist, or values of the wrong kind.",
			"It says nothing about rich-result eligibility; use the Rich Results Test for that.",
		],
	},
];

export default memo(function GoogleToolsCard({ url }: { url: string }) {
	return (
		<section className="rounded-xl border border-brand-border bg-brand-surface p-4 shadow-panel">
			<h3 className="text-sm font-semibold text-brand-headline">Check further with Google's tools</h3>
			<p className="mt-1 text-xs leading-relaxed text-brand-muted">
				Free tools this audit can't run for you. Each link opens on this page.
			</p>
			<div className="mt-3 grid gap-3 md:grid-cols-3">
				{ TOOLS.map(tool => (
					<div key={ tool.name } className="flex min-w-0 flex-col rounded-lg border border-brand-border bg-brand-surface-soft p-3">
						<div className="flex items-start justify-between gap-2">
							<h4 className="text-xs font-semibold text-brand-headline">{ tool.name }</h4>
							<a
								href={ tool.href(url) }
								target="_blank"
								rel="noopener noreferrer"
								className="shrink-0 rounded-lg border border-brand-border-strong bg-brand-card-header px-2.5 py-1 text-xs font-semibold text-brand-accent transition-opacity hover:opacity-85 focus:outline-none focus:ring-2 focus:ring-brand-accent/30"
							>
								Open
							</a>
						</div>
						<p className="mt-2 text-xs leading-relaxed text-brand-muted">{ tool.when }</p>
						<details className="mt-2">
							<summary className="cursor-pointer select-none text-xs font-semibold text-brand-accent">
								How to use it
							</summary>
							<ol className="mt-2 list-decimal space-y-1 pl-4 text-xs leading-relaxed text-brand-muted">
								{ tool.steps.map(step => <li key={ step }>{ step }</li>) }
							</ol>
						</details>
					</div>
				)) }
			</div>
		</section>
	);
});
