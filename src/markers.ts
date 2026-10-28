/**
 * Convert Perforce merge markers into git's diff3 markers, so omp's built-in
 * conflict handling (`conflict://<id>` from `read`, `@ours`/`@theirs`/`@base`
 * tokens on `write`) works on files resolved with `p4 resolve -af`.
 *
 * Perforce writes each conflict as:
 *
 *     >>>> ORIGINAL //depot/f#1      base
 *     ==== THEIRS //depot/f#2        theirs (the incoming revision / shelf)
 *     ==== YOURS //client/f          yours (the workspace)
 *     <<<<
 *
 * which becomes:
 *
 *     <<<<<<< YOURS //client/f
 *     ||||||| ORIGINAL //depot/f#1
 *     =======
 *     >>>>>>> THEIRS //depot/f#2
 *
 * Sections may appear in any order and any may be missing; a block that does
 * not close, or repeats a section, is left untouched.
 */

const OPEN = ">>>> ";
const SECTION = /^==== (ORIGINAL|THEIRS|YOURS|BOTH)\b(.*)$/;
const OPEN_LINE = /^>>>> (ORIGINAL|THEIRS|YOURS|BOTH)\b(.*)$/;
const CLOSE = "<<<<";

type SectionName = "ORIGINAL" | "THEIRS" | "YOURS" | "BOTH";

interface Block {
	sections: Map<SectionName, { label: string; lines: string[] }>;
	raw: string[];
}

/** True when `text` still has Perforce-style conflict markers. */
export function hasP4Markers(text: string): boolean {
	return /^>>>> (ORIGINAL|THEIRS|YOURS|BOTH)\b/m.test(text) && /^<<<<\r?$/m.test(text);
}

/** True when `text` has git-style conflict markers. */
export function hasGitMarkers(text: string): boolean {
	return /^<<<<<<<( |\r?$)/m.test(text) && /^>>>>>>>( |\r?$)/m.test(text);
}

/** Rewrite every well-formed Perforce conflict block in `text`; returns the count converted. */
export function p4MarkersToGit(text: string): { text: string; converted: number } {
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const lines = text.split(/\r?\n/);
	const out: string[] = [];
	let converted = 0;
	let block: Block | null = null;
	let current: SectionName | null = null;

	const abandon = () => {
		if (block) out.push(...block.raw);
		block = null;
		current = null;
	};

	for (const line of lines) {
		if (!block) {
			const open = line.startsWith(OPEN) ? OPEN_LINE.exec(line) : null;
			if (open) {
				block = { sections: new Map(), raw: [line] };
				current = open[1] as SectionName;
				block.sections.set(current, { label: `${open[1]}${open[2]}`, lines: [] });
			} else {
				out.push(line);
			}
			continue;
		}
		block.raw.push(line);
		if (line === CLOSE) {
			const rendered = renderGit(block);
			if (rendered) {
				out.push(...rendered);
				converted++;
				block = null;
				current = null;
			} else {
				abandon();
			}
			continue;
		}
		const section = SECTION.exec(line);
		if (section) {
			const name = section[1] as SectionName;
			if (block.sections.has(name)) {
				abandon();
				continue;
			}
			current = name;
			block.sections.set(name, { label: `${name}${section[2]}`, lines: [] });
			continue;
		}
		block.sections.get(current!)!.lines.push(line);
	}
	abandon(); // unterminated block at EOF stays as written
	return { text: out.join(eol), converted };
}

function renderGit(block: Block): string[] | null {
	const s = block.sections;
	// BOTH means both sides made the same change; there is nothing to choose.
	if (s.has("BOTH")) {
		if (s.has("THEIRS") || s.has("YOURS")) return null;
		return s.get("BOTH")!.lines;
	}
	const yours = s.get("YOURS");
	const theirs = s.get("THEIRS");
	if (!yours && !theirs) return null;
	const base = s.get("ORIGINAL");
	return [
		`<<<<<<< ${yours?.label ?? "YOURS"}`,
		...(yours?.lines ?? []),
		...(base ? [`||||||| ${base.label}`, ...base.lines] : []),
		"=======",
		...(theirs?.lines ?? []),
		`>>>>>>> ${theirs?.label ?? "THEIRS"}`,
	];
}
