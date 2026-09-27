# lazy-view Timeline 视图设计（v0.3.0 预研，只设计不实现）

> 作者：lazyview-innovator · 2026-09 · 参照 vscode Timeline（v1.44）与 message-ops 遮蔽语义。
> 铁律不变：纯只读、零侧边栏注册、只动 /lazyview/* 与 panel.html。

## 屏 1 · 时间线视图入口

panel.html 会话打开视图顶部（topbar「统计」「导出 md」旁）加第三个模式按钮
**「时间线」**。点击后该会话 `.tail` 容器切换为时间线渲染（与现有帧流互斥，
避免双份 DOM）。时间线不替代帧流，是同一数据的另一种投影：帧流按存储批次
组织（调试图），时间线按对话时间组织（阅读图）。

## 屏 2 · 时间轴渲染（按时间正序、按 turn 分组折叠）

- 事件按 `seq` 升序（seq 缺失时按 time、再按帧内行序兜底）。
- 按 turn 分组：`turn/start` 事件开新组；无 turn 事件的历史格式以连续的
  user/message 为组边界（user 消息开启一轮）。组头显示 turn 序号、首事件
  时间、事件数。
- 组默认折叠只留一行摘要（首条 user 文本前 60 字符）；展开渲染组内全部
  事件（复用 renderFrame 的事件条 .ev 样式）。折叠状态存内存（Map<groupSeq>），
  不落盘。
- 顶部同屏显示首末事件时间与总事件数（数据来自 /api/stats 全量）。

## 屏 3 · Go to Message 深链协议

`?session=<sessionId>&seq=<n>`：打开面板后自动定位该会话并滚动到 seq≥n
的第一个事件，展开其所在 turn 组并高亮。实现要点：

- 面板加载时读 location.search；session id 即 /api/list 的 sessionId 字段。
- 定位基于「事件条渲染时写 data-seq 属性」——渲染层已有，只需补写。
- 复制入口：每个事件条 hover 显示「⧉ 链接」小按钮，点击写入剪贴板
  `?session=..&seq=..`（复用 v0.2.1 复制面板链接的降级策略）。
- message-ops 联动（见屏 5）可复用同一深链。

## 屏 4 · 数据源评估：现有端点够不够

**结论：需要一个新的轻量端点，现有 tail 不够。**

- `/api/tail` 从文件尾倒数、按存储帧分页（index 0=最新），没有全量正序
  视角；翻到文件头要 O(N) 次 skip 分页，且无 turn 边界信息。
- `/api/stats` 全量解压一次，但只返回计数，不返回事件。
- **新端点 `GET /lazyview/api/timeline?path=&from=0&limit=200`**：正序流式
  解压（复用 frames.js `forEachFrame`，帧间 setImmediate 让出 + AbortSignal），
  跳过 frame 0 header，输出扁平事件数组
  `{seq,time,type,role,kind,text(截断2000),turnIndex}`；`from/limit` 用
  游标分页（响应带 `nextFrom`、`exhausted`）。只读语义不变。
- 可选优化：`?compact=1` 只返回 turn 边界 + 每组首事件，供折叠首屏。

## 屏 5 · 与 message-ops 遮蔽语义的可见性标注整合

message-ops 的回滚/删除会改写会话可见状态；时间线需要如实标注而不是隐藏：

- 事件条右侧加 `masked` 徽标（灰斜体「已被后续操作遮蔽」），数据来源为
  message-ops 的可见性查询（若其暴露端点；没有则 v0.3.0 先留接口位，
  面板 fetch 失败静默降级为无标注——时间线永不因外部服务缺失而挂）。
- 被遮蔽事件**仍渲染**（只读工具不代替 message-ops 决定可见性），仅标注。
- 深链定位到被遮蔽事件时同样高亮 + 徽标，保证「Go to Message」语义完整。
- 归属边界：遮蔽判定 100% 来自 message-ops，lazy-view 只消费不缓存。

## 风险与不做的事

- 大会话时间线仍走「按需分页 + 折叠」，不做一次性全量渲染（无虚拟化库）。
- 不做编辑、不做删除入口——时间线是纯阅读投影。
- turn 边界启发式对旧格式（无 turn 事件）有误分组可能，文档标注即可。
