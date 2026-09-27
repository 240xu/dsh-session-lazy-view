# @240xu/dsh-session-lazy-view

> **怎么打开**：安装后访问 **`http://<dsh-web-地址>/lazyview`** 即是独立面板页；
> DSH 宿主侧边栏没有本插件入口是**有意设计**（纯只读工具，不污染主界面）。
> 装了 dsh-devkit 的话，**Ctrl+K** 命令面板里有「打开」入口（devkit 侧接线）。

DSH web 插件：**会话惰性查看器**（纯只读）。列出 `~/.dsh/sessions` 下全部会话（只 stat 不解压），
并可只解压任意会话文件的**最后 1–2 个 zstd 帧**快速查看最近发生的事件，不碰整份文件。

不做删除、不做归档、不是 Trajectory 替代品；对 `~/.dsh/sessions` 零写入。

## 原理

`session.v3.jsonl.zstd` 是**连续多帧**的独立 zstd 帧（魔数 `0x28 B5 2F FD`）：
帧 0 恰好一行 session header JSON；之后每帧一批 newline-delimited JSON 事件，
最后一帧结束于 EOF。因此从文件尾部读一个窗口、扫帧魔数、只解压候选帧，
即可拿到最近事件，成本与文件总大小无关（旧格式 `session.jsonl.zstd`
为单帧，等效于解压整份，但同样走这条路径）。

## 安装

零 npm 依赖（只用 `node:fs` / `node:zlib` / `node:path` / `node:url`；
`@deepseek-ai/schemastery` 由 DSH profile 树自带，无需安装）。

```bash
# 方式 A（推荐）：DSH 官方插件命令（内部走 pnpm，正确登记 lockfile 与 bundles）
dsh plugin --profile web add @240xu/dsh-session-lazy-view

# 方式 B：npm pack 直解（profile 是 pnpm workspace，不要在 profile 内直接 npm i ——
# workspace 根的 link:/ 依赖会让 npm 报 EUNSUPPORTEDPROTOCOL）
cd ~/.dsh/profiles/web/node_modules
npm pack @240xu/dsh-session-lazy-view
mkdir -p @240xu/dsh-session-lazy-view
tar -xzf 240xu-dsh-session-lazy-view-*.tgz -C @240xu/dsh-session-lazy-view --strip-components=1
# 然后把 "@240xu/dsh-session-lazy-view" 加进 profile package.json 的
# dsh.profile.bundles 列表（lockfile/package-map 不一致时 pnpm install 会补齐）

# 方式 C：从源码拷贝（开发）
git clone https://github.com/240xu/dsh-session-lazy-view && cp -r dsh-session-lazy-view ~/.dsh/profiles/web/node_modules/
```

然后在 DSH web profile 的 `cordis.patch.yml` 里挂载（写法与
`dsh-archived-sessions` 完全一致）。若该文件已存在其它 `- insert:` 条目，
把下面 `- id:` 两行并入现有列表即可：

```yaml
- insert:
    - id: dsh-session-lazy-view
      name: '@240xu/dsh-session-lazy-view'
```

重启 DSH web 实例后生效。

## 端点

前缀 `/lazyview`（受与 archived-sessions 相同的 loopback / same-origin 信任门保护）：

| 端点 | 说明 |
|---|---|
| `GET /lazyview` | HTML 面板：按项目分组列出会话，>10MB 标红，每行 tail 按钮展开最近 2 帧，支持“上一页” |
| `GET /lazyview/api/list` | JSON：`{root, projects:[{project, sessions:[{sessionId, path, artifact, format, bytes, mtime, big}]}]}`，纯 stat |
| `GET /lazyview/api/tail?path=<相对路径>&frames=2&skip=0` | JSON：从尾部解压 `frames` 帧；`skip` 为翻页偏移（跳过最新 skip 帧后再取 frames 帧）。帧内事件已文本化（role + 截断到 2000 字符的 text / tool-call / tool-result） |

`path` 必须是 `/api/list` 返回的 `path`（相对 sessions 根，且必须以
`session.v3.jsonl.zstd` 或 `session.jsonl.zstd` 结尾）；路径逃逸检查在服务端。

解析失败（坏帧、旧格式、窗口截断等）一律返回
`{ok:false, error:{code, message}}` 结构化错误，不会 500 崩面板。

## 已知限制

- 旧格式 `session.jsonl.zstd` 单帧等于整份文件，tail 读取没有惰性收益。
- 尾部窗口默认 1MB，最多增长到 64MB；极端情况下（单帧超过 64MB）返回
  `truncatedScan: true` 且可能少帧，不会死循环。
- 帧魔数理论上可能出现在压缩数据内部造成假候选；假候选解压失败后以
  per-frame `error` 呈现，不影响其余帧。
- 事件文本化只覆盖已验证的形状（user/assistant/system message、tool call/result），
  其余事件类型输出紧凑 JSON 摘要。
- 未做缓存：每次 tail 请求都重新读窗口，对调试场景足够。

## 离线验证

```bash
./verify.sh
```

用 node 直接 import `./lib/frames.js`，对 `~/.dsh/sessions` 下任一
`.zstd` 会话执行“读最后 2 帧”，打印事件条数与首条 role。

## v0.2.0 新增

**仍然是纯只读**：全部新功能对 `~/.dsh/sessions` 零写入（不缓存、不落盘），
依旧不删除、不归档、不碰任何侧边栏注册面——所有能力都挂在自己的
`/lazyview/*` HTTP 端点与 panel.html 面板里。

| 端点 | 说明 |
|---|---|
| `GET /lazyview/api/search?path=&q=&max=20` | 会话内全文搜索：流式逐帧解压做大小写不敏感子串匹配，命中返回 `{frameIndex, seq, type, role, snippet}`（命中点前后各 60 字符窗口）。达 `max` 截断；默认最多扫 500 帧，未扫完返回 `partial:true`。每帧之间 `setImmediate` 让出事件循环，客户端断开（AbortSignal）即中止扫描 |
| `GET /lazyview/api/stats?path=[&fast=1]` | 会话统计：帧数、总事件数、按 type 分组计数、首/末事件时间、文件字节数、session header。`fast=1` 只流式扫描帧魔数（不解压、内存有界）给帧数/字节数 |
| `GET /lazyview/api/export?path=&frames=N` | 把最近 N 帧（≤20）导出为 Markdown 文本下载（`Content-Disposition: attachment`）。文本在内存中生成直接响应，不写任何文件 |

面板集成：每个会话行新增「搜索」按钮（展开输入框 + 命中结果列表，命中
标注帧号/seq/type/片段，新搜索自动取消上一次）；打开会话顶部新增「统计」
小节（先展示 fast 帧数/字节，按钮展开全量解压统计）与「导出 md」下载链接。

测试：`node --test test/`（零依赖，用 `node:zlib` 自造多帧 fixture，
覆盖搜索命中/截断/abort、stats 分组、export 渲染）。

性能取舍说明：

- 解压是同步的（`zstdDecompressSync`），全量扫描在帧与帧之间用
  `setImmediate` 让出事件循环（参照 dsh-src `ZSTD_DECODE_YIELD_INTERVAL_MS`
  思路），单个大文件的搜索/统计不会长时间阻塞 web server；但**一次请求
  内整份文件会被读进内存**（read-only，读完即释放），超大文件请优先
  `?fast=1` 或改用 tail。
- 搜索只覆盖事件文本化后的可见文本（`describeEvent`，单条截断到 2000
  字符）；无法文本化的行仍按原文参与匹配。
- 全量统计对大文件是秒级操作（每帧解压一次）；面板默认只拉 fast 统计，
  全量按需展开。

## v0.2.1 评审修复

- **可发现性（P0）**：README 与面板页顶部均加显著说明——面板是 `/lazyview`
  独立页，宿主侧边栏无入口是有意设计（纯只读工具）；面板页新增
  「复制面板链接」按钮；README 注明装了 dsh-devkit 可用 Ctrl+K 打开。
- **S1（P1）**：360px 表格溢出修复——session id 列截断省略（`title` 悬停看全），
  mtime 列在 ≤480px 隐藏（`hide-sm`）。
- **S2（P2）**：全部按钮触控目标提升到 ≥44×44px。
- **S3（P2）**：统计小节预留固定高度占位（fast→full 替换前锁定高度），防 CLS。
- **S5（P3）**：`#status` 加 `role="status" aria-live="polite"`，读屏可闻。
