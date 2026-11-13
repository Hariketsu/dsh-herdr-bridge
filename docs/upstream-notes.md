# 上游接口观测记录

开发中通过读上游源码和实测得到的 DSH、hc 行为。这些**不是稳定 API**，只在下面的版本上观测过：

| 项目 | 观测时的版本 |
|---|---|
| DSH（Desktop / `dsh web`） | 0.2.2-rc.2 |
| herdr-core | 0.1.18 |
| herdr-app | 0.1.13 |

记录和实际行为不符时，以当前上游源码（`ref/`）和测试结果为准，并更新这里。

## DSH 插件宿主

- 插件形态参照第三方插件 `dsh-fakeip-fetch`：导出 `export const name`、可选的 `inject`，以及 `export function apply(ctx, config)`。纯 ESM，不需要构建。
- 以链接方式安装时，`@deepseek-ai/*` 不一定能解析，所以本插件只用 Node 内置模块。
- **这个 cordis 版本没有可选依赖**：顶层 `inject` 里声明的都是必需服务（对象写法的值是 intercept 配置，不是 required 标志），缺任何一个，插件就一直 pending（`dsh: warning: 1 entry did not activate`）。宿主服务一律在 `ctx.inject(['x'], c => …)` 子作用域里获取，清理用 `c.effect(() => () => cleanup, '说明')`。
- web/Desktop 组合里有：`sessionController`、`workspaceRegistry`、`commands`、`shellEnv`、`skills`、`agents`、`approval`。headless 组合里没有 `sessionController` 和 `workspaceRegistry`。
- Desktop 上 `process.execPath` 是 Electron（自带 Node 24），要用 `ELECTRON_RUN_AS_NODE=1` 运行；路径里有空格，需要加引号。
- 修改 profile 的 `cordis.patch.yml` 里本插件的任意配置值，HMR 就会重组 profile，并替换磁盘上已变化的链接包。web UI 和 Desktop 会往这个文件里写自己的设置（例如关掉提示框时写入 `ui-settings-general`），所以用户在 UI 里改设置也会让插件重载。文件初始内容是 `[]`。
- 装或卸 Desktop 插件要先完全退出 Desktop；`dsh --profile desktop --dump-config` 会被拒绝。
- Desktop 的 Web API 需要 Electron 内部的凭据，外部程序无法直接调用。

## DSH 事件

- 一轮对话的事件顺序：`agent/created` → `agent/status=running` → `turn/start` → `user/message` → `agent/assistant-stream`（`start` / `chunk{text-delta}` / `end`）→ `assistant/message` → `tool/call` / `tool/result` → `turn/end{reason}` → `agent/status=idle`。
- `turn/end` 的 reason 有：`completed`、`max-tokens`、`aborted`、`blocked`、`error{error.message}`、`interrupted`（只出现在历史里）。
- `ctx.on('session/event', (session, event) => …)` 是位置参数；`agent/*` 事件是单个 payload 对象。
- 注入的运行时上下文和 system-reminder 也是 `user/message`。只有 `source.kind === 'user'` 的才是真正的用户输入；hc 发来的输入，`source.rpcId` 等于插件生成的 requestId（以 `hc-` 开头）。
- DSH 会把相邻的用户输入（比如被取消的一条加上下一条）合并成一条 user message。

## DSH 会话与 Agent

- 正常会话的 Agent 不会因为空闲被回收；Desktop 启动或打开会话时就可能 resume 它（比第一条 prompt 早约 6 秒）。
- `sessionController.prompt` 会按需 resume Agent，所以给“冷”会话发消息不需要先加载它。
- `sessionController.prompt` 的 `mode`：`queue` 放进下一回合（DSH 界面里直接按 Enter）；`steer` 在运行中回合的下一步交给模型，不中断回合（界面里的 Cmd/Ctrl+Enter 插话），Agent 空闲时直接开一个回合（`dsh-agent` 的 `steer()` 注释）。
- 0.2.2-rc.2 起，`sessionController.prompt` 的 `content` 可以是空数组：只在会话空闲且最近一个回合失败时有效，作用是“继续生成”（Desktop 的“继续生成”按钮），对应的 user message 是 `source.kind === 'retry'`。含空白文本的 content 仍被拒绝。
- `sessionController.list({}, signal)` 返回的条目里，标题在 `projections.values.title`。
- `sessionController.page({ address: { kind: 'session', sessionId }, maxMessages }, signal)` 的 `records` 形如 `{ type: 'event', event }`，要解包后再渲染。
- `ctx.agents.list()` / `get(id)` 返回存活的 Agent，`agent.status` 是 `idle` 或 `running`。
- 会话可以属于 Workspace（目录必须**完全相等**），也可以未分组（`sessionController.create({ cwd })`）。`workspaceRegistry.create(path)` 是幂等的；`list()` 返回 `{ id, path }`。
- 斜杠命令：`ctx.commands.register({ name, description, handler: async ({ agent, rawInput }) => ({ kind: 'success' | 'error', text }) })`。
- 归档：`workspaceRegistry.archiveSession` 写入持久存储后，emit `domain/changed`（`domain: 'workspace'`，`table: ''`，`operation: 'put'`，`value.archivedSessionIds` 是新的归档集合）。这时 `workspaceRegistry.archivedSessionIds` 还是旧值，要读事件里的 `value`。归档一个空闲会话不会释放它的 Agent（没有 `agent/disposed`）。
- 宿主端插件可以用 `ctx.connection.fetch.register({ path: '/api/…', methods: ['GET'|'HEAD'|'POST'], requestBody: 'buffered', fetch })` 注册精确路由，注册属于调用者的 fiber；只有 owner 的浏览器能访问，其他 peer 得到 403。浏览器端直接 `fetch('api/…')`（相对路径）。参考 `session-log-export`。
- 浏览器端 `ctx.sessions.list.getSnapshot().byId[id].retainedBy.mainView > 0` 表示这个会话在主视图里；保留计数变化时 list 会通知订阅者。DSH 自己的完成提醒（`ui-session` 的 `completionUnread`）也以此为准，状态只在浏览器进程里。
- 会话日志在 `$DSH_HOME/sessions/<目录编码>/<session>/session.v4.jsonl.zstd`，用 `zstd -dc` 读。

## DSH 审批与提问

- 两者都是 waterfall，每个请求只有一个最终应答方。Desktop 自带的应答方先注册，而且不调用 `next()`，所以插件必须用 `{ prepend: true }`。根 ctx 上的监听器能收到所有 Agent 的请求，`req.agent` 就是完整的 Agent。
- **撤回机制**：转发器（`api/remotes`）把请求交给 gateway，gateway 监听 `request.signal`，abort 时调用 `cancelRemoteEvent`，撤回 UI 上的对话框。请求对象没有被冻结，链上传的是同一个对象，所以替换 `req.signal` 对下游生效。
- 子 Agent（`header.origin === 'subagent'`，包括 AgentTeam 成员）不会发起审批或提问：它的审批策略固定为 `never`，需要审批的操作直接被拒（`subagent/child-agent.ts`）；`user-questions` 对 subagent 来源抛 `DELEGATED_CALLER`。嵌套多层也一样（0.2.2-rc.2）。所以审批和提问只来自顶层会话。
- 没有 UI 客户端时，转发的审批会一直挂着等待；headless 没有应答方，会立刻得到 `unavailable`。
- 审批的结果是 `'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`；提问的回答是 `{ answers: [{ id, selected: [label…], custom? }] }`。
- bash 工具要求必填参数 `description`。提权流程是：先被沙箱拒绝，同一轮里再带 `sandbox_permissions` 和 `justification` 重试同一条命令，这次才会触发审批。

## DSH 环境

- shell-env 只允许注入 `DSH_*` 变量，变量描述不进入模型上下文；要让模型知道，用 `ctx.skills.register({ name, description, whenToUse, source: 'runtime', content })`。DSH 会自动发现 `~/.agents/skills`。
- 0.2.2-rc.2 起 DSH 自己往 bash 环境里注入保留变量 `DSH_INSTALL_DIR`、`DSH_NODE_EXECUTABLE`，插件不能再注册同名变量。
- 侧栏里的 Agent 终端（`dsh-experimental-terminal-bundle` 的持久终端，默认的 Desktop profile 里没有）不经过 shellEnv，只带 `DSH_SESSION_ID` 和工具配置里的变量，因此拿不到 `DSH_HC_TERMINAL`。
- Desktop Host 进程用的是登录 shell 的 PATH（含 `~/.local/bin`）；Desktop 会话默认是 `workspace-write` 沙箱，`hc` 在其中可以正常使用。
- 真实 DSH Agent 会读懂 `<hc reach=…>` 标记，并主动 `hc send` 回报给发起者。

## hc

- `hc send` 送来的是 `ESC[200~文本ESC[201~` 加 `\r`；`hc interrupt` 送来的是单独一个 `ESC`。
- 程序处于 blocked 时，hc 自己会拒绝普通 `send`，加 `--force` 才会送达。
- 调用方身份由客户端决定（`client.rs` 的 `terminal_id()`）：`HC_TERMINAL_ID` 生效的条件是 `HC_TERMINAL_SOCKET` 没设，或者指向正在连接的 core；否则按 `ppid` 算。手动设置的 `HC_TERMINAL_ID` 也有效（2026-11-11 实测：消息带上 `<hc from>`，`hc run` 的默认 parent 也是它）。之前记成“手动设置无效”是错的，当时 shell 里继承了另一个 core 的 `HC_TERMINAL_SOCKET`。
- 从 hc 终端里启动的程序（包括用 `open -a` 启动的 Desktop）会继承这个终端的 `HC_TERMINAL_ID`、`HC_TERMINAL_SOCKET` 和 `HC_SCOPE`。hc 结束这个终端时，会清理所有带它的 `HC_SCOPE` 的进程。
- hc 把子终端的通知（出错、阻塞、退出、回合结束）作为带标记的文字打进父 Agent 的终端，父 Agent 正在工作时也照样打进去，当作插话（`notes.rs` 的 `can_take_note`）。
- hc 的 `turn` 在回合结束时加一，回合进行中读到的是上一个值。
- 终端名只能在创建时设置（`[a-z0-9-_]`，最多 32 个字符，在存活终端里唯一）；标签可以随时用 `hc label` 修改。
- `hc ls --json` 不带 labels；`agent` 字段是 7501 里报的 `app`。
- 终端退出时，`hc events` 会发一个 `status: null` 的事件；标题变化也会产生一个状态值相同的 status 事件。
- hc 选项必须写在命令之前（`hc run --bg --json --name x cmd …`），否则会被当成命令的参数。
- 设置了 `XDG_RUNTIME_DIR` 时，hc 会把 socket 平铺放在 runtime 目录下；不设置时放在 `<state>/herdr-core/<session>/<session>.sock`。

## Herdr App

- Agent 列表的行和标签页用终端标题（程序用 OSC 0/2 设置的）命名，见 `defaults/mods/agents/main.js` 的 `title()`；不读 7501 的 title 和 hc 标签。标题像路径（以 `/` 或 `~` 开头）或含 `@` 时会被忽略。
- 用 hc 启动的终端带 `herdr.space=<id>` 标签才会出现在窗口里；没有 `herdr.tab` 时，Herdr 在那个 space 里新建一个标签页。
- 看过的 `done` 会显示成 Idle（`attention`/`seen`），状态词变了才重新提醒。
- “看过”通过 hc 标签 `herdr.seen=<turn>` 在各客户端间共享（`docs/labels.md`）：人真正看到终端时写入，只升不降。`blocked` 和 `error` 不管看没看过都显示为 Needs you，Herdr Perch 也一样。
- `hc events --json --terminal <t>` 先输出快照（`{seq, terminals:[{turn, labels, status, …}]}`），之后每行是 `{method:"event", params:{type, data}}`。出错时依次是 `status`、`turn{state, turn}`；标签变化是 `labels{labels}`，带完整的标签表。终端从未报过 `working` 就直接报 `error` 时，turn 不增加。
- `HERDR_APP_HOME` 指向另一个目录，再配合 `HC_SESSION` / `XDG_STATE_HOME`，就能在用户的 Herdr 旁边再开一个连到别的 core 的实例。
- macOS 上窗口被完全遮住时不重绘：`herdr-app shot` 返回的是最后一帧，界面层命令（如 `overlay.close`）也要等重绘才生效。
- 首次启动的欢迎页由 `shared.json` 里的 `frame.welcomed` 控制，更新说明由 `update-notes.json` 的 `last_run` 控制；窗口位置和大小在 `window.json`。
- hc 标签里 Herdr App 只认 `herdr.space`、`herdr.tab`、`herdr.seen`、`herdr.pinned`，没有设置 space 名的标签。不认识的 space id 建成未命名 space，名字取第一个终端的文件夹；`herdr-app ls` 返回的 `name` 是显示名，分不出自动命名还是用户改的。改名只能 `herdr-app do space.rename {"id":…,"name":…}`。
- `herdr-app ls` / `do` 不依赖窗口可见；窗口被遮住时界面层命令（如关闭弹层）才不生效。
