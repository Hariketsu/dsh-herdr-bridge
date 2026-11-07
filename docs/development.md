# 开发与测试

## 从源码安装

```sh
git clone https://github.com/Hariketsu/dsh-herdr-bridge ~/dsh-herdr-bridge
dsh plugin --profile desktop add ~/dsh-herdr-bridge   # 先完全退出 Desktop；或 --profile web
```

这是链接安装：DSH 直接运行这个目录里的代码，所以目录要长期保留。之后改代码不用再退出 Desktop，执行 `scripts/desktop.sh reload` 热重载即可。

## 隔离开发环境

```sh
scripts/dev.sh up        # 模拟 LLM + 隔离 hc core + 隔离 dsh web，插件以链接方式装好，template 已安装
# 改代码…
scripts/dev.sh reload    # 热重载，Host 不重启
scripts/e2e.sh           # hc 侧回归（35 项）
scripts/e2e-ui.sh        # UI 侧回归（13 项，ego-browser）
eval "$(scripts/dev.sh env)"; hc ls; dsh-hc ls   # 手动查看隔离环境
scripts/dev.sh down      # 停掉隔离 hc core、dsh web 和 mock-llm.py
```

隔离环境的组成：

- `DSH_HOME=/tmp/dsh-iso/home`，`dsh web` 用 profile `web`。
- 隔离的 hc：`HC_SESSION=dshbridge`，`XDG_STATE_HOME` 和 `XDG_CONFIG_HOME` 指向 `/tmp/dsh-iso/xdg`。不设置 `XDG_RUNTIME_DIR`，让 hc 的 socket 留在隔离的 state 目录下（见 [upstream-notes.md](upstream-notes.md)）。
- `PATH` 前面加上隔离环境的 `dsh-hc`。`scripts/dev.sh env` 只影响当前 shell。
- `/tmp/dsh-iso` 可以保留给下次用。

`proxy.js` 的改动不需要热重载：每个新代理都会重新读文件。但已经在运行的代理还是旧代码，所以改了插件和代理之间的协议要升 `PROTOCOL`。

## 模拟 LLM

`scripts/mock-llm.py` 模拟 Anthropic Messages SSE。prompt 里的标记控制回复：

| 标记 | 效果 |
|---|---|
| `[[slow]]` / `[[slow:N]]` | 慢速回复 |
| `[[fail]]` | 模型报错 |
| `[[approve]]` | 触发提权审批 |
| `[[question]]` | 调用 ask_user_question |
| `[[env]]` | 输出 `DSH_HC_TERMINAL` |

## UI 自动化（`scripts/e2e-ui.sh`）

ego-browser 扮演 DSH 用户，hc 扮演 Herdr Agent。

- 隔离 `dsh web` 的 token URL 在 `/tmp/dsh-iso/web.log` 里。
- `console.log` 的输出在 **stderr** 上，所以脚本输出 `RESULT:` 开头的行，shell 侧用 `2>&1 | sed` 取出。
- `loc=role:…` 必须带 `[name…]`。输入框用 `loc=role:textbox[name*='commands, @ files']`，新会话和已有会话的输入框都能匹配。
- 用单引号把 JS 传给 shell 函数时，JS 里不能再出现单引号。
- 新会话的快捷键是 `Alt+Meta+n`。
- 斜杠命令要按两次 Enter：第一次选中补全项，第二次执行。
- 用完后调用 `finish({ keep: [] })` 关掉 task space。

## README 配图

```sh
scripts/demo-media.py    # 重新生成 docs/media/ 里的图（macOS，需要 Herdr App、ffmpeg、cwebp、img2webp）
```

- 另起一套全新的隔离环境（`/tmp/dsh-demo/iso`，mock 用 18766 端口）和虚构项目 `/tmp/dsh-demo/acme-api`，再开一个隔离的 Herdr App 实例连到这个 core。`scripts/dev.sh` 的开发环境和用户自己的 DSH、hc、Herdr App 都不受影响。
- 剧本在 `mock-llm.py` 的 `DEMOS` 里，按 prompt 原文匹配，所以截图里看不到标记。
- macOS 不重绘被完全遮住的窗口，`herdr-app shot` 只能拿到最后一帧。所以脚本用 `open -n` 把演示窗口调到前台，并检查每张截图都是新的；运行期间（约 1 分钟）不要切换窗口。
- 欢迎页和更新说明靠预先写入隔离 `HERDR_APP_HOME` 里的 `shared.json`、`update-notes.json` 跳过；窗口大小由 `window.json` 固定。
- DSH Web 用无头 Chromium（Playwright）截图，不依赖窗口可见。
- 产出：`herdr-app.webp`（首图）、`approval.webp`（审批，静态）、`approval.anim.webp`（审批，动图：在 Herdr 回答后 DSH 的对话框撤回）。

## 真实 Desktop

真实 Desktop 的 UI 无法自动化（Web API 需要 Electron 内部凭据），只能通过本插件的 hc 通道驱动，所以 UI 侧的测试在隔离环境里做。以下操作会改动用户的真实环境，需要授权（见 [AGENTS.md](../AGENTS.md)）：

```sh
scripts/desktop.sh reload    # 合并修改 profile 的 cordis.patch.yml 里的 reloadToken，第一次会备份；DSH_PROFILE_NAME 可选其他 profile
cd /tmp/dsh-bridge-smoke && hc run --bg --name smokeN dsh "Reply with exactly X. No tools."
hc wait smokeN; hc read smokeN; hc kill smokeN; hc rm smokeN
```

- 用的是真实模型，提示词要求固定格式的回复，便于断言。
- 要让回合跑久一点，就让模型执行 `sleep 25`。
- 真实 DSH Agent 会主动 `hc send` 回报给发起者；这些回报会作为 `<hc>` 消息出现在发起者的会话里，不是用户发的。
- 从自己的 hc 终端里启动的测试终端，父终端就是自己；kill 它们时会收到 `<hc>… exited</hc>` 通知，这是正常的。
- `scripts/desktop.sh template` 重新安装 hc template，`scripts/desktop.sh log` 看插件日志。

## 上游源码

`ref/` 放上游源码，已 gitignore。重建：

```sh
cd ref
git clone --depth 1 https://github.com/deepseek-ai/deepseek-harness
git clone --depth 1 https://github.com/herdrdev/herdr-core
git clone --depth 1 https://github.com/herdrdev/herdr-app
```

## 可移植性

- 脚本要能在 macOS 上跑：没有 `timeout` 命令，`date +%N` 不可用。
- zsh 里不要用 `path` 作变量名，它和 `PATH` 是绑定的。
- PATH 里可能有带空格的目录：生成 `export PATH=…` 时要加引号，并延迟展开 `$PATH`。
- 看代理内存用 `footprint -p <pid>`：Electron/Node 的 RSS 约 40–50 MB，其中大部分是共享代码，实际物理占用约 13 MB。
