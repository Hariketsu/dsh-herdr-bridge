# 上游接口观测记录

开发中通过读上游源码和实测得到的 DSH、hc 行为。这些**不是稳定 API**，只在下面的版本上观测过：

| 项目 | 观测时的版本 |
|---|---|
| DSH（Desktop / `dsh web`） | 0.2.2-rc.1 |
| herdr-core | 0.1.18 |
| Perch | `40e4e2c` |

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
- `sessionController.list({}, signal)` 返回的条目里，标题在 `projections.values.title`。
- `sessionController.page({ address: { kind: 'session', sessionId }, maxMessages }, signal)` 的 `records` 形如 `{ type: 'event', event }`，要解包后再渲染。
- `ctx.agents.list()` / `get(id)` 返回存活的 Agent，`agent.status` 是 `idle` 或 `running`。
- 会话可以属于 Workspace（目录必须**完全相等**），也可以未分组（`sessionController.create({ cwd })`）。`workspaceRegistry.create(path)` 是幂等的；`list()` 返回 `{ id, path }`。
- 斜杠命令：`ctx.commands.register({ name, description, handler: async ({ agent, rawInput }) => ({ kind: 'success' | 'error', text }) })`。
- 会话日志在 `$DSH_HOME/sessions/<目录编码>/<session>/session.v4.jsonl.zstd`，用 `zstd -dc` 读。

## DSH 审批与提问

- 两者都是 waterfall，每个请求只有一个最终应答方。Desktop 自带的应答方先注册，而且不调用 `next()`，所以插件必须用 `{ prepend: true }`。根 ctx 上的监听器能收到所有 Agent 的请求，`req.agent` 就是完整的 Agent。
- **撤回机制**：转发器（`api/remotes`）把请求交给 gateway，gateway 监听 `request.signal`，abort 时调用 `cancelRemoteEvent`，撤回 UI 上的对话框。请求对象没有被冻结，链上传的是同一个对象，所以替换 `req.signal` 对下游生效。
- 没有 UI 客户端时，转发的审批会一直挂着等待；headless 没有应答方，会立刻得到 `unavailable`。
- 审批的结果是 `'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`；提问的回答是 `{ answers: [{ id, selected: [label…], custom? }] }`。
- bash 工具要求必填参数 `description`。提权流程是：先被沙箱拒绝，同一轮里再带 `sandbox_permissions` 和 `justification` 重试同一条命令，这次才会触发审批。

## DSH 环境

- shell-env 只允许注入 `DSH_*` 变量，变量描述不进入模型上下文；要让模型知道，用 `ctx.skills.register({ name, description, whenToUse, source: 'runtime', content })`。DSH 会自动发现 `~/.agents/skills`。
- Desktop Host 进程用的是登录 shell 的 PATH（含 `~/.local/bin`）；Desktop 会话默认是 `workspace-write` 沙箱，`hc` 在其中可以正常使用。
- 真实 DSH Agent 会读懂 `<hc reach=…>` 标记，并主动 `hc send` 回报给发起者。

## hc

- `hc send` 送来的是 `ESC[200~文本ESC[201~` 加 `\r`；`hc interrupt` 送来的是单独一个 `ESC`。
- 程序处于 blocked 时，hc 自己会拒绝普通 `send`，加 `--force` 才会送达。
- 手动设置的 `HC_TERMINAL_ID` **不会**被当作调用方；要指定父终端，用 `hc run --parent <t>`。hc 运行的程序的环境里有 `HC_TERMINAL_ID`。
- 终端名只能在创建时设置（`[a-z0-9-_]`，最多 32 个字符，在存活终端里唯一）；标签可以随时用 `hc label` 修改。
- `hc ls --json` 不带 labels；`agent` 字段是 7501 里报的 `app`。
- 终端退出时，`hc events` 会发一个 `status: null` 的事件；标题变化也会产生一个状态值相同的 status 事件。
- hc 选项必须写在命令之前（`hc run --bg --json --name x cmd …`），否则会被当成命令的参数。
- 设置了 `XDG_RUNTIME_DIR` 时，hc 会把 socket 平铺放在 runtime 目录下；不设置时放在 `<state>/herdr-core/<session>/<session>.sock`。

## Perch

- 只扫描 `<state>/herdr-core/<session>/<session>.sock`，所以测试时不要设置 `XDG_RUNTIME_DIR`。
- 行标题的取法：终端名 → 7501 的 title → 终端标题。
- “完成未看”只按回合数判断。
