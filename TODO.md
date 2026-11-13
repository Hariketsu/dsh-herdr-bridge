# TODO

已经实现的见 [docs/architecture.md](docs/architecture.md)。下面只列还没做的，按优先级排。

## P0：公开发布前

- [ ] **Desktop 和 `dsh web` 同时运行**：后启动的那个不提供控制 socket（`index.js` 里的 probe），但它的插件可能仍然会为自己的会话开终端，这些终端会连到另一个 Host。先实测会发生什么；至少保证不出现连错 Host 的终端，然后把 README 里这条限制写准确。

## P1：已知问题与待验证

- [ ] **`turn/end{max-tokens}` 是否该映射为 `done`**：回合因为输出上限被截断，不一定是任务完成。对照 hc 的状态语义，以及 Claude Code 等原生 Agent 在同类情况下报什么，再决定是 `done` 还是 `error`。
- [ ] **用户在真实 Desktop 里发起的会话**：隔离 `dsh web` 里由 `e2e-ui.sh` 覆盖，真实 Desktop 没法自动化。通过标准：正常使用时，会话一开始运行，Herdr App 里就出现 `dsh-<短 id>`，状态随回合变化。
- [ ] **`hc interrupt` 会不会清掉已排队的消息**：插件调用的是 `sessionController.cancel`，按 DSH 文档默认会清空排队和插话的输入。写一个测试：排两条消息后 interrupt，确认行为并写进两份 README。
- [ ] **多题提问、多选、请求中途被撤回**：代码有处理，测试只覆盖单题单选和撤回提问。补进 `e2e.sh`（mock-llm 需要能出多题、多选的提问）。
- [ ] **会话删除时终端是否随之结束**：归档已处理（终端关闭，`e2e-ui.sh` 覆盖）；删除只覆盖了 Agent 释放这条路径。另外，插件重载期间归档的会话，重连回来的终端不会被关掉。
- [ ] **长时间运行的稳定性**：场景是一天几十个会话、Desktop 睡眠唤醒、hc core 重启。通过标准：每个场景之后，`hc ls` 里的 `dsh-*` 终端和 Desktop 里在运行的会话一一对应，没有残留的代理进程和过期的 socket，`bridge.log` 里没有未处理的错误。
- [ ] **Windows / Linux**：启动器和 `hc` 垫片（`.cmd`）、命名管道、hc 在 Windows 上如何运行 `.cmd` 都没有测过。至少在 Linux 上跑通 `e2e.sh`。
- [ ] **跟进 herdrdev/herdr-app#693**（第三方集成提供自己的程序条目，例如 `programs.d/`）：维护者同意的话，`install-template` 改成写自己的片段文件，不再合并用户的 `programs.json`。

## P2：可选改进

- [ ] **插件页组件行的文案和顶部重复**：DSH 按组件的模块名读 `locale`，我们唯一的组件就是包本身，所以标题和简介只能和顶部一样；改用子路径模块又会丢掉浏览器端（设置页）。彻底解决要按官方 bundle 结构拆成两个包（外壳 + core），代价见 2026-11-07 的讨论：两个 npm 包、新包首发要手动 OTP、已有 `cordis.patch.yml` 条目的迁移要先实测。
- [ ] **改了放置方式，已放进 Herdr App 的终端不会移动**：Herdr App 只放置还没有位置的终端，改 `herdr.space` 标签不会挪动已有的。可以考虑在设置变化时提示，或者等 Herdr App 提供移动终端的接口。
- [ ] **hc 侧回答审批后的回显**：现在显示 `answered in hc: "allowed-once"`，直接露出了 DSH 的枚举值，可以改成 `allowed once` 这样的人话。
- [ ] **已在运行的代理不会随插件升级**：协议变化时，旧代理会收到明确的版本错误。可以让插件提示“请重开终端”，或者让代理自己重新执行启动器。
- [ ] **底部状态行**（模型、上下文用量、目录）：要在普通滚动输出里固定一行状态，需要设置滚动区域，会影响 `hc read` 读取历史的方式。等确有需要再做。
- [ ] **真实 Desktop 上“窗口不在前台不算看过”**：ego-browser 里测不了（另开标签页时原页面仍报可见、有焦点），要在真实 Desktop 上手动确认：DSH 窗口在后台时完成的回合，Herdr 里应仍是 Done。
- [ ] **`dsh-hc new` 指定模型**：hc 的 skill 约定模板的 `command` 里带模型（`claude --model …`），`dsh-hc new` 不接受参数，只能用 profile 的默认模型。先确认 DSH 新建会话时能否指定模型。
- [ ] **子 Agent 审批的转发分支用不上**：`index.js` 的 `bridgeOf` 把子 Agent 的请求交给父会话的终端，但 DSH 里子 Agent 不会发起审批或提问（见 upstream-notes “DSH 审批与提问”）。可以删掉这个分支，或者留着以防上游放开。
- [ ] **侧栏 Agent 终端里的 `hc` 没有身份**：启用 DSH 的持久终端（`dsh-experimental-terminal-bundle`）后，Agent 在侧栏终端里运行的命令不经过 shellEnv，拿不到 `DSH_HC_TERMINAL`，那里的 `hc` 不会带上会话自己的身份。默认的 Desktop profile 没有这个 bundle；有人用到再看能否通过它的 `environment` 配置补上。
- [ ] **测试脚本自己检查环境**：现在只靠文档约束 `e2e*.sh` 不碰真实环境。可以在脚本开头检查 `DSH_HOME` 和 `HC_SESSION` 是否指向隔离环境，不是就拒绝运行。

## 暂缓

- **在 Herdr 里看过，清掉 DSH 侧栏的完成提醒**：DSH 的 `completionUnread` 只存在浏览器进程里，插件改不了。等 DSH 提供接口再说。
