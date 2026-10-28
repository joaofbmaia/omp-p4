/**
 * Throwaway Perforce servers for live tests.
 *
 * Default: an `rsh:` port, so p4d starts per command (no daemon, no open port).
 * `ssl: true` needs a real listener, so it runs `p4d -d` on a random localhost
 * port with a self-signed certificate; call `stop()` when done.
 *
 * Every client directory gets a `.p4config`; P4CONFIG/P4TICKETS/P4ENVIRO/P4TRUST
 * point into the temp dir so a real Perforce setup is never touched. Recent
 * servers refuse access until the first user has a password, so the user gets
 * a random one (never printed) and is logged in.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { p4 } from "../../src/p4";

export interface TestServer {
	base: string;
	port: string;
	user: string;
	password: string;
	/** Create (or return) a client rooted at base/<name>; extra spec lines (e.g. Stream) may be given. */
	client(name: string, spec?: Record<string, string>): Promise<string>;
	/** Run p4 in a client dir as `user`; throws on failure. */
	run(dir: string, args: string[], stdin?: string): Promise<string>;
	stop(): Promise<void>;
}

const P4_ENV = ["P4PORT", "P4USER", "P4CLIENT", "P4PASSWD", "P4CONFIG", "P4TICKETS", "P4ENVIRO", "P4TRUST", "P4CHARSET"];

/** Point the process at a test sandbox; returns a function restoring the previous values. */
export function isolateP4Env(base: string): () => void {
	const saved = Object.fromEntries(P4_ENV.map(k => [k, process.env[k]]));
	for (const k of P4_ENV) delete process.env[k];
	Object.assign(process.env, {
		P4CONFIG: ".p4config",
		P4TICKETS: `${base}/tickets`,
		P4ENVIRO: `${base}/enviro`,
		P4TRUST: `${base}/trust`,
	});
	return () => {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	};
}

export async function startServer(options: { unicode?: boolean; ssl?: boolean; user?: string } = {}): Promise<TestServer> {
	const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-p4-srv-")));
	const root = path.join(base, "srv");
	fs.mkdirSync(root);
	const user = options.user ?? "tester";
	const password = `Tt-${crypto.randomUUID()}-9`;

	if (options.unicode) Bun.spawnSync(["p4d", "-r", root, "-xi"]);
	Bun.spawnSync(["p4d", "-r", root, "-cset security=0"]);

	let port: string;
	let daemon = false;
	if (options.ssl) {
		const sslDir = path.join(base, "ssl");
		fs.mkdirSync(sslDir, { mode: 0o700 });
		Bun.spawnSync(["p4d", "-Gc"], { env: { ...process.env, P4SSLDIR: sslDir } });
		const listen = `ssl:127.0.0.1:${20000 + Math.floor(Math.random() * 20000)}`;
		// The forked daemon inherits the parent's pipes; detach them or spawnSync never returns.
		const started = Bun.spawnSync(["p4d", "-r", root, "-p", listen, "-L", `${root}/log`, "-d"], {
			env: { ...process.env, P4SSLDIR: sslDir },
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		if (started.exitCode !== 0) throw new Error(`p4d -d failed to start (exit ${started.exitCode}); see ${root}/log`);
		port = listen;
		daemon = true;
		await Bun.sleep(500);
	} else {
		port = `rsh:p4d -r ${root} -L ${root}/log -i`;
	}

	const config = (client: string) =>
		`P4PORT=${port}\nP4USER=${user}\nP4CLIENT=${client}\n${options.unicode ? "P4CHARSET=utf8\n" : ""}`;
	const clientDir = (name: string) => path.join(base, name);

	const server: TestServer = {
		base,
		port,
		user,
		password,
		async run(dir, args, stdin) {
			const r = await p4(args, { cwd: dir, tagged: false, stdin });
			if (r.exitCode !== 0) throw new Error(`p4 ${args.join(" ")}: ${r.stdout}${r.errors.join("\n")}`);
			return r.stdout;
		},
		async client(name, spec = {}) {
			const dir = clientDir(name);
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, ".p4config"), config(name));
			let text = (await p4(["client", "-o", name], { cwd: dir, tagged: false })).stdout.replace(/^Root:.*$/m, `Root:\t${dir}`);
			for (const [field, value] of Object.entries(spec)) {
				text = new RegExp(`^${field}:`, "m").test(text)
					? text.replace(new RegExp(`^${field}:.*$`, "m"), `${field}:\t${value}`)
					: `${text.trimEnd()}\n\n${field}:\t${value}\n`;
			}
			// A stream client's View comes from the stream; drop the default depot view.
			if (spec.Stream) text = text.replace(/^View:\n(\t.*\n?)*/m, "");
			await server.run(dir, ["client", "-i"], text);
			return dir;
		},
		async stop() {
			if (!daemon) return;
			await p4(["admin", "stop"], { cwd: clientDir("admin"), tagged: false }).catch(() => {});
			// Belt and braces: the daemon is identified by its unique temp server root.
			Bun.spawnSync(["pkill", "-f", `p4d -r ${root} `]);
		},
	};

	// First user: set a password through passwd's prompts, then log in (ticket in the sandbox).
	const admin = clientDir("admin");
	fs.mkdirSync(admin, { recursive: true });
	fs.writeFileSync(path.join(admin, ".p4config"), config("admin"));
	if (options.ssl) await p4(["trust", "-y"], { cwd: admin, tagged: false });
	await p4(["passwd"], { cwd: admin, tagged: false, stdin: `${password}\n${password}\n` });
	const login = await p4(["login"], { cwd: admin, tagged: false, stdin: `${password}\n` });
	if (login.exitCode !== 0) throw new Error(`test server login failed: ${login.errors.join("; ")}`);
	return server;
}
