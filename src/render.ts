/**
 * Transcript rendering for the p4 tools, in the style of omp's built-in tools:
 * a one-line summary when collapsed, the full coloured output when expanded.
 * Diffs use the theme's own diff colours, and omp's diff renderer (word-level
 * highlighting) when it can be loaded.
 */

/** The bits of omp's Theme these renderers use. */
export interface ThemeLike {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

type DiffRenderer = (diffText: string, options?: { filePath?: string }) => string;
let ompRenderDiff: DiffRenderer | undefined;

/** Load omp's own diff renderer (internal module; plain colouring is the fallback). */
export async function loadDiffRenderer(): Promise<void> {
	try {
		const mod = (await import("@oh-my-pi/pi-tui/chrome/diff")) as { renderDiff?: DiffRenderer };
		ompRenderDiff = mod.renderDiff;
	} catch {
		ompRenderDiff = undefined;
	}
}

export interface FileDiff {
	path: string;
	action?: string;
	lines: string[];
	added: number;
	removed: number;
}

/**
 * Split the extension's diff output into files. Handles both the `=== //depot/f (edit) ===`
 * sections of p4_diff and the `diff --git a/… b/…` headers of p4:// diffs.
 */
export function parseDiffs(text: string): FileDiff[] {
	const files: FileDiff[] = [];
	let current: FileDiff | undefined;
	for (const line of text.split("\n")) {
		const section = /^=== (.+?)(?: \((.+)\))? ===$/.exec(line);
		const git = /^diff --git a\/(.+?) b\//.exec(line);
		if (section || git) {
			// p4_diff writes `=== //depot/f (edit) ===` and then the file's own `diff --git` line.
			if (git && current?.lines.length === 0) continue;
			current = { path: section ? section[1] : `//${git![1]}`, action: section?.[2], lines: [], added: 0, removed: 0 };
			files.push(current);
			continue;
		}
		if (!current || /^(--- |\+\+\+ |new file mode|deleted file mode)/.test(line)) continue;
		current.lines.push(line);
		if (line.startsWith("+")) current.added++;
		else if (line.startsWith("-")) current.removed++;
	}
	// The blank separator between files is not part of either diff.
	for (const f of files) while (f.lines.length > 0 && f.lines[f.lines.length - 1] === "") f.lines.pop();
	return files;
}

function stats(theme: ThemeLike, added: number, removed: number): string {
	return [added ? theme.fg("toolDiffAdded", `+${added}`) : "", removed ? theme.fg("toolDiffRemoved", `-${removed}`) : ""]
		.filter(Boolean)
		.join(" ");
}

function colourHunk(theme: ThemeLike, lines: string[], filePath: string): string {
	const body = lines.filter(l => !l.startsWith("@@"));
	if (ompRenderDiff && body.length > 0) {
		try {
			return ompRenderDiff(body.join("\n"), { filePath });
		} catch {
			// fall through to plain colouring
		}
	}
	return lines
		.map(l =>
			l.startsWith("@@")
				? theme.fg("dim", l)
				: l.startsWith("+")
					? theme.fg("toolDiffAdded", l)
					: l.startsWith("-")
						? theme.fg("toolDiffRemoved", l)
						: theme.fg("toolDiffContext", l),
		)
		.join("\n");
}

/** Collapsed: one line per file with +/- counts. Expanded: the coloured diff. */
export function renderDiffText(text: string, theme: ThemeLike, expanded: boolean): string {
	const files = parseDiffs(text);
	if (files.length === 0) return theme.fg("toolOutput", text.trim() || "(no diff)");
	const added = files.reduce((n, f) => n + f.added, 0);
	const removed = files.reduce((n, f) => n + f.removed, 0);
	const summary = `${files.length} file${files.length === 1 ? "" : "s"} ${stats(theme, added, removed)}`;
	const perFile = files.map(f => `  ${f.path}${f.action ? theme.fg("dim", ` (${f.action})`) : ""} ${stats(theme, f.added, f.removed)}`);
	if (!expanded) return [summary, ...perFile.slice(0, 8), ...(files.length > 8 ? [theme.fg("dim", `  … ${files.length - 8} more`)] : [])].join("\n");
	return [
		summary,
		...files.flatMap(f => [
			"",
			theme.bold(`${f.path}${f.action ? ` (${f.action})` : ""}`) + ` ${stats(theme, f.added, f.removed)}`,
			colourHunk(theme, f.lines, f.path),
		]),
	].join("\n");
}

const ACTION_COLOUR: Record<string, string> = {
	add: "toolDiffAdded",
	"move/add": "toolDiffAdded",
	branch: "toolDiffAdded",
	delete: "toolDiffRemoved",
	"move/delete": "toolDiffRemoved",
};

/** p4_opened: counts by action when collapsed, the coloured file list when expanded. */
export function renderOpened(files: { action: string; depotFile: string; change: string }[], theme: ThemeLike, expanded: boolean): string {
	if (files.length === 0) return theme.fg("dim", "no opened files");
	const counts = new Map<string, number>();
	for (const f of files) counts.set(f.action, (counts.get(f.action) ?? 0) + 1);
	const summary = `${files.length} opened · ${[...counts].map(([a, n]) => theme.fg(ACTION_COLOUR[a] ?? "toolOutput", `${n} ${a}`)).join(", ")}`;
	if (!expanded) return summary;
	return [summary, ...files.map(f => `  ${theme.fg(ACTION_COLOUR[f.action] ?? "toolOutput", f.action.padEnd(11))} ${f.depotFile} ${theme.fg("dim", `CL ${f.change}`)}`)].join("\n");
}

/** p4_resolve: pending resolves and leftover markers stand out; "all clear" is green. */
export function renderResolve(
	text: string,
	details: { pending?: unknown[]; markers?: unknown[] } | undefined,
	theme: ThemeLike,
	expanded: boolean,
): string {
	const pending = details?.pending?.length ?? 0;
	const markers = details?.markers?.length ?? 0;
	const summary =
		pending === 0 && markers === 0
			? theme.fg("success", "✓ nothing to resolve, no conflict markers")
			: theme.fg("warning", [pending ? `${pending} still to resolve` : "", markers ? `${markers} with conflict markers` : ""].filter(Boolean).join(" · "));
	return expanded ? `${summary}\n${theme.fg("toolOutput", text.trim())}` : summary;
}

/** Review comments: state, votes and open tasks in one line; the threaded text when expanded. */
export function renderReview(text: string, theme: ThemeLike, expanded: boolean): string {
	const [head = "", ...rest] = text.split("\n");
	const open = (text.match(/\[task: open\]/g) ?? []).length;
	const comments = (text.match(/^#\d+ /gm) ?? []).length + (text.match(/^\s+↳ #\d+ /gm) ?? []).length;
	const summary = `${theme.bold(head.replace(/;.*$/, ""))} ${theme.fg("dim", `· ${comments} comment${comments === 1 ? "" : "s"}`)}${open ? theme.fg("warning", ` · ${open} open task${open === 1 ? "" : "s"}`) : ""}`;
	if (!expanded) return summary;
	const body = rest
		.join("\n")
		.replace(/\[task: open\]/g, theme.fg("warning", "[task: open]"))
		.replace(/\[task: (addressed|verified)\]/g, (_m, s: string) => theme.fg("success", `[task: ${s}]`));
	return `${summary}\n${theme.fg("dim", head)}\n${body}`;
}
