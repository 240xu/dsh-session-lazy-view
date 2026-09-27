/**
 * dsh-session-lazy-view — Timeline 纯函数（v0.3.0）。
 *
 * 时间线是帧流数据的另一种投影：按对话时间正序、按 turn 分组折叠。
 * 全部为纯数据变换，供 panel.html 与测试共用；不触 I/O，不落盘。
 */

/**
 * 解析 Go to Message 深链 `?session=<id>&seq=<n>`。
 * 无 session 参数返回 null；seq 缺失或非数字时为 null（只定位会话）。
 */
export function parseDeepLink(search) {
	const params = new URLSearchParams(search ?? "");
	const session = params.get("session");
	if (!session) return null;
	const raw = params.get("seq");
	const seq = raw === null ? NaN : Number(raw);
	return { session, seq: Number.isFinite(seq) ? seq : null };
}

/**
 * message-ops 遮蔽语义：扫描事件流里的 surfaceOp 标记（op:"replace"），
 * 把被替换区间内的 seq 标为 masked。支持两种区间表达：
 *   { op:"replace", seqs:[n,...] } 或 { op:"replace", fromSeq:a, toSeq:b }。
 * 不依赖 message-ops 端点——数据就在事件本身上；无 surfaceOp 时零改动。
 */
export function applySurfaceOps(events) {
	const masked = new Set();
	for (const ev of events) {
		const op = ev?.surfaceOp;
		if (!op || op.op !== "replace") continue;
		if (Array.isArray(op.seqs)) {
			for (const s of op.seqs) if (Number.isFinite(s)) masked.add(s);
		}
		if (Number.isFinite(op.fromSeq) && Number.isFinite(op.toSeq)) {
			for (let s = op.fromSeq; s <= op.toSeq; s++) masked.add(s);
		}
	}
	if (masked.size > 0) {
		for (const ev of events) if (masked.has(ev.seq)) ev.masked = true;
	}
	return events;
}

/**
 * 按 seq 升序分组：有 turn/start 事件时它开新组；历史格式没有 turn 事件，
 * 以 user/message 为组边界（一轮对话从用户消息开始）。
 * 组元数据：index / startSeq / startTime（组内首个有时间的事件）/ count /
 * summary（首条 user 文本前 60 字符，无则首事件文本）。
 */
export function buildGroups(events) {
	const sorted = events.slice().sort((a, b) => (a.seq ?? Infinity) - (b.seq ?? Infinity));
	const hasTurn = sorted.some((ev) => ev.type === "turn/start");
	const groups = [];
	for (const ev of sorted) {
		const boundary = ev.type === "turn/start" || (!hasTurn && ev.type === "user/message");
		if (groups.length === 0 || boundary) groups.push({ events: [] });
		groups[groups.length - 1].events.push(ev);
	}
	for (let i = 0; i < groups.length; i++) {
		const g = groups[i];
		g.index = i;
		g.startSeq = g.events[0]?.seq;
		g.startTime = g.events.find((ev) => ev.time !== void 0)?.time;
		g.count = g.events.length;
		const firstUser = g.events.find((ev) => ev.type === "user/message" && ev.text);
		g.summary = String(firstUser?.text ?? g.events[0]?.text ?? "").slice(0, 60);
	}
	return groups;
}
