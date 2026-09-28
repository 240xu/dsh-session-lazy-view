/**
 * dsh-session-lazy-view — session artifact 名单（纯函数，零依赖）。
 *
 * 已知 artifact 名：session.vN.jsonl.zstd（v4 当前，v3 历史多帧）与
 * session.jsonl.zstd（legacy 单帧）。新版本号出现时自动纳入——正则只锚定
 * "session.v数字.jsonl.zstd" 形状，帧内 header.version 由 frames.js 原样
 * 透传，不做版本校验。index.js（HTTP 路径校验/目录探测）与测试共用。
 */

/** ?path= 校验：必须以已知 artifact 名结尾（防文件探测）。 */
export function isArtifactPath(path) {
	return /(^|\/)session\.(v[0-9]+\.)?jsonl\.zstd$/.test(typeof path === "string" ? path : "");
}

/** 目录探测：entry 是否为已知 artifact 文件名。 */
export function isArtifactEntry(entry) {
	return /^session\.(v[0-9]+\.)?jsonl\.zstd$/.test(entry);
}

/** format 标注：vN-multiframe / legacy-single-frame。 */
export function artifactFormat(artifact) {
	if (/^session\.jsonl\.zstd$/.test(artifact)) return "legacy-single-frame";
	const v = artifact.match(/^session\.(v[0-9]+)\./);
	return v ? `${v[1]}-multiframe` : "unknown-multiframe";
}
