# TODO

已经实现的见 [docs/architecture.md](docs/architecture.md)。下面只列还没做的，按优先级排。

## P0：公开发布前

- [ ] **发布 0.1.1**：npm 上是 0.1.0，还不含终端标题、首段回复和 Herdr App 图标这几项修复。
- [ ] **从 npm 安装到真实 Desktop**：`npm pack` 出的包已在隔离的 `dsh web` 里装过、卸过：插件能加载，`dsh-hc ls`、`install-template` 正常，卸载后 bundle 条目被移除，DSH 启动没有警告。发布后还要在 Desktop profile 上按 README 走一遍，包括发一条消息后 `hc ls` 出现 `dsh-<短 id>`。
- [ ] **Desktop 和 `dsh web` 同时运行**：后启动的那个不提供控制 socket（`index.js` 里的 probe），但它的插件可能仍然会为自己的会话开终端，这些终端会连到另一个 Host。先实测会发生什么；至少保证不出现连错 Host 的终端，然后把 README 里这条限制写准确。

## P1：已知问题与待验证

- [ ] **`turn/end{max-tokens}` 是否该映射为 `done`**：回合因为输出上限被截断，不一定是任务完成。对照 hc 的状态语义，以及 Claude Code 等原生 Agent 在同类情况下报什么，再决定是 `done` 还是 `error`。
- [ ] **用户在真实 Desktop 里发起的会话**：隔离 `dsh web` 里由 `e2e-ui.sh` 覆盖，真实 Desktop 没法自动化。通过标准：正常使用时，会话一开始运行，Herdr App 里就出现 `dsh-<短 id>`，状态随回合变化。
- [ ] **`hc interrupt` 会不会清掉已排队的消息**：插件调用的是 `sessionController.cancel`，按 DSH 文档默认会清空排队和插话的输入。写一个测试：排两条消息后 interrupt，确认行为并写进两份 README。
- [ ] **多题提问、多选、请求中途被撤回**：代码有处理，测试只覆盖单题单选和撤回提问。补进 `e2e.sh`（mock-llm 需要能出多题、多选的提问）。
- [ ] **子 Agent 的审批显示在父会话的终端里**：代码有处理，没有测。
- [ ] **会话归档或删除时终端是否随之结束**：只覆盖了 Agent 释放这条路径。
- [ ] **长时间运行的稳定性**：场景是一天几十个会话、Desktop 睡眠唤醒、hc core 重启。通过标准：每个场景之后，`hc ls` 里的 `dsh-*` 终端和 Desktop 里在运行的会话一一对应，没有残留的代理进程和过期的 socket，`bridge.log` 里没有未处理的错误。
- [ ] **Windows / Linux**：启动器（`.cmd`）、命名管道、hc 在 Windows 上如何运行 `.cmd` 都没有测过。至少在 Linux 上跑通 `e2e.sh`。
- [ ] **跟进 herdrdev/herdr-app#693**（第三方集成提供自己的程序条目，例如 `programs.d/`）：维护者同意的话，`install-template` 改成写自己的片段文件，不再合并用户的 `programs.json`。

## P2：可选改进

- [ ] **hc 侧回答审批后的回显**：现在显示 `answered in hc: "allowed-once"`，直接露出了 DSH 的枚举值，可以改成 `allowed once` 这样的人话。
- [ ] **已在运行的代理不会随插件升级**：协议变化时，旧代理会收到明确的版本错误。可以让插件提示“请重开终端”，或者让代理自己重新执行启动器。
- [ ] **底部状态行**（模型、上下文用量、目录）：要在普通滚动输出里固定一行状态，需要设置滚动区域，会影响 `hc read` 读取历史的方式。等确有需要再做。
- [ ] **测试脚本自己检查环境**：现在只靠文档约束 `e2e*.sh` 不碰真实环境。可以在脚本开头检查 `DSH_HOME` 和 `HC_SESSION` 是否指向隔离环境，不是就拒绝运行。

## 暂缓

- **“看没看过”**：Desktop 本身也是一个观看者，但 Herdr 不知道它的存在，所以在 Desktop 里读过的回合，Herdr 仍会标成没看过。目前接受这个限制，等需求明确再讨论。已经想到的方向：
  1. 通用的“已查看”信号（7501 属性或 core API）。OSC 7501 不只由 Herdr 负责，还涉及开源社区的其他项目，需要另行讨论。
  2. 插件侧启发式（例如 Desktop 正在显示的会话完成时如何上报）。
