/**
 * dsh-session-lazy-view — zero-dependency tests for the v0.2.0 full-scan
 * features (search / stats / export helpers). Builds a synthetic zstd
 * multi-frame session artifact in a temp dir with node:zlib; never touches
 * ~/.dsh/sessions.
 *
 * Run: node --test test/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import {
	forEachFrame,
	searchSession,
	searchFrameText,
	collectStats,
	countFrames,
	framesToMarkdown
} from "../lib/frames.js";

const HEADER = JSON.stringify({ type: "session", id: "test-session", version: 3, cwd: "/tmp/proj", createdAt: "2025-01-01T00:00:00Z" });
const EVENTS = [
	{ type: "user/message", seq: 1, time: 1000, data: { role: "user", content: [{ type: "text", text: "hello world, FindMe please" }] } },
	{ type: "assistant/message", seq: 2, time: 2000, data: { message: { role: "assistant", content: [{ type: "text", text: "sure, FINDME is easy to spot" }, { type: "tool-call", name: "grep", arguments: '{"q":"findme"}' }] } } },
	{ type: "step/end", seq: 3, time: 3000, data: {} }
];

/** Build a multi-frame artifact: frame 0 = header, then one frame per event batch. */
async function makeSession(batches) {
	const dir = await mkdtemp(join(tmpdir(), "slv-test-"));
	const path = join(dir, "session.v3.jsonl.zstd");
	const parts = [zstdCompressSync(Buffer.from(HEADER + "\n"))];
	for (const lines of batches) {
		parts.push(zstdCompressSync(Buffer.from(lines.map((e) => JSON.stringify(e)).join("\n") + "\n")));
	}
	await writeFile(path, Buffer.concat(parts));
	return { dir, path };
}

test("forEachFrame walks every frame front-to-back with header first", async () => {
	const { dir, path } = await makeSession([EVENTS.slice(0, 2), EVENTS.slice(2)]);
	try {
		const seen = [];
		const result = await forEachFrame(path, { onFrame: (f) => seen.push(f) });
		assert.equal(result.totalFrames, 3);
		assert.equal(result.scannedFrames, 3);
		assert.ok(seen[0].text.includes('"type":"session"'));
		assert.ok(seen[1].text.includes("FindMe"));
		assert.ok(seen[2].text.includes("step/end"));
		assert.ok(seen.every((f) => f.text !== void 0), "no frame errors expected");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("searchSession matches case-insensitively with snippet window", async () => {
	const { dir, path } = await makeSession([EVENTS]);
	try {
		const r = await searchSession(path, "findme", { max: 20 });
		assert.ok(r.hits.length >= 3, `expected >=3 hits (text, uppercase, tool args), got ${r.hits.length}`);
		assert.ok(r.hits.every((h) => h.snippet.toLowerCase().includes("findme")));
		// snippet keeps a window, not the whole text
		const first = r.hits.find((h) => h.snippet.includes("hello"));
		assert.ok(first, "first hit should come from the user message");
		assert.equal(first.seq, 1);
		assert.equal(first.frameIndex, 1);
		assert.equal(r.partial, false);
		assert.equal(r.aborted, false);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("searchSession respects max and reports partial beyond frameCap", async () => {
	const batches = Array.from({ length: 5 }, (_, i) => [{ type: "step/end", seq: i, time: i, data: { note: `marker-${i}` } }]);
	const { dir, path } = await makeSession(batches);
	try {
		const capped = await searchSession(path, "marker", { max: 2, frameCap: 3 });
		assert.equal(capped.hits.length, 2);
		assert.equal(capped.scannedFrames, 3);
		assert.equal(capped.totalFrames, 6); // header frame + 5 event frames
		assert.equal(capped.partial, true);

		const full = await searchSession(path, "marker", { max: 50 });
		assert.equal(full.hits.length, 5);
		assert.equal(full.partial, false);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("searchSession honors a pre-aborted signal", async () => {
	const { dir, path } = await makeSession([EVENTS]);
	try {
		const ac = new AbortController();
		ac.abort();
		const r = await searchSession(path, "findme", { max: 20, signal: ac.signal });
		assert.equal(r.scannedFrames, 0);
		assert.equal(r.aborted, true);
		assert.equal(r.hits.length, 0);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("searchFrameText caps occurrences per frame and covers unparsable lines", () => {
	const hits = searchFrameText('{"type":"step/end","seq":9,"data":{}}\nnot-json FINDME here', "findme", 7);
	assert.equal(hits.length, 1);
	assert.equal(hits[0].frameIndex, 7);
	assert.equal(hits[0].type, "<unparsable>");
	const flood = searchFrameText(JSON.stringify({ type: "x", seq: 1, data: { text: "ab".repeat(5000) } }), "ab", 0);
	assert.ok(flood.length <= 50, "per-frame hit cap should hold");
});

test("collectStats fast counts frames/bytes without decompression; full counts by type", async () => {
	const { dir, path } = await makeSession([EVENTS.slice(0, 1), EVENTS.slice(1)]);
	try {
		const fast = await collectStats(path, { fast: true });
		assert.equal(fast.fast, true);
		assert.equal(fast.totalFrames, 3);
		assert.equal(typeof fast.bytes, "number");
		assert.ok(fast.bytes > 0);
		assert.equal(await countFrames(path), 3);

		const full = await collectStats(path);
		assert.equal(full.fast, false);
		assert.equal(full.totalFrames, 3);
		assert.equal(full.events, 3); // header excluded
		assert.deepEqual(full.typeCounts, { "user/message": 1, "assistant/message": 1, "step/end": 1 });
		assert.equal(full.firstTime, 1000);
		assert.equal(full.lastTime, 3000);
		assert.deepEqual(full.header, { id: "test-session", version: 3, cwd: "/tmp/proj", createdAt: "2025-01-01T00:00:00Z" });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("framesToMarkdown renders a text document without touching disk", async () => {
	const { dir, path } = await makeSession([EVENTS]);
	try {
		const { readTailFrames } = await import("../lib/frames.js");
		const value = await readTailFrames(path, 2, 0);
		const md = framesToMarkdown(value, { path: "proj/session-abc/session.v3.jsonl.zstd" });
		assert.ok(md.startsWith("# DSH session export"));
		assert.ok(md.includes("proj/session-abc/session.v3.jsonl.zstd"));
		assert.ok(md.includes("user/message"), "events should appear with role/type labels");
		assert.ok(md.includes("hello world, FindMe please"));
		assert.ok(!md.includes("undefined"), "no stray undefined slots");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
