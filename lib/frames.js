/**
 * dsh-session-lazy-view — zstd multi-frame session file reader (pure, no I/O).
 *
 * Session artifact layout (verified against dsh 0.1.5-rc.2):
 *   - session.v3.jsonl.zstd: a SEQUENCE of independent zstd frames
 *     (magic 0x28B52FFD each). Frame 0 holds exactly one JSON header line
 *     {"type":"session",...} + "\n"; every later frame holds a batch of
 *     newline-delimited JSON events. Frames are contiguous: frame i ends
 *     where frame i+1's magic starts, and the last frame ends at EOF.
 *   - session.jsonl.zstd (legacy): a single zstd frame of the whole file;
 *     the generic scanner below handles it as "one frame at offset 0".
 *
 * The magic quad can in principle appear inside compressed payload bytes,
 * so every candidate frame start is validated by actually decompressing;
 * failed candidates are reported per-frame instead of failing the whole
 * read (a corrupted batch must not 500 the panel).
 */
import { open } from "node:fs/promises";
import { zstdDecompressSync } from "node:zlib";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
/** Text extracted per event is truncated to keep panel payloads bounded. */
export const TEXT_LIMIT = 2000;
/** Initial tail window for the backward frame scan; grows on demand. */
const TAIL_WINDOW = 1 << 20;
const TAIL_WINDOW_MAX = 64 << 20;

/**
 * Scan `buf` (offset `from`..`to`) for zstd frame-magic starts. This is a
 * candidate list only — validation happens in decompressFrame.
 */
export function scanFrameOffsets(buf, from = 0, to = buf.length) {
	const offsets = [];
	const last = Math.min(to, buf.length) - MAGIC.length;
	for (let i = Math.max(0, from); i <= last; i++) {
		if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) offsets.push(i);
	}
	return offsets;
}

/** Decompress one candidate frame [start, end); returns the plaintext Buffer. */
export function decompressFrame(buf, start, end) {
	// node:zlib zstdDecompressSync needs the full frame; a wrong boundary
	// (magic false positive mid-stream) surfaces here as a throw.
	return zstdDecompressSync(buf.subarray(start, end));
}

/**
 * Decompress every candidate frame in the window, returning
 * [{start, end, text | error}]. A failed candidate stays in the list with
 * `error` set so the caller can distinguish "bad frame" from "no frames".
 */
export function decompressAllFrames(buf, offsets) {
	const frames = [];
	for (let i = 0; i < offsets.length; i++) {
		const start = offsets[i];
		const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length;
		try {
			frames.push({ start, end, text: decompressFrame(buf, start, end).toString("utf8") });
		} catch (error) {
			frames.push({ start, end, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return frames;
}

/**
 * Read the last `count` frames of a session artifact without decompressing
 * the whole file: reads a tail window, scans it for frame magics, and
 * decompresses only candidates inside the window. If the window start cuts
 * a frame in half (its decompress fails and it sits at the window edge),
 * the window is doubled and the scan retried, up to TAIL_WINDOW_MAX.
 *
 * `skip` drops the newest `skip` successful frames first — that is the
 * pagination primitive: frames=2&skip=0 is page one, frames=2&skip=2 the
 * page before it, so the caller never needs byte offsets at all.
 *
 * Returns { size, frames: [{ index, start, end, events | error, header? }] }
 * where `index` counts from the END of the file (0 = newest).
 */
export async function readTailFrames(filePath, count = 2, skip = 0) {
	const handle = await open(filePath, "r");
	try {
		const { size } = await handle.stat();
		let window = Math.min(size, Math.max(TAIL_WINDOW, count * (256 << 10)));
		for (;;) {
			const from = Math.max(0, size - window);
			const buf = Buffer.alloc(size - from);
			await handle.read(buf, 0, buf.length, from);
			const offsets = scanFrameOffsets(buf);
			const candidates = decompressAllFrames(buf, offsets).map((frame) => ({
				...frame,
				// absolute file offset, so pagination UI can show real positions
				absStart: from + frame.start,
				absEnd: from + frame.end
			}));
			// Only frames that decompressed cleanly count as readable; a candidate
			// at the very window edge that failed is likely truncated by the window.
			const ok = candidates.filter((frame) => frame.text !== void 0);
			const edgeTruncated = candidates.some((frame) => frame.text === void 0 && frame.start === 0 && from > 0);
			if (ok.length >= count + skip && !edgeTruncated) {
				const picked = ok.slice(-(count + skip), ok.length - skip).reverse();
				return {
					size,
					frames: picked.map((frame, i) => ({ index: skip + i, ...describeFrame(frame) }))
				};
			}
			if (window >= size || window >= TAIL_WINDOW_MAX) {
				// Whole file scanned (or cap hit): report what we have, newest first.
				const picked = ok.slice(-(count + skip), ok.length - skip).reverse();
				return {
					size,
					frames: picked.map((frame, i) => ({ index: skip + i, ...describeFrame(frame) })),
					truncatedScan: window >= TAIL_WINDOW_MAX && window < size
				};
			}
			window = Math.min(window * 4, TAIL_WINDOW_MAX, size);
		}
	} finally {
		await handle.close();
	}
}

/** Parse a decompressed frame into header/events metadata + text entries. */
function describeFrame(frame) {
	if (frame.text === void 0) return { start: frame.absStart, end: frame.absEnd, error: frame.error };
	const lines = frame.text.split("\n").filter((line) => line.trim() !== "");
	const events = [];
	let header;
	for (const line of lines) {
		let json;
		try {
			json = JSON.parse(line);
		} catch {
			events.push({ type: "<unparsable>", text: line.slice(0, 200) });
			continue;
		}
		if (json.type === "session") {
			header = { id: json.id, version: json.version, cwd: json.cwd, createdAt: json.createdAt };
			continue;
		}
		events.push(...describeEvent(json));
	}
	return { start: frame.absStart, end: frame.absEnd, header, events };
}

/**
 * Textualize one event: role + text, each entry capped at TEXT_LIMIT chars.
 * Shapes verified in 0.1.5-rc.2 artifacts:
 *   user/message    data.role + data.content[{type:"text",text}]
 *   assistant/message / system/message   data.message.role + data.message.content
 *     (content items: text | tool-call {name, arguments})
 *   tool/result     data.message.content[{type:"tool-result",...}]
 * Unknown types fall back to a compact JSON dump so nothing disappears
 * silently from the preview.
 */
export function describeEvent(json) {
	const type = typeof json.type === "string" ? json.type : "<unknown>";
	const seq = typeof json.seq === "number" ? json.seq : void 0;
	const time = typeof json.time === "number" ? json.time : void 0;
	const base = { type, seq, time };
	const message = json.data?.message;
	const content = message?.content ?? json.data?.content;
	const role = message?.role ?? json.data?.role;
	if (Array.isArray(content)) {
		const entries = [];
		for (const item of content) {
			if (item?.type === "text" && typeof item.text === "string") {
				entries.push({ ...base, role: role ?? "unknown", kind: "text", text: clip(item.text) });
			} else if (item?.type === "tool-call") {
				entries.push({ ...base, role: role ?? "assistant", kind: "tool-call", text: clip(`${item.name ?? "?"} ${item.arguments ?? ""}`) });
			} else if (item?.type === "tool-result") {
				entries.push({ ...base, role: "tool", kind: "tool-result", text: clip(typeof item.content === "string" ? item.content : JSON.stringify(item.content ?? item)) });
			} else {
				entries.push({ ...base, role: role ?? "unknown", kind: item?.type ?? "unknown", text: clip(JSON.stringify(item)) });
			}
		}
		if (entries.length > 0) return entries;
	}
	// Non-message events (turn/start, step/end, compaction/*, ...) render as
	// one compact line so the frame still reads as a timeline.
	return [{ ...base, role: role ?? "event", kind: "raw", text: clip(JSON.stringify(json.data ?? {})) }];
}

function clip(text) {
	return typeof text === "string" && text.length > TEXT_LIMIT ? text.slice(0, TEXT_LIMIT) + `…(+${text.length - TEXT_LIMIT} chars)` : String(text ?? "");
}
