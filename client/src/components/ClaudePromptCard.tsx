import { memo, useEffect, useMemo, useState } from "react";
import type { AuditReport } from "../../../shared/types";
import { buildClaudePrompt, countPromptProblems } from "../utils/claudePrompt";

// navigator.clipboard only exists in a secure context, and the app is also
// reachable over plain http on the tailnet, so fall back to execCommand there.
async function copyText(text: string): Promise<boolean> {
	try {
		if (navigator.clipboard && window.isSecureContext) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		// fall through to the legacy path
	}
	const textarea = document.createElement("textarea");
	textarea.value = text;
	textarea.setAttribute("readonly", "");
	textarea.style.position = "fixed";
	textarea.style.opacity = "0";
	document.body.appendChild(textarea);
	textarea.select();
	try {
		return document.execCommand("copy");
	} catch {
		return false;
	} finally {
		document.body.removeChild(textarea);
	}
}

export default memo(function ClaudePromptCard({
	audit,
	excludedCheckIds,
}: {
	audit: AuditReport;
	excludedCheckIds: Set<string>;
}) {
	const prompt = useMemo(() => buildClaudePrompt(audit, excludedCheckIds), [audit, excludedCheckIds]);
	const problemCount = useMemo(() => countPromptProblems(audit, excludedCheckIds), [audit, excludedCheckIds]);
	const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

	useEffect(() => {
		if (copyState === "idle") return;
		const timer = window.setTimeout(() => setCopyState("idle"), 2500);
		return () => window.clearTimeout(timer);
	}, [copyState]);

	const handleCopy = async () => {
		setCopyState(await copyText(prompt) ? "copied" : "failed");
	};

	const buttonLabel = copyState === "copied"
		? "Copied"
		: copyState === "failed"
			? "Copy failed, select the text below"
			: "Copy prompt";

	return (
		<section className="rounded-xl border border-brand-border bg-brand-surface p-4 shadow-panel">
			<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
				<div className="min-w-0">
					<h3 className="text-sm font-semibold text-brand-headline">Fix everything with Claude</h3>
					<p className="mt-1 text-xs leading-relaxed text-brand-muted">
						{ problemCount === 0
							? "No problems to fix."
							: `One prompt listing all ${ problemCount } ${ problemCount === 1 ? "problem" : "problems" } and their suggested fixes. Paste it into a Claude session opened in the site's code.` }
						{ excludedCheckIds.size > 0 && " Checks you've excluded from the score are left out." }
					</p>
				</div>
				<button
					type="button"
					onClick={ handleCopy }
					className="shrink-0 rounded-lg border border-brand-border-strong bg-brand-card-header px-3 py-2 text-xs font-semibold text-brand-accent transition-opacity hover:opacity-85 focus:outline-none focus:ring-2 focus:ring-brand-accent/30"
				>
					{ buttonLabel }
				</button>
			</div>
			<details className="mt-3 rounded-lg border border-brand-border bg-brand-surface-soft">
				<summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold text-brand-accent">
					Show prompt
				</summary>
				<pre className="max-h-96 overflow-auto border-t border-brand-border bg-(--theme-code-background) p-3 font-mono text-xs leading-relaxed text-brand-headline whitespace-pre-wrap wrap-break-word">
					{ prompt }
				</pre>
			</details>
		</section>
	);
});
