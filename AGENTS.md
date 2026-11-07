# AGENTS.md

dsh-herdr-bridge 是一个 DSH 插件，把 DSH（Desktop 和 `dsh web`）的会话接进 Herdr Core（`hc`）。

本机如果有 `AGENTS.local.md`（已 gitignore），一并读取：里面是这台机器的环境和用户的长期授权。

## 按任务读文档

| 要改的东西 | 先读 |
|---|---|
| 用户可见的行为、安装、配置 | [README.md](README.md)（英文，默认）和 [README.zh-CN.md](README.zh-CN.md) |
| 架构、状态映射、竞争应答、重连 | [docs/architecture.md](docs/architecture.md)，其中“否决的方案”避免重走老路 |
| 和 DSH / hc / Herdr App 交互的代码 | [docs/upstream-notes.md](docs/upstream-notes.md)；与实际不符时以 `ref/` 里的上游源码和测试结果为准，并更新记录 |
| 测试、开发环境、真实 Desktop 冒烟、README 配图 | [docs/development.md](docs/development.md) |
| 计划、已知问题、待验证路径 | [TODO.md](TODO.md) |

## 不变量

- 不修改 DSH、Herdr Core、Herdr App 的源码。
- 生产架构里不引入第二份 DSH Runtime。测试时在隔离的 `DSH_HOME` 里跑 `dsh headless` / `dsh web` 不受此限。
- 对 hc 只依赖 CLI 和 OSC 7501，不直接调用 hc 的 JSON-RPC。
- DSH 和其他 Herdr Agent 一样对待：信任模型和语义都和 hc 对齐（`--force` 是唯一的闸门，插件不自动回答审批）。体验优先于实现上省事；兼顾跨平台。
- 插件只用 Node 内置模块，纯 ESM，不需要构建。
- 宿主服务一律在 `ctx.inject(['x'], c => …)` 子作用域里获取：这个 cordis 版本没有可选依赖，顶层 `inject` 缺一个服务，插件就一直 pending。
- 改了插件和代理之间的协议，要升 `PROTOCOL`，并确认旧代理会得到明确的版本错误、重连仍然正常。

## 用户的真实环境

隔离环境（`scripts/dev.sh`、`/tmp/dsh-iso`）里的操作可以直接做。下面这些会影响用户的真实环境，需要本次任务的授权（或 `AGENTS.local.md` 里的长期授权）：

- 修改真实 profile（`~/.dsh/profiles/*/`），包括 `scripts/desktop.sh reload`。
- 用真实模型跑冒烟测试。
- 在用户自己的 hc core 里创建终端。用完要 kill 并 rm。

无论有没有授权，都不要 stop 或 restart 用户自己的 hc core。

## 代码

| 路径 | 内容 |
|---|---|
| `index.js` | 插件入口：会话桥、控制 socket、竞争应答、`/herdr`、shellEnv、skill、重连后接回 |
| `render.js` | DSH 事件 → 终端文本和 OSC 7501；纯函数加每个会话的少量状态 |
| `proxy.js` | `dsh-hc`：hc 终端里的薄代理（按键、尺寸、重连），也是 CLI（`new` / `attach` / `ls` / `install-template`） |
| `cordis.patch.yml` | 插件把自己插入 profile 的补丁 |
| `scripts/` | `dev.sh` 隔离环境、`e2e.sh` / `e2e-ui.sh` 回归、`desktop.sh` 真实 Desktop、`mock-llm.py` 模拟 LLM |

## 验证

```sh
scripts/dev.sh up && scripts/e2e.sh && scripts/e2e-ui.sh; scripts/dev.sh down
```

- 改了行为就跑受影响的回归；改了审批、提问或 UI 侧的行为要跑 `e2e-ui.sh`。
- 隔离环境通过不等于真实 Desktop 通过。真实 Desktop 上没验证的，在汇报里说明。

## 收尾

- 汇报跑了哪些测试、结果如何、哪些路径没验证。测试没跑，说明原因。
- 用户可见的行为变了，同时更新两份 README（英文和中文内容保持一致）；设计变了，更新 architecture.md；发现上游行为和记录不符，更新 upstream-notes.md；留下的问题记进 TODO.md。
- 只改任务需要的部分；看到范围外的问题，记下来或告诉用户，不要顺手改。
- 停掉隔离环境（`scripts/dev.sh down`），ego-browser 的 task space 调用 `finish({ keep: [] })`，删掉不再需要的临时目录。
