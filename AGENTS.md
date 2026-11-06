# AGENTS.md

本目录是 dsh-herdr-bridge 的主开发目录：一个 DSH 插件，让 DSH Desktop 的会话成为 Herdr Core 里的一等公民。设计、取舍和已验证事实见 [README.md](README.md)，待办和已定的计划见 [TODO.md](TODO.md)；改动设计前先读这两个文件。

## 硬约束

- 不修改 DSH Desktop、Herdr Core、Herdr App、Perch 的源码；不为 Perch 做 DSH 专项适配（如需例外，用户会明确提出，见 TODO）。
- 生产架构里不引入第二份 DSH Runtime。**测试时**在隔离的 `DSH_HOME` 里跑 `dsh headless` / `dsh web` 不受此限。
- 插件对 hc 只依赖 CLI 和 OSC 7501，不直接调用 hc 的 JSON-RPC 内部细节。
- 不要动用户自己的 hc core（不 stop/restart，不在里面留下测试终端）。
- 产品原则：DSH 和其他 Herdr Agent 一样对待（信任模型、语义都和 hc 对齐）；体验优先于实现上省事；兼顾跨平台。

## 目录

| 路径 | 内容 |
|---|---|
| `index.js` | 插件入口：会话桥、控制 socket、竞争应答、`/herdr`、shellEnv、skill、重连后接回 |
| `render.js` | DSH 事件 → 终端文本（向原生 TUI 看齐）和 OSC 7501；纯函数加每个会话的少量状态 |
| `proxy.js` | `dsh-hc`：hc 终端里的薄代理（按键、尺寸、重连），也是 CLI（`new` / `attach` / `ls` / `install-template`） |
| `cordis.patch.yml` | 插件把自己插入 profile 的补丁（`package.json` 的 `dsh.bundle.patch` 指向它） |
| `scripts/mock-llm.py` | 模拟 LLM（Anthropic Messages SSE）。prompt 里的标记控制回复：`[[slow]]`/`[[slow:N]]`、`[[fail]]`、`[[approve]]`（触发提权审批）、`[[question]]`（ask_user_question）、`[[env]]`（输出 `DSH_HC_TERMINAL`） |
| `scripts/dev.sh` | 隔离开发环境：`up` / `down` / `reload` / `env` |
| `scripts/e2e.sh` | 回归测试（32 项），只通过 hc / dsh-hc 驱动 |
| `scripts/e2e-ui.sh` | UI 回归测试（12 项）：ego-browser 扮演 Desktop 用户，hc 扮演 Herdr Agent |
| `scripts/desktop.sh` | 真实 Desktop：`reload`（合并修改 `reloadToken`，第一次会备份；`DSH_PROFILE_NAME` 可选其他 profile）/ `template` / `log` |
| `ref/` | 上游源码，已 gitignore。重建：`git clone --depth 1` 这几个仓库：`deepseek-ai/deepseek-harness`、`herdrdev/herdr-core`、`herdrdev/herdr-app`、`Hariketsu/herdr-perch`。`ref/herdr-perch/.build/release/perchctl` 用 `swift build --product perchctl -c release` 编译，测试里会用到 |

## 插件形态

参照本机已安装的第三方插件 `~/.dsh/profiles/desktop/node_modules/dsh-fakeip-fetch`：

- 导出 `export const name`、可选的 `inject`，以及 `export function apply(ctx, config)`。纯 ESM，不需要构建；同目录下的模块用相对路径 import。
- 以链接方式安装时，`@deepseek-ai/*` 不一定能解析，所以本插件只用 Node 内置模块。
- **这个 cordis 版本没有可选依赖**：顶层 `inject` 里声明的都是必需服务（对象写法的值是 intercept 配置，不是 required 标志），缺任何一个，插件就一直 pending（`dsh: warning: 1 entry did not activate`）。宿主服务一律在 `ctx.inject(['x'], c => …)` 子作用域里获取，清理用 `c.effect(() => () => cleanup, '说明')`。
- web/Desktop 组合里有：`sessionController`、`workspaceRegistry`、`commands`、`shellEnv`、`skills`、`agents`、`approval`。headless 组合里没有 `sessionController` 和 `workspaceRegistry`。
- 启动器：插件加载时写出 `$DSH_HOME/herdr-bridge/bin/dsh-hc`，用 `ELECTRON_RUN_AS_NODE=1` 运行 `process.execPath`（Desktop 自带的 Node 24）和 `proxy.js`，并设置 `DSH_HERDR_SOCKET`、`DSH_HERDR_LAUNCHER`。`process.execPath` 路径里有空格，需要加引号。
- **proxy.js 的改动不需要热重载**：每个新代理都会重新读文件。但已经在运行的代理还是旧代码，所以改了协议要升 `PROTOCOL`。

## 全自动开发回路（无需人工）

```sh
scripts/dev.sh up        # 模拟 LLM + 隔离 hc core + 隔离 dsh web，插件以链接方式装好，template 已安装
# 改代码…
scripts/dev.sh reload    # 热重载，Host 不重启
scripts/e2e.sh           # hc 侧回归
scripts/e2e-ui.sh        # UI 侧回归（ego-browser）
eval "$(scripts/dev.sh env)"; hc ls; dsh-hc ls   # 手动查看隔离环境
scripts/dev.sh down
```

隔离环境的组成：`DSH_HOME=/tmp/dsh-iso/home`；隔离的 hc（`HC_SESSION=dshbridge`，`XDG_STATE_HOME` 和 `XDG_CONFIG_HOME` 指向 `/tmp/dsh-iso/xdg`）；`PATH` 前面加上隔离环境的 `dsh-hc`。

- **不要设置 `XDG_RUNTIME_DIR`**：设置后 hc 会把 socket 平铺放在 runtime 目录下，而 Perch 只扫描 `<state>/herdr-core/<session>/<session>.sock`。macOS 上本来也不设置它。
- **热重载**：修改 profile 的 `cordis.patch.yml` 里本插件的任意配置值，HMR 就会重组 profile，并替换磁盘上已变化的链接包。这个文件**必须合并修改**：web UI 和 Desktop 会往里写自己的设置（例如关掉提示框时写入 `ui-settings-general`）。它的初始内容是 `[]`，不能在后面直接追加列表项。
- **UI 自动化**（ego-browser，见 `scripts/e2e-ui.sh`）：
  - 隔离 `dsh web` 的 token URL 在 `/tmp/dsh-iso/web.log` 里。
  - `console.log` 的输出在 **stderr** 上，所以脚本输出 `RESULT:` 开头的行，shell 侧用 `2>&1 | sed` 取出。
  - `loc=role:…` 必须带 `[name…]`。输入框用 `loc=role:textbox[name*='commands, @ files']`，新会话和已有会话的输入框都能匹配。
  - 用单引号把 JS 传给 shell 函数时，JS 里不能再出现单引号。
  - 新会话的快捷键是 `Alt+Meta+n`。
  - 斜杠命令要按两次 Enter：第一次选中补全项，第二次执行。
- **驱动真实 Desktop**：Desktop 的 Web API 需要 Electron 内部的凭据，只能通过本插件的 hc 通道驱动；真实 Desktop 的 UI 无法自动化，所以 UI 侧的测试在隔离环境里做。
  ```sh
  scripts/desktop.sh reload
  cd /tmp/dsh-bridge-smoke && hc run --bg --name smokeN dsh "Reply with exactly X. No tools."
  hc wait smokeN; hc read smokeN; hc kill smokeN; hc rm smokeN
  ```
  - 用的是真实模型，提示词要求固定格式的回复，便于断言。
  - 要让回合跑久一点，就让模型执行 `sleep 25`。
  - 真实 DSH Agent 会读懂 `<hc reach=…>` 标记，并主动 `hc send` 回报给发起者。这些回报会作为 `<hc>` 消息出现在你自己的会话里，不是用户发的。
- `scripts/dev.sh env` 只影响当前 shell；操作真实环境时用一个干净的 shell（每次 Bash 调用本来就是新的 shell）。
- 从自己的 hc 终端里启动的测试终端，父终端就是自己；kill 它们时会收到 `<hc>… exited</hc>` 通知，这是正常的。

## 已观测的 DSH 行为

**事件**
- 一轮对话的事件顺序：`agent/created` → `agent/status=running` → `turn/start` → `user/message` → `agent/assistant-stream`（`start` / `chunk{text-delta}` / `end`）→ `assistant/message` → `tool/call` / `tool/result` → `turn/end{reason}` → `agent/status=idle`。
- `turn/end` 的 reason 有：`completed`、`max-tokens`、`aborted`、`blocked`、`error{error.message}`、`interrupted`（只出现在历史里）。
- `ctx.on('session/event', (session, event) => …)` 是位置参数；`agent/*` 事件是单个 payload 对象。
- 注入的运行时上下文和 system-reminder 也是 `user/message`。只有 `source.kind === 'user'` 的才是真正的用户输入；hc 发来的输入，`source.rpcId` 等于插件生成的 requestId（以 `hc-` 开头）。
- DSH 会把相邻的用户输入（比如被取消的一条加上下一条）合并成一条 user message。

**会话与 Agent**
- 正常会话的 Agent 不会因为空闲被回收；Desktop 启动或打开会话时就可能 resume 它（比第一条 prompt 早约 6 秒）。
- `sessionController.prompt` 会按需 resume Agent，所以给“冷”会话发消息不需要先加载它。
- `sessionController.list({}, signal)` 返回的条目里，标题在 `projections.values.title`。
- `sessionController.page({ address: { kind: 'session', sessionId }, maxMessages }, signal)` 的 `records` 形如 `{ type: 'event', event }`，要解包后再渲染。
- `ctx.agents.list()` / `get(id)` 返回存活的 Agent，`agent.status` 是 `idle` 或 `running`。
- 会话可以属于 Workspace（目录必须**完全相等**），也可以未分组（`sessionController.create({ cwd })`）。`workspaceRegistry.create(path)` 是幂等的；`list()` 返回 `{ id, path }`。
- 斜杠命令：`ctx.commands.register({ name, description, handler: async ({ agent, rawInput }) => ({ kind: 'success' | 'error', text }) })`。

**审批与提问**
- 两者都是 waterfall，每个请求只有一个最终应答方。Desktop 自带的应答方先注册，而且不调用 `next()`，所以插件必须用 `{ prepend: true }`。根 ctx 上的监听器能收到所有 Agent 的请求，`req.agent` 就是完整的 Agent。
- **撤回机制**：转发器（`api/remotes`）把请求交给 gateway，gateway 监听 `request.signal`，abort 时调用 `cancelRemoteEvent`，撤回 UI 上的对话框。请求对象没有被冻结，链上传的是同一个对象，所以替换 `req.signal` 对下游生效。
- 没有 UI 客户端时，转发的审批会一直挂着等待；headless 没有应答方，会立刻得到 `unavailable`。
- 审批的结果是 `'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`；提问的回答是 `{ answers: [{ id, selected: [label…], custom? }] }`。
- bash 工具要求必填参数 `description`。提权流程是：先被沙箱拒绝，同一轮里再带 `sandbox_permissions` 和 `justification` 重试同一条命令，这次才会触发审批。

**环境与安装**
- shell-env 只允许注入 `DSH_*` 变量，变量描述不进入模型上下文；要让模型知道，用 `ctx.skills.register({ name, description, whenToUse, source: 'runtime', content })`。DSH 会自动发现 `~/.agents/skills`。
- Desktop Host 进程用的是登录 shell 的 PATH（含 `~/.local/bin`）；Desktop 会话默认是 `workspace-write` 沙箱，`hc` 在其中可以正常使用。
- 装或卸 Desktop 插件要先完全退出 Desktop；`dsh --profile desktop --dump-config` 会被拒绝。
- 用户在 UI 里改设置会写入 `cordis.patch.yml`，从而触发 profile 重组，插件随之重载。代理的重连就是为此设计的。
- 会话日志在 `$DSH_HOME/sessions/<目录编码>/<session>/session.v4.jsonl.zstd`，用 `zstd -dc` 读。

## 已观测的 hc 行为

- `hc send` 送来的是 `ESC[200~文本ESC[201~` 加 `\r`；`hc interrupt` 送来的是单独一个 `ESC`。
- 程序处于 blocked 时，hc 自己会拒绝普通 `send`，加 `--force` 才会送达。
- 手动设置的 `HC_TERMINAL_ID` **不会**被当作调用方；要指定父终端，用 `hc run --parent <t>`。hc 运行的程序的环境里有 `HC_TERMINAL_ID`。
- 终端名只能在创建时设置（`[a-z0-9-_]`，最多 32 个字符，在存活终端里唯一）；标签可以随时用 `hc label` 修改。
- `hc ls --json` 不带 labels；`agent` 字段是 7501 里报的 `app`。
- 终端退出时，`hc events` 会发一个 `status: null` 的事件；标题变化也会产生一个状态值相同的 status 事件。
- Perch 取行标题的顺序是：终端名 → 7501 的 title → 终端标题。
- hc 选项必须写在命令之前（`hc run --bg --json --name x cmd …`），否则会被当成命令的参数。
- 内存要看 `footprint -p <pid>`：Electron/Node 的 RSS 约 40–50 MB，其中大部分是共享代码，实际物理占用约 13 MB。

## 本机环境的坑

- 在 zsh 里**不要用 `path` 作变量名**，它和 `PATH` 是绑定的。
- PATH 里可能有带空格的目录：生成 `export PATH=…` 时要加引号，并延迟展开 `$PATH`。
- macOS 没有 `timeout` 命令；`date +%N` 不可用。
- 在 Bash 工具里启动后台进程时，必须把它的 stdout/stderr 重定向走，否则它会占着管道，命令永远不会结束。
- 跑 Python 用 `python3 -I`；用到第三方依赖时用 `uv run`。

## 收尾

- `scripts/dev.sh down`（会停掉隔离 hc core、`dsh web` 和 `mock-llm.py`）。
- ego-browser 的 task space 用完后调用 `finish({ keep: [] })`。
- 删掉不再需要的临时目录（`/tmp/dsh-iso` 可以保留给下次用）。
