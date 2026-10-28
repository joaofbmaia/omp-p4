/**
 * Thin `p4` CLI runner.
 *
 * Tagged commands run with `-ztag -Mj` so every record and every server message
 * arrives as one JSON object per line. Errors and warnings carry `severity`
 * (2 warning, 3 failed, 4 fatal) and `data`; informational output ("must resolve
 * … before submitting", "resolve skipped") carries `level` and `data` instead.
 * Everything else is a record. Note "no such file/changelist" is only a warning.
 */

export interface P4Result {
	records: Record<string, string>[];
	/** Warnings and info messages ("file(s) up-to-date", "must resolve … before submitting", …). */
	warnings: string[];
	/** Severity ≥3 server messages plus anything on stderr. */
	errors: string[];
	/** Raw stdout, for untagged commands (`diff`, `print`, `change -i`). */
	stdout: string;
	exitCode: number;
}

export interface P4Options {
	cwd: string;
	/** Run tagged with `-ztag -Mj` (default true). */
	tagged?: boolean;
	stdin?: string;
	timeoutMs?: number;
	/** Extra global options placed before the command, e.g. `["--field", "Description=…"]`. */
	globals?: string[];
}

export class P4Error extends Error {
	constructor(
		message: string,
		readonly result: P4Result,
	) {
		super(message);
		this.name = "P4Error";
	}
}

const DEFAULT_TIMEOUT_MS = 30_000;

export async function p4(args: string[], options: P4Options): Promise<P4Result> {
	const tagged = options.tagged ?? true;
	const argv = ["p4", ...(tagged ? ["-ztag", "-Mj"] : []), ...(options.globals ?? []), ...args];
	// p4 trusts $PWD over the real cwd on Unix when resolving P4CONFIG and relative paths.
	const proc = Bun.spawn(argv, {
		cwd: options.cwd,
		env: { ...process.env, PWD: options.cwd },
		stdin: options.stdin === undefined ? "ignore" : Buffer.from(options.stdin),
		stdout: "pipe",
		stderr: "pipe",
	});
	const started = performance.now();
	const timer = setTimeout(() => proc.kill(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]).finally(() => clearTimeout(timer));

	const result: P4Result = { records: [], warnings: [], errors: [], stdout, exitCode };
	trace(argv, started);
	if (stderr.trim()) result.errors.push(stderr.trim());
	if (!tagged) return result;

	for (const line of stdout.split("\n")) {
		if (!line.startsWith("{")) continue;
		let obj: Record<string, unknown>;
		try {
			obj = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof obj.data === "string" && (typeof obj.severity === "number" || typeof obj.level === "number")) {
			const severity = typeof obj.severity === "number" ? obj.severity : 1;
			(severity >= 3 ? result.errors : result.warnings).push(obj.data.trim());
		} else {
			result.records.push(obj as Record<string, string>);
		}
	}
	return result;
}

/** With OMP_P4_TRACE=<file>, append one line per p4 call (duration, args) for latency work. */
function trace(argv: string[], started: number): void {
	const file = process.env.OMP_P4_TRACE;
	if (!file) return;
	const ms = Math.round(performance.now() - started);
	const args = argv.slice(1).filter(a => a !== "-ztag" && a !== "-Mj").map(a => (a.length > 60 ? `${a.slice(0, 57)}...` : a));
	require("node:fs").appendFileSync(file, `${new Date().toISOString()} ${String(ms).padStart(5)}ms p4 ${args.join(" ")}\n`);
}

/** Like {@link p4}, but throws when the server reported an error or the process failed. */
export async function p4Strict(args: string[], options: P4Options): Promise<P4Result> {
	const result = await p4(args, options);
	if (result.errors.length > 0 || result.exitCode !== 0) {
		if (isLoginError(result)) {
			throw new P4Error("Perforce ticket expired or missing: run 'p4 login' in a terminal, then retry.", result);
		}
		if (isTrustError(result)) {
			throw new P4Error("The Perforce server's SSL fingerprint is not trusted: check it, run 'p4 trust' in a terminal, then retry.", result);
		}
		const detail = result.errors.join("\n") || `exit code ${result.exitCode}`;
		throw new P4Error(`p4 ${args[0]} failed: ${detail}`, result);
	}
	return result;
}

/** True when an SSL server's fingerprint is not trusted yet (first connection, or a changed key). */
export function isTrustError(result: P4Result): boolean {
	return result.errors.some(e => /authenticity of .* can't be established|IDENTIFICATION HAS CHANGED|p4 trust/i.test(e));
}

/** True when the failure is an expired or missing ticket. */
export function isLoginError(result: P4Result): boolean {
	return result.errors.some(e => /P4PASSWD|session has expired|Perforce password|please login again/i.test(e));
}
