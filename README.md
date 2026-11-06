# dsh-herdr-bridge

让 DSH Desktop 的会话成为 Herdr Core（`hc`）里的一等公民：

- **状态**：DSH 会话的 `working / idle / done / blocked / error` 以 OSC 7501 进入 Herdr Core。Herdr Perch 和 Herdr App **不需要任何适配**就能看到。
- **Herdr → DSH**：Herdr Agent 用现有的 `hc run / send / wait / read / interrupt` 新建、发现、接管并操控 DSH 会话；读到的终端内容和读原生 TUI Agent（Claude Code、pi）时一样，包括提示、流式回复、带描述的工具调用和结果、回合用时。
- **DSH → Herdr**：DSH Agent 直接使用 `hc`，可以启动以自己为父终端的 helper，并接收它们的回报。
- **审批与提问**：Desktop 和 hc 两边都能回答，先答者生效，另一边的提问会被撤回。

不修改 DSH Desktop、Herdr Core、Herdr App、Perch 的源码；不引入第二份 DSH Runtime。

版本基线：DSH Desktop 0.2.2-rc.1，herdr-core 0.1.18，herdr-app 0.1.13，Perch `40e4e2c`。在 macOS 上验证过；Windows/Linux 的代码路径已写好，但没有验证。

## 安装

1. 完全退出 DSH Desktop（⌘Q），安装插件：
   ```sh
   dsh plugin --profile desktop add /path/to/dsh-herdr-bridge
   ```
2. 重新打开 Desktop。插件加载时会写出启动器 `~/.dsh/herdr-bridge/bin/dsh-hc`。
3. 安装 hc template，让 Herdr Agent 可以用 `hc run dsh "任务"` 新建 DSH 会话：
   ```sh
   ~/.dsh/herdr-bridge/bin/dsh-hc install-template   # 或 scripts/desktop.sh template
   ```
4. 可选：把 `~/.dsh/herdr-bridge/bin` 加进 PATH，就可以直接用 `dsh-hc`。

以本地路径链接安装后，改代码不需要再退出 Desktop：执行 `scripts/desktop.sh reload` 即可热重载。它只修改 `cordis.patch.yml` 里 `herdr-bridge` 这一项，第一次执行时会备份原文件。

## 使用

### 在 Herdr 里看到 DSH 会话

在 Desktop 里正常使用即可：

- 会话**第一次运行**时，插件为它开一个名为 `dsh-<短 id>` 的 hc 终端。
- 终端带两个标签：`dsh.session=<id>`；`dsh.title=<会话标题>`（随改名同步）。7501 状态里的 title 也是会话标题。
- 想让还没运行过的会话也出现在 Herdr 里，在 Desktop 里对它输入 `/herdr`。命令会显示它的 hc 地址。
- 会话关闭（Agent 释放）时，终端结束并被移除。

### Herdr Agent 新建、发现、接管 DSH 会话

```sh
hc run --bg --name fix --cwd /repo dsh "修复 x.rs 里失败的测试"   # 新建
dsh-hc ls --days 7                                            # 最近的会话：id、标题、目录、是否在 hc 里
hc run --bg --name login dsh-hc attach 3b729fc9               # 接管（id、id 前缀或标题片段）
hc read login                                                 # 先看到之前的对话，再看到新的
hc send --wait login "继续，把边界情况也测了"
hc interrupt login                                            # 取消当前回合
```

- **接管**：如果这个会话已经有自动映射的 `dsh-<短 id>` 终端，那个终端会让位退出，接管方成为唯一镜像。
- **新建会话的目录规则**：
  - 目录正好是已有的 Workspace：加入它。
  - 目录是某个 Workspace 的子目录：建成“未分组”会话，目录保持不变。
  - 其他目录：自动添加为新的 Workspace。

### 审批与提问（blocked）

- 会话等待审批或提问时，Desktop 会照常弹出对话框，hc 终端里也会显示问题，状态为 `blocked`。
- **两边都能回答，先答者生效**。
- 在 hc 侧回答要加 `--force`：`hc send --force <t> y`（批准一次）、`n`（拒绝）；提问则回答选项序号（多选写 `1,3`）、自由文本，或 `-` 跳过。
- hc 本身会拒绝向 blocked 的程序普通 `send`，所以必须加 `--force`。什么时候该用 `--force`，由 Agent 的指令决定（见 `hc --skill`）。
- DSH 子 Agent 的审批会显示在父会话的终端里。

### DSH Agent 使用 hc

插件为已映射的会话注入 `DSH_HC_TERMINAL`（会话自己的 hc 地址），并注册一个运行时 skill `herdr-bridge`，告诉模型这样启动 helper：

```sh
hc run --bg --parent "$DSH_HC_TERMINAL" --name helper --cwd /repo claude "…完成后用 hc send $DSH_HC_TERMINAL 汇报"
```

helper 的回报，以及 hc 对它的通知（完成、blocked、退出），都会作为下一条用户消息送进 DSH 会话并唤醒它。通用的 hc 用法来自 `~/.agents/skills/herdr-core`，DSH 会自动发现这个目录。

## 配置

写在 `~/.dsh/profiles/desktop/cordis.patch.yml` 的 `herdr-bridge` 条目下：

```yaml
- id: herdr-bridge
  config:
    reconnectGraceSeconds: 30   # 插件断开后，终端等待重连的秒数；超时就退出（默认 30）
    herdrSpace: s3              # 可选：给终端打 herdr.space 标签，在 Herdr App 的这个 space 里显示
    hc: /path/to/hc             # 可选：hc 可执行文件，默认是 PATH 上的 hc
```

## 已知限制

- **重载后丢失上一回合的结论**：插件重载后，空闲会话的状态会从 `done` 变成 `idle`，因为新实例不知道上一回合是怎么结束的。Perch 判断“完成未看”只看回合数，所以不受影响。
- **“看没看过”**：你在 Desktop 里已经读过的回合，Perch 仍会显示“完成未看”。Desktop 也是一个观看者，但 Herdr 不知道它的存在。方向见 [TODO.md](TODO.md)。
- **每个映射出去的会话都有一个代理进程**：物理内存约 13–14 MB（`footprint` 实测；RSS 约 50 MB，其中大部分是共享的 Electron 代码）。
- **已在运行的代理不会自动升级**：插件升级后，已经开着的终端仍运行旧版 `proxy.js`，直到它们重开。插件和代理之间有协议版本号，版本不符时会明确报错。
- **竞争应答依赖 DSH 的两处实现细节**：一是审批链上传递的是同一个请求对象，二是 gateway 在转发时读取 `request.signal`。如果失效，表现是对话框不撤回，不会导致错误批准。`scripts/e2e-ui.sh` 会检测到。
- **DSH 接口仍在变化**：插件依赖 `sessionController`、`workspaceRegistry`、`commands`、`shellEnv`、`skills`、`agents` 等服务，以及 `agent/*`、`session/event`、`agent/assistant-stream`、`approval/request`、`user-questions/request` 等事件。DSH 升级后先跑一遍回归测试。

## 开发

见 [AGENTS.md](AGENTS.md)。简述：

```sh
scripts/dev.sh up          # 隔离环境：模拟 LLM + 隔离 hc core + 隔离 dsh web（Desktop 替身）
scripts/dev.sh reload      # 热重载插件
scripts/e2e.sh             # 32 项：只通过 hc / dsh-hc 驱动，含 Perch
scripts/e2e-ui.sh          # 12 项：浏览器扮演 Desktop 用户，hc 扮演 Herdr Agent
scripts/dev.sh down
scripts/desktop.sh reload  # 把改动热重载进真实 Desktop
```

---

# 设计

## 产品原则

**DSH 在 Herdr 里是一等公民。** 对 Herdr Agent 和用户来说，DSH 会话和 Claude Code、pi 没有区别：能和 hc 语义对齐的地方直接对齐，例如信任模型（`--force` 是唯一的闸门）、消息排队、父子终端和通知。只有 DSH 天然不同的地方才专门设计：它是 GUI，一个 Workspace 里有多个会话，Desktop 本身也是一个观看者。设计目标是体验，而不是实现上省事。

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
  - 内存方面，每个代理实际物理占用约 13–14 MB。
- **启动器**：
  - 插件加载时生成 `bin/dsh-hc`（Windows 上是 `.cmd`），用 `ELECTRON_RUN_AS_NODE=1` 运行 Desktop 自带的 Node，不依赖用户另外装 Node。
  - hc template 由 `dsh-hc install-template` 按当前机器的路径生成。
- **重连**：
  - 插件热重载、升级，或用户在 Desktop 里改了设置导致 profile 重组时，代理会在宽限期内重连。
  - 重连后 hc 地址不变，父子关系不变，Perch 记录的回合数也不变。
  - 宽限期过了还没连上，代理就退出（Desktop 真的退出了）。
- **自动映射的终端命名为 `dsh-<短 id>`**：
  - hc 的终端名只能在创建时设定，而且只能用 `a-z 0-9 - _`，放不下中文标题，改名后也会过时。
  - 所以标题放进 7501 状态和 `dsh.title` 标签。这个名字同时起到锁的作用：重载后如果旧终端还在重连，就不会重复创建。
  - 由 Herdr Agent 接管的终端，名字由 Agent 自己起。

### 状态映射（OSC 7501）

| DSH 事实 | 7501 |
|---|---|
| `agent/status` → `running` | `working` |
| `turn/end{completed \| max-tokens}` 后变为 idle | `done` |
| `turn/end{aborted}` 后变为 idle | `idle` |
| `turn/end{error \| blocked}` 后变为 idle | `error`，`msg` = 原因 |
| 审批或提问进行中 | `blocked`，`kind=permission \| question` |
| `session/title` | `title` |

### 渲染（`hc read` 读到什么）

格式向原生 TUI 看齐，例如：

- 提示：`❯ 用户输入`
- 回复：`⏺ 流式回复`（来自 `agent/assistant-stream`）
- 工具调用：`⏺ bash <description>` / `⎿ 结果首行 (+N lines)`
- 回合结束：`✻ done · 12s` / `✻ cancelled` / `✻ error: …`
- 审批或提问：问题和选项

接管已有会话时，先用 `sessionController.page` 回放最近的对话，渲染方式和实时显示相同。

### 竞争应答

- DSH 的审批和提问是一条处理链，每个请求只有一个最终应答方。Desktop 自带的应答方先注册，而且不把请求往后传。
- DSH 把请求转发给 UI 时，gateway 会监听 `request.signal`；signal 一旦 abort，就撤回 UI 上的对话框。
- 所以插件用 `prepend` 排在链的最前面，把 `req.signal` 换成 `AbortSignal.any([原 signal, 桥接 signal])` 后再交给 Desktop，同时在 hc 侧等待回答：
  - hc 先答：abort 桥接 signal，Desktop 的对话框随之撤回。
  - Desktop 先答：撤掉 hc 终端里的等待。
  - Desktop 没有可用的应答方（返回 `unavailable`）：继续等 hc 的回答。

### 反向：为什么用 `DSH_HC_TERMINAL` 加 `--parent`

- shell-env 只允许注入 `DSH_*` 变量。实测手动设置 `HC_TERMINAL_ID` 时，hc 也不会把它当作调用方：既不会成为 parent，也不会给消息加 `<hc from>` 标签。
- herdr-core skill 默认使用者身处一个 hc 终端里。DSH 的 shell 不在 hc 终端里，所以由运行时 skill `herdr-bridge` 补充三点差异：自己的地址在哪里；启动 helper 要显式写 `--parent`；bash 大约 60 秒超时，不能一直 `hc wait`。环境变量的描述不会进入模型上下文，所以这些只能靠 skill 告诉模型。

## 否决的方案

| 方案 | 否决理由 |
|---|---|
| hc 的外部注册或状态上报接口 | 不存在：hc 的 29 个 RPC 方法里没有能写 status 的 |
| 外部程序直连 Desktop Host `/api` | 凭据只在 Electron 内部；Typert Gateway 协议是生成出来的内部契约，变动快 |
| 伪装成 hc machine（`machine add --via`） | 需要重新实现 attach / wait / send 等 core 语义 |
| `doc.set` 发布状态 | Perch 不读 doc |
| Herdr App mod | mod 只是窗口 UI，无法让状态进入 core |
| 在 hc 里运行 `dsh tui` | 第二份 Runtime，还会和 Desktop 争同一会话的写锁 |
| `sh + nc` 哑管道（v1） | 只能用于 macOS；插件重载就断开；无法排版 |
| 一个中心进程服务所有终端 | 做不到：每个 hc 终端里必须有一个属于它的进程 |
| `/herdr delegate` 授权命令 | 等于另造一套权限模型 |
| 按会话来源决定谁回答（v1） | 改成两边竞争应答后就不再需要 |

## 验证

- `scripts/e2e.sh`（32 项，隔离环境 + 模拟 LLM）：
  - 新建会话、标题和标签、`send --wait`、interrupt、模型报错。
  - 审批从 hc 回答、blocked 时 hc 拒绝普通 send、blocked 时 interrupt、提问。
  - `DSH_HC_TERMINAL`、skill、工具调用的渲染。
  - `ls`、`attach` 回放历史、多个终端同步显示、子目录会话保持原目录。
  - 运行中重载后地址不变并能跑完回合、Perch。
- `scripts/e2e-ui.sh`（12 项，浏览器 + 隔离 `dsh web`）：
  - Desktop 发起的会话自动映射、`/herdr`。
  - hc 回答审批后 Desktop 对话框被撤回；Desktop 回答后 hc 侧随之结束等待。
  - hc 回答提问后 Desktop 的提问被撤回。
  - 接管时自动映射的终端让位。
- 真实 DSH Desktop（真实模型）：
  - 新建会话、渲染、运行中重载后地址不变并跑完回合。
  - `dsh-hc ls` 列出真实会话（含中文标题）。
  - DSH 会主动按 hc 协议回报。
  - v1 时期还验证过：反向闭环（DSH 启动 helper，接收它的回报）、Perch 显示。
