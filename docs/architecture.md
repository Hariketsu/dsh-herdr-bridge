# 设计与实现

这份文档写给想了解或修改 dsh-herdr-bridge 的人：为什么这样设计、各部分如何通信、哪些方案被否决、测试覆盖了什么。使用说明见 [README](../README.md)（[中文](../README.zh-CN.md)），开发回路见 [development.md](development.md)，上游接口的观测记录见 [upstream-notes.md](upstream-notes.md)，待办见 [TODO.md](../TODO.md)。

## 产品原则

**DSH 和其他 Herdr Agent 一样对待。** 能和 hc 语义对齐的地方直接对齐，例如信任模型（`--force` 是唯一的闸门）、消息排队、父子终端和通知。只有 DSH 天然不同的地方才专门设计：它是 GUI，一个 Workspace 里有多个会话，Desktop 本身也是一个观看者。设计目标是体验，而不是实现上省事。

硬约束：不修改 DSH、Herdr Core、Herdr App 的源码；不引入第二份 DSH Runtime；对 hc 只依赖 CLI 和 OSC 7501。

## TUI Agent 与 GUI Agent

| | TUI Agent（Claude Code、pi……） | GUI Agent（DSH Desktop） |
|---|---|---|
| 单位 | 一个进程就是一个会话 | Workspace 下众多会话之一 |
| 起点 | 先 `cd` 到目录再启动，cwd 是启动参数 | 先添加工作目录，会话从属于 Workspace |
| 存在 | 进程活着就算在场 | 会话长期保存；Agent 在打开或使用时才加载进内存 |
| 映射到 hc | 一个终端对应一个 Agent，天然吻合 | 需要规则 |

需求拆成两件事：

- **可见**：正在用的会话自动出现在 Herdr 里。Desktop 启动或打开会话时就可能加载 Agent（实测比第一条 prompt 早约 6 秒），所以以“第一次运行”为准，而不是以“Agent 已加载”为准。
- **可接管**：Herdr Agent 能找到并驱动任意会话。映射以会话为单位，不需要先加载 Agent，因为 `sessionController.prompt` 会按需把会话恢复起来。对应两条路径：拉取（`dsh-hc ls / attach`）和推送（`/herdr`）。

## 架构

```
hc 终端（每个映射出去的会话一个）               DSH Desktop Host 进程
 └─ dsh-hc（proxy.js，Desktop 自带的 Node）      └─ dsh-herdr-bridge 插件（index.js + render.js）
     原始按键、窗口尺寸 ──── JSON 行 ────▶            控制 socket（Unix socket / 命名管道）
     原样写出 ◀──── 排好版的文本 + OSC 7501 ────      DSH 事件 → 渲染；输入 → prompt / cancel / 回答
     插件断开时保留终端，重连并声明                  sessionController、workspaceRegistry、
       “我是会话 X、来源 Y”                          commands（/herdr）、shellEnv、skills、agents
```

- **代理很薄，渲染集中在插件里**：
  - 每个 hc 终端里必须有一个属于它的进程，因为 7501 状态只能来自写进这个终端的字节，这一点由 hc 的设计决定。
  - 所以重活集中在插件里，代理只负责按键、尺寸和重连。将来可以把代理换成编译型小程序，协议不用改。
  - 每个代理实际物理占用约 13–14 MB（`footprint` 实测；RSS 约 50 MB，其中大部分是共享的 Electron 代码）。
- **启动器**：
  - 插件加载时生成 `bin/dsh-hc`（Windows 上是 `.cmd`），用 `ELECTRON_RUN_AS_NODE=1` 运行 Desktop 自带的 Node，不依赖用户另外装 Node。
  - 插件每次加载都按当前机器的路径写 hc template（`install.js`），用户不用做任何安装步骤；template 的描述里带着启动器的完整路径，Herdr Agent 用 `hc templates` 就知道怎么列出和接管会话，所以 `dsh-hc` 不需要在 PATH 上。用户自己写的 `dsh` template（不含 `dsh-herdr-bridge` 字样）不会被覆盖。`dsh-hc install-template` 手动执行同一段代码。
  - 同样在加载时往 Herdr App 的用户程序表 `programs.json` 里加一个 `dsh` 条目（名字 DSH、单色图标随包发布），因为 Herdr App 只认内置的程序和这张表。已有的 `dsh` 条目不覆盖。
- **重连**：
  - 插件热重载、升级，或用户在 Desktop 里改了设置导致 profile 重组时，代理会在宽限期内重连。
  - 重连后 hc 地址不变，父子关系不变。
  - 宽限期过了还没连上，代理就退出（Desktop 真的退出了）。
- **协议版本**：插件和代理之间有协议版本号。插件升级后，已经开着的终端仍运行旧版 `proxy.js`，直到它们重开；版本不符时会明确报错。
- **放进 Herdr App**：Herdr App 只显示带 `herdr.space=<id>` 标签的 hc 终端，不认识的 id 会新建一个 space。自动映射的终端按 `herdrPlacement` 打标签：`folder` 先用 `hc ls` / `hc get` 找同一文件夹里已有终端的 space（只认用户自己的，即 id 不是 `dsh`、也不以 `dsh-` 开头），找不到就用 `dsh-<文件夹路径的哈希>`，同一文件夹的会话因此总在一个 space；`dsh` 用固定 id `dsh`；`none` 不打。放置只用 hc CLI。唯一例外是给 `dsh` 共享 space 起名：hc 标签无法设置 space 名，Herdr App 会以第一个终端的文件夹命名，所以插件在 Herdr App 建好这个 space 后，通过它公开的命令行 `herdr-app do space.rename` 改名为 DSH；名字仍是自动生成的文件夹名时才改，用户起的名字不碰；没装或没运行 Herdr App 就跳过。可执行文件按 `HERDR_APP_BIN`、`/Applications/Herdr.app`、`~/Applications/Herdr.app`、PATH 上的 `herdr-app` 查找。Herdr Agent 用 `hc run dsh` 起的会话是它的子终端，Herdr App 本来就显示在父终端下面。
- **设置**：插件导出 schemastery 写的 `Config`，`herdrPlacement` 和 `herdrSpace` 标为 `.volatile()`：DSH 的 settings 服务把它们作为 `herdr-bridge` 命名空间的表单提供出来，改动写进 profile 补丁，插件每次用时 `.get()` 读，不用重载。schemastery 随 DSH 提供，但链接安装时可能解析不到，所以运行时按需加载；拿不到就不导出 `Config`，设置按普通值从 `cordis.patch.yml` 读取。
- **设置页**：DSH 不根据 `Config` 生成界面（settings 服务 README：“no shipped client does so yet”），所以插件自带浏览器端 `client.js`，挂在插件页的 `plugins.bundle.config` 槽（key 是包名 `dsh-herdr-bridge`，显示在插件页的详细介绍和组件列表之间），用官方的 `SettingsFormModel` / `SettingsForm` 读写这个命名空间；宿主端注册 `settings.configure({ auto: false })` 表示自带页面。`client.js` 按客户端模块系统的懒加载工厂格式手写（与官方 tsdown 产物相同），所以包仍然不需要构建；`react` 和 `@deepseek-ai/dsh-client-ui-primitives` 来自宿主的共享模块表。
- **自动映射的终端命名为 `dsh-<短 id>`**：
  - hc 的终端名只能在创建时设定，而且只能用 `a-z 0-9 - _`，放不下中文标题，改名后也会过时。
  - 所以标题放进终端标题（OSC 2，Herdr App 的 Agent 列表和标签页用它命名，和 TUI Agent 一样）、7501 状态和 `dsh.title` 标签。这个名字同时起到锁的作用：重载后如果旧终端还在重连，就不会重复创建。
  - 由 Herdr Agent 接管的终端，名字由 Agent 自己起。
  - 每个终端带 `dsh.session=<会话 id>` 和 `dsh.title=<会话标题>` 两个标签，Agent 可以用 `hc get` 查到对应的 DSH 会话。
- **hc 发起的会话放进哪个 DSH 工作区**：`hc run dsh` 的文件夹正好是某个 DSH 工作区时加入它；是某个工作区的子文件夹时建成“未分组”会话并保留这个文件夹；其他文件夹新建工作区。

## 状态映射（OSC 7501）

| DSH 事实 | 7501 |
|---|---|
| `agent/status` → `running` | `working` |
| `turn/end{completed \| max-tokens}` 后变为 idle | `done` |
| `turn/end{aborted}` 后变为 idle | `idle` |
| `turn/end{error \| blocked}` 后变为 idle | `error`，`msg` = 原因（一行；终端里显示完整报错） |
| 审批或提问进行中 | `blocked`，`kind=permission \| question` |
| `session/title` | `title` |

**报错保持 `error` 到下一回合**：和 Claude Code 一致（2026-11-11 在隔离 hc 里实测：API 返回 404 时它报 `error`，`msg` 是一句完整的报错；写入 `herdr.seen` 后仍是 `error`，直到下一回合）。看没看过只体现在 `herdr.seen` 标签上，插件不因此改写状态，父 Agent 事后用 `hc ls` / `hc get` 也能看到出过错。代价是 Herdr App 和 Perch 会一直把它显示为 Needs you（labels.md 对 `error` 不看 seen），原生 Agent 也一样。

**DSH 窗口也算 Herdr 客户端**：在 DSH 里看过的回合，插件替你写 `herdr.seen`，就像 Herdr App 一样，所以 Herdr App 和 Perch 里看过的 Done 变成 Idle。
- 判定“在看”（浏览器端 `client.js`）：会话在主视图（`ctx.sessions.list` 行的 `retainedBy.mainView > 0`，和 DSH 自己的完成提醒同一个依据），而且页面可见、窗口有焦点，即 labels.md 说的“真的在人面前”。
- 上报通道：插件宿主端用 `ctx.connection.fetch.register` 注册精确路由 `POST /api/herdr-bridge.viewing`（DSH 自己的会话导出也是这样和浏览器端通信的；只有 owner 的浏览器能访问），浏览器端在主视图、可见性、焦点变化时上报 `{ client, sessions }`。在看的时候每 10 秒重复一次；宿主端 25 秒收不到就当作不再在看，窗口直接关掉也不会一直算着。
- 写入：会话在看的时候，插件也用 `hc events` 跟着它的终端；进入视野时和在视野里结束一个回合时（`turn` 事件），写 `herdr.seen=<turn>`。按 labels.md：每回合只写一次、只升不降、标签缺失时也写；别处“标为未读”不会被一直开着的窗口顶回去，重新看一次才再写。
- 多个窗口（Desktop、`dsh web`）有一个在看就算。反方向（在 Herdr 里看过，清掉 DSH 侧栏的完成提醒）不做：那个提醒只存在浏览器进程里。

**自动映射时补报 `working`**：自动映射的终端是在回合开始后才连上的，回合可能在它连上之前就结束了（例如模型立刻报错）。这时终端的第一条 7501 报告直接是 `done` 或 `error`，hc 的 turn 不会增加，Herdr 的看过规则也就无从判断。所以新的自动映射终端如果连上时回合已经结束，插件先报 `working` 再报结果。

**归档即关闭终端**：DSH 归档会话后，会话在 DSH 里就不可见了，所以插件把对应的终端都关掉（和会话关闭一样发 `bye`；自动映射的终端带 `--rm`，会随之消失）。归档写入持久存储后 DSH 会发出 `domain/changed`（`domain: 'workspace'`，`table: ''`），新的归档集合在事件的 `value.archivedSessionIds` 里；官方 workspace feed 也是这样监听的。取消归档后，会话下次运行时会重新映射。

插件重载后，新实例不知道空闲会话的上一回合是怎么结束的。代理记得自己最后显示的 7501 状态，重连时放在 hello 的 `status` 里带回来；插件在还没亲眼看到这个会话变化之前，用它恢复 `done` 或 `error`（`working`、`blocked` 由实时事件决定，不靠记忆）。这是向后兼容的新增字段，所以没有升 `PROTOCOL`：旧代理不带它，旧插件忽略它。

## 渲染（`hc read` 读到什么）

格式向原生 TUI 看齐：

- 提示：`❯ 用户输入`
- 回复：`⏺ 流式回复`（来自 `agent/assistant-stream`）
- 工具调用：`⏺ bash <description>` / `⎿ 结果首行 (+N lines)`
- 回合结束：`✻ done · 12s` / `✻ cancelled` / `✻ error: …`
- 审批或提问：问题和选项

接管已有会话时，先用 `sessionController.page` 回放最近的对话，渲染方式和实时显示相同。

## 竞争应答

- DSH 的审批和提问是一条处理链，每个请求只有一个最终应答方。Desktop 自带的应答方先注册，而且不把请求往后传。
- DSH 把请求转发给 UI 时，gateway 会监听 `request.signal`；signal 一旦 abort，就撤回 UI 上的对话框。
- 所以插件用 `prepend` 排在链的最前面，把 `req.signal` 换成 `AbortSignal.any([原 signal, 桥接 signal])` 后再交给 Desktop，同时在 hc 侧等待回答：
  - hc 先答：abort 桥接 signal，Desktop 的对话框随之撤回。
  - Desktop 先答：撤掉 hc 终端里的等待。
  - Desktop 没有可用的应答方（返回 `unavailable`）：继续等 hc 的回答。

这依赖 DSH 的两处实现细节：审批链上传递的是同一个请求对象，gateway 在转发时读取 `request.signal`。如果失效，表现是 Desktop 的对话框不撤回，不会导致错误批准。`scripts/e2e-ui.sh` 会检测到。

## 反向：DSH 会话里的 `hc` 以会话自己的终端身份调用

原生 Agent 由 hc 在终端里启动，`HC_TERMINAL_ID` 随进程继承到它的 shell，hc 据此知道调用方是谁：消息带 `<hc from>`，`hc run` 默认把调用方当作 parent。DSH 的会话 shell 是 DSH 主进程的子进程，不在终端的进程树上；一个主进程跑着所有会话，也不能在进程上设一个统一的身份。shell-env 只允许注入 `DSH_*` 变量，所以分两步：

- 插件加载时删掉 DSH 进程继承来的 `HC_TERMINAL_ID`、`HC_TERMINAL_SOCKET`。DSH 从某个 hc 终端里启动时（比如在 Herdr 的终端里跑 `dsh web`）会带着那个终端的身份，否则所有会话的 `hc` 都会冒充它。`HC_SCOPE` 保留：从某个终端启动的 DSH 随这个终端一起结束，是 hc 本来的语义。
- 插件在 `~/.dsh/herdr-bridge/bin` 写一个 `hc` 垫片，并把这个目录放到 DSH 进程 `PATH` 的最前面。shell-env 给每次 shell 调用注入 `DSH_HC_TERMINAL`；垫片把它转成 `HC_TERMINAL_ID`，再执行真正的 hc（插件加载时在 PATH 里找到，或用配置的 `hc`）。插件自己调用 hc 时直接用真正的 hc。

会话还没映射到 hc 时，`DSH_HC_TERMINAL` 为空，垫片原样透传，hc 按 `ppid` 认调用方。运行时 skill `herdr-bridge` 只补充 DSH 自己的差异：自己的地址、映射前用 `--no-parent`、bash 大约 60 秒超时所以不能一直 `hc wait`。环境变量的描述不会进入模型上下文，这些只能靠 skill 告诉模型。

## 依赖的 DSH 接口

插件依赖 `sessionController`、`workspaceRegistry`、`commands`、`shellEnv`、`skills`、`agents` 等服务，以及 `agent/*`、`session/event`、`agent/assistant-stream`、`approval/request`、`user-questions/request` 等事件。这些不是稳定 API，只在 DSH 0.2.2-rc.1 上观测过，具体行为记在 [upstream-notes.md](upstream-notes.md)。DSH 升级后先跑一遍回归测试。

## 否决的方案

| 方案 | 否决理由 |
|---|---|
| hc 的外部注册或状态上报接口 | 不存在：hc 的 29 个 RPC 方法里没有能写 status 的 |
| 外部程序直连 Desktop Host `/api` | 凭据只在 Electron 内部；Typert Gateway 协议是生成出来的内部契约，变动快 |
| 伪装成 hc machine（`machine add --via`） | 需要重新实现 attach / wait / send 等 core 语义 |
| `doc.set` 发布状态 | doc 不是终端状态，Herdr 的状态显示和 `hc wait` 都不读它 |
| Herdr App mod | mod 只是窗口 UI，无法让状态进入 core |
| 在 hc 里运行 `dsh tui` | 第二份 Runtime，还会和 Desktop 争同一会话的写锁 |
| `sh + nc` 哑管道（v1） | 只能用于 macOS；插件重载就断开；无法排版 |
| 一个中心进程服务所有终端 | 做不到：每个 hc 终端里必须有一个属于它的进程 |
| `/herdr delegate` 授权命令 | 等于另造一套权限模型 |
| 按会话来源决定谁回答（v1） | 改成两边竞争应答后就不再需要 |
| skill 让模型显式写 `--parent` 和回报地址 | 靠模型每次都记得；垫片让 `hc` 自动以会话身份调用，和原生 Agent 一样 |
| 看过的报错改报 `idle`（3b29d93） | 原生 Agent（Claude Code）看过后仍是 `error`；改写状态会让父 Agent 事后查不到出过错 |

## 验证

最近一次全部通过：2026-11-07，macOS，版本组合见 README 的“要求”。没有 CI，测试在本机手动执行。

- `scripts/e2e.sh`（41 项，隔离环境 + 模拟 LLM，不需要真实 Desktop）：
  - 新建会话、标题（终端标题、7501、标签）、`send --wait`、interrupt、模型报错。
  - 审批从 hc 回答、blocked 时 hc 拒绝普通 send、blocked 时 interrupt、提问。
  - `DSH_HC_TERMINAL`、会话 shell 里的 `hc` 以会话终端的身份发消息和起子 Agent（测试从 hc 终端里启动，`dsh web` 继承了别的身份）、skill、工具调用的渲染。
  - `ls`、`attach` 回放历史、多个终端同步显示、子目录会话保持原目录。
  - 运行中重载后地址不变并能跑完回合；重载前已完成、已报错的会话重载后保持 `done`、`error`；`herdr.seen` 追上出错的回合后仍是 `error`；报错完整显示在终端里。
  - 插件加载时自动安装 hc template；用户自己写的 `dsh` template 不被覆盖。`install-template` 往 Herdr App 的程序表里加 DSH，保留已有条目。
- `scripts/e2e-ui.sh`（21 项，ego-browser + 隔离 `dsh web` 作为 Desktop 替身）：
  - Desktop 发起的会话自动映射（映射前已开始流式输出的回复完整到达，按文件夹放进 Herdr App 的 space）、`/herdr`。
  - hc 回答审批后 Desktop 对话框被撤回；Desktop 回答后 hc 侧随之结束等待。
  - hc 回答提问后 Desktop 的提问被撤回。
  - 接管时自动映射的终端让位。
  - 第一回合就报错的 Desktop 会话 turn 为 1，因为就在眼前报错，立刻被标为看过（状态仍是 `error`）；在 Desktop 里归档后终端关闭。
  - 在 DSH 窗口里打开报错的会话：写入 `herdr.seen`，状态仍是 `error`；在视野里结束的回合被标为看过，视野外的不会，直到打开它。
- 真实 DSH Desktop（真实模型，手动冒烟）：
  - 新建会话、渲染、运行中重载后地址不变并跑完回合。
  - `dsh-hc ls` 列出真实会话（含中文标题）。
  - DSH 会主动按 hc 协议回报。
  - 只在 v1 时期验证过、当前版本未重测：反向闭环（DSH 启动 helper，接收它的回报）。

未测或只间接验证的路径列在 [TODO.md](../TODO.md)。
