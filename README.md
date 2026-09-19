# @240xu/dsh-session-lazy-view

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
# 方式 A：npm 安装（装进 profile 树，schemastery 由 profile 自带）
cd ~/.dsh/profiles/web/node_modules && npm i @240xu/dsh-session-lazy-view

# 方式 B：从源码拷贝
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
