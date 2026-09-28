/**
 * dsh-session-lazy-view — v4 会话支持测试（v0.3.2）。
 * 新版 DSH 写 session.v4.jsonl.zstd（帧 0 header version:4）；
 * 面板此前只认 v3 导致新会话不可见。这里用 v4 fixture 验证
 * tail / search / stats 全链路对 v4 文件照常工作。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { readTailFrames, searchSession, collectStats } from "../lib/frames.js";
import { isArtifactPath, isArtifactEntry, artifactFormat } from "../lib/artifact.js";

const HEADER4 = JSON.stringify({ type: "session", id: "v4-session", version: 4, cwd: "/tmp/v4", createdAt: "2026-09-27T00:00:00Z" });
const EVENTS = [
	{ type: "user/message", seq: 1, time: 1000, data: { role: "user", content: [{ type: "text", text: "v4 hello needle" }] } },
	{ type: "assistant/message", seq: 2, time: 2000, data: { message: { role: "assistant", content: [{ type: "text", text: "v4 reply" }] } } }
];

async function makeV4() {
	const dir = await mkdtemp(join(tmpdir(), "slv-v4-"));
	const path = join(dir, "session.v4.jsonl.zstd");
	const parts = [zstdCompressSync(Buffer.from(HEADER4 + "\n")), zstdCompressSync(Buffer.from(EVENTS.map((e) => JSON.stringify(e)).join("\n") + "\n"))];
	await writeFile(path, Buffer.concat(parts));
	return { dir, path };
}

test("readTailFrames / searchSession / collectStats work on session.v4 files", async () => {
	const { dir, path } = await makeV4();
	try {
		const tail = await readTailFrames(path, 2, 0);
		assert.equal(tail.frames.length, 2);
		assert.deepEqual(tail.frames[1].header, { id: "v4-session", version: 4, cwd: "/tmp/v4", createdAt: "2026-09-27T00:00:00Z" });
		assert.equal(tail.frames[0].events[0].text, "v4 hello needle"); // index 0 = 最新帧

		const search = await searchSession(path, "needle");
		assert.equal(search.hits.length, 1);
		assert.equal(search.partial, false);

		const stats = await collectStats(path);
		assert.equal(stats.events, 2);
		assert.equal(stats.header.version, 4);
		assert.deepEqual(stats.typeCounts, { "user/message": 1, "assistant/message": 1 });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("artifact helpers accept v4/v3/legacy and reject probes", () => {
	assert.equal(isArtifactPath("p/session-abc/session.v4.jsonl.zstd"), true);
	assert.equal(isArtifactPath("p/session-abc/session.v3.jsonl.zstd"), true);
	assert.equal(isArtifactPath("p/session-abc/session.jsonl.zstd"), true);
	assert.equal(isArtifactPath("p/session-abc/session.v5.jsonl.zstd"), true); // 未来版本自动纳入
	assert.equal(isArtifactPath("p/session-abc/other.jsonl.zstd"), false);
		assert.equal(isArtifactPath("../.npmrc/session.jsonl.zstd"), true); // 形状匹配；目录逃逸由 index.js resolveSessionPath 兜底
	assert.equal(isArtifactEntry("session.v4.jsonl.zstd"), true);
	assert.equal(isArtifactEntry("notes.txt"), false);
	assert.equal(artifactFormat("session.v4.jsonl.zstd"), "v4-multiframe");
	assert.equal(artifactFormat("session.v3.jsonl.zstd"), "v3-multiframe");
	assert.equal(artifactFormat("session.jsonl.zstd"), "legacy-single-frame");
});
