/**
 * dsh-session-lazy-view — Timeline 纯函数测试（v0.3.0）。
 * 深链解析 / surfaceOp 遮蔽计算 / turn 分组；零依赖。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDeepLink, applySurfaceOps, buildGroups } from "../lib/timeline.js";

test("parseDeepLink reads ?session=&seq= and tolerates missing/invalid seq", () => {
	assert.deepEqual(parseDeepLink("?session=abc&seq=12"), { session: "abc", seq: 12 });
	assert.deepEqual(parseDeepLink("?session=abc"), { session: "abc", seq: null });
	assert.deepEqual(parseDeepLink("?session=abc&seq=oops"), { session: "abc", seq: null });
	assert.equal(parseDeepLink(""), null);
	assert.equal(parseDeepLink("?other=1"), null);
});

test("applySurfaceOps masks replace ranges (seqs list and from/to) and ignores others", () => {
	const events = [
		{ seq: 1, text: "a" },
		{ seq: 2, text: "b" },
		{ seq: 3, text: "c" },
		{ seq: 4, text: "d" },
		{ seq: 5, type: "x", surfaceOp: { op: "replace", seqs: [2] } },
		{ seq: 6, type: "x", surfaceOp: { op: "replace", fromSeq: 3, toSeq: 4 } },
		{ seq: 7, type: "x", surfaceOp: { op: "delete" } }
	];
	applySurfaceOps(events);
	assert.equal(events[0].masked, undefined);
	assert.equal(events[1].masked, true); // seq 2 via seqs list
	assert.equal(events[2].masked, true); // seq 3 via from/to
	assert.equal(events[3].masked, true); // seq 4 via from/to
	assert.equal(events[4].masked, undefined); // surfaceOp 事件本身不被遮蔽
	assert.equal(events[6].masked, undefined); // 非 replace op 忽略
});

test("buildGroups groups by turn/start; falls back to user/message boundaries", () => {
	const withTurn = [
		{ seq: 1, type: "turn/start" }, { seq: 2, type: "user/message", text: "hi" }, { seq: 3, type: "assistant/message", text: "yo" },
		{ seq: 4, type: "turn/start" }, { seq: 5, type: "user/message", text: "again, " + "x".repeat(70) }
	];
	const g1 = buildGroups(withTurn);
	assert.equal(g1.length, 2);
	assert.equal(g1[0].count, 3);
	assert.equal(g1[1].count, 2);
	assert.equal(g1[0].startSeq, 1);
	assert.equal(g1[1].summary.startsWith("again, "), true);
	assert.ok(g1[1].summary.length <= 60);

	const legacy = [
		{ seq: 1, type: "step/end" },
		{ seq: 2, type: "user/message", text: "q1" }, { seq: 3, type: "assistant/message" },
		{ seq: 4, type: "user/message", text: "q2" }
	];
	const g2 = buildGroups(legacy);
	assert.equal(g2.length, 3); // 无 turn 事件：step/end 单独成组，两个 user 消息各开一组
	assert.equal(g2[0].count, 1);
	assert.equal(g2[1].count, 2);
	assert.equal(g2[2].count, 1);
});

test("buildGroups sorts by seq ascending and keeps meta per group", () => {
	const out = buildGroups([
		{ seq: 5, type: "assistant/message", time: 500 },
		{ seq: 3, type: "turn/start", time: 100 },
		{ seq: 4, type: "user/message", time: 200, text: "order check" }
	]);
	assert.deepEqual(out.map((g) => g.startSeq), [3]);
	assert.equal(out[0].startTime, 100);
	assert.equal(out[0].events[2].time, 500);
	assert.equal(out[0].events[1].text, "order check");
	assert.equal(out[0].count, 3);
});
