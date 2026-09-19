/**
 * dsh-session-lazy-view — host half.
 *
 * Read-only lazy session viewer. Exposes a small fenced API + an HTML panel
 * under /lazyview/* that lets you peek at the tail of any session artifact
 * (~/.dsh/sessions/&lt;encoded-cwd&gt;/session-&#42;/session.v3.jsonl.zstd) WITHOUT
 * decompressing the whole file: the zstd multi-frame format means the last
 * N event batches can be read from a tail window alone (see lib/frames.js).
 *
 * Deliberately NOT a Trajectory replacement and NOT writable: no delete,
 * no archive, no mutation of any kind. Any parse failure surfaces as a
 * structured JSON error so the panel never crashes with a raw 500.
 *
 * Registration follows the dsh-archived-sessions pattern: a single
 * ctx.effect registering a "prefix" route on webServer, tolerant of late
 * webServer availability (panel endpoints registered (late webServer)).
 */
import z from "@deepseek-ai/schemastery";
import { readdir, stat, readFile } from "node:fs/promises";
import { join, normalize, sep } from "node:path";
import { homedir } from "node:os";
import { readTailFrames } from "./frames.js";

const name = "dsh-session-lazy-view";
// Sessions root is resolved at request time (not import time) so a moved
// ~/.dsh is picked up without a reload; inject only what we truly need.
const inject = ["webServer"];
/** Empty configuration schema: this plugin owns no loader config. */
const Config = z.object({});

const DEFAULT_FRAMES = 2;
const MAX_FRAMES = 20;
const SESSIONS_ROOT = () => join(homedir(), ".dsh", "sessions");
const BIG_SESSION_BYTES = 10 * 1024 * 1024;

// -- HTTP helpers (mirrors dsh-archived-sessions) -----------------------------
function header(headers, name) {
	const value = headers[name];
	return typeof value === "string" ? value : void 0;
}
function parseAuthority(authority) {
	try {
		return new URL(`http://${authority}`);
	} catch {
		return;
	}
}
function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	const parts = hostname.split(".");
	return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
/** Same trust gate as archived-sessions: loopback Host, no cross-site fetch, same-origin. */
function isTrustedApiRequest(request) {
	const host = header(request.headers, "host");
	if (host === void 0) return false;
	const hostUrl = parseAuthority(host);
	if (hostUrl === void 0) return false;
	if (!isLoopbackHostname(hostUrl.hostname)) return false;
	if (header(request.headers, "sec-fetch-site") === "cross-site") return false;
	const origin = header(request.headers, "origin");
	if (origin === void 0) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}
function writeJson(res, status, body) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}
function writeOk(res, value) {
	writeJson(res, 200, { ok: true, value });
}
function writeFail(res, message, status = 500, code = "internal") {
	writeJson(res, status, { ok: false, error: { code, message } });
}
/** Uniform error → status mapping so parse failures never 500 blindly. */
function statusOf(error) {
	if (typeof error?.status === "number") return error.status;
	if (error?.code === "ENOENT") return 404;
	return 500;
}
function badRequest(message) {
	const error = new Error(message);
	error.status = 400;
	error.code = "bad-request";
	return error;
}

/**
 * Resolve a session-relative path under ~/.dsh/sessions safely. The client
 * passes the encoded project dir + session dir exactly as listed by /list;
 * anything escaping the sessions root (.., absolute, symlinks are fine —
 * sessions live under the root already) is rejected with 400.
 */
function resolveSessionPath(relativePath) {
	if (typeof relativePath !== "string" || relativePath === "") throw badRequest("session path is required");
	const root = SESSIONS_ROOT();
	const full = normalize(join(root, relativePath));
	if (full !== root && !full.startsWith(root + sep)) throw badRequest("session path escapes the sessions root");
	return full;
}

/** List every session artifact on disk: stat-only, zero decompression. */
async function listSessions() {
	const root = SESSIONS_ROOT();
	const projects = [];
	let projectNames;
	try {
		projectNames = await readdir(root);
	} catch (error) {
		if (error?.code === "ENOENT") return { root, projects: [] };
		throw error;
	}
	for (const project of projectNames.sort()) {
		const projectDir = join(root, project);
		const sessionDirs = await readdir(projectDir).catch(() => []);
		const sessions = [];
		for (const sessionDir of sessionDirs.sort()) {
			const dir = join(projectDir, sessionDir);
			const entries = await readdir(dir).catch(() => []);
			const artifacts = entries.filter((entry) => entry === "session.v3.jsonl.zstd" || entry === "session.jsonl.zstd");
			for (const artifact of artifacts) {
				const info = await stat(join(dir, artifact)).catch(() => void 0);
				if (info === void 0) continue;
				sessions.push({
					sessionId: sessionDir.replace(/^session-/, ""),
					dir: sessionDir,
					// relative-to-root path, echoed back as the ?path= argument
					path: `${project}/${sessionDir}/${artifact}`,
					artifact,
					format: artifact.startsWith("session.v3") ? "v3-multiframe" : "legacy-single-frame",
					bytes: info.size,
					mtime: info.mtimeMs,
					big: info.size > BIG_SESSION_BYTES
				});
			}
		}
		if (sessions.length > 0) projects.push({ project, sessions });
	}
	return { root, projects };
}

function apply(ctx) {
	ctx.effect(() => ctx.get("webServer")?.register({
		kind: "prefix",
		path: "/lazyview",
		handler: async (req, res) => {
			try {
				if (!isTrustedApiRequest(req)) {
					writeFail(res, "forbidden", 403, "forbidden");
					return;
				}
				const url = new URL(req.url ?? "/", "http://dsh.internal");
				const pathname = url.pathname;
				if (req.method !== "GET") {
					writeFail(res, "method not allowed", 405, "method-error");
					return;
				}
				// API surface is GET-only: a viewer needs no POSTs, and GET keeps
				// every endpoint linkable straight from the panel HTML.
				if (pathname === "/lazyview/api/list") {
					writeOk(res, await listSessions());
				} else if (pathname === "/lazyview/api/tail") {
					const path = url.searchParams.get("path") ?? "";
					const frames = Math.min(Math.max(Number(url.searchParams.get("frames")) || DEFAULT_FRAMES, 1), MAX_FRAMES);
					const skip = Math.min(Math.max(Number(url.searchParams.get("skip")) || 0, 0), 1000);
					// Only the two known artifact names are ever opened; ?path= must
					// end in one of them so a stray path cannot be used as a file probe.
					if (!/(^|\/)session\.(v3\.)?jsonl\.zstd$/.test(path)) throw badRequest("path must point at session.v3.jsonl.zstd or session.jsonl.zstd");
					writeOk(res, await readTailFrames(resolveSessionPath(path), frames, skip));
				} else if (pathname === "/lazyview" || pathname === "/lazyview/") {
					const html = await renderPanel().catch((error) => `<pre>panel assets unavailable: ${String(error.message)}</pre>`);
					res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
					res.end(html);
				} else {
					writeFail(res, `unknown lazyview route "${pathname}"`, 404, "not-found");
				}
			} catch (error) {
				writeFail(res, error instanceof Error ? error.message : String(error), statusOf(error), typeof error?.code === "string" ? error.code : "internal");
			}
		}
	}), "dsh-session-lazy-view: /lazyview routes (read-only panel)");
}

// -- Panel HTML ---------------------------------------------------------------
// Inline single-file page (no bundler, no client chunk): fetches /api/list,
// then /api/tail per opened session. Plain DOM, no framework — the panel is
// a debugging tool and should stay vendorable as one file.
async function renderPanel() {
	const template = await readFile(new URL("./panel.html", import.meta.url), "utf8");
	return template;
}

export { Config, apply, inject, name };
