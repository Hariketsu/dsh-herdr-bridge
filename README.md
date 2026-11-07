# dsh-herdr-bridge

English | [简体中文](README.zh-CN.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that brings DSH sessions into [Herdr Core](https://github.com/herdrdev/herdr-core) (`hc`). Each session becomes an hc terminal, so other agents in Herdr can read and drive it the way they drive Claude Code. Works with DSH Desktop and DSH Web (`dsh web`).

Once it's installed:

- **DSH sessions show up in Herdr.** When a session starts running, a `dsh-<short id>` terminal appears in [Herdr App](https://github.com/herdrdev/herdr-app). Its status follows the session through `working / done / blocked / error`.
- **Herdr drives DSH.** Herdr agents use `hc run / send / wait / read / interrupt` to start sessions, take over existing ones, send messages and cancel turns.
- **DSH drives other agents.** The model in a DSH session can start helpers with `hc` (Claude Code, for example), and their reports come back to that session.
- **Approvals can be answered on either side.** When a session waits for an approval or a question, answer it in the DSH window or in hc. The first answer wins, and the other side's dialog is withdrawn.

The plugin runs inside DSH's own process. It needs no second copy of DSH and changes no DSH or Herdr source code.

## What it looks like

![Three DSH sessions in Herdr App: one waiting for approval, one working, one finished; on the right, the finished session's conversation](https://raw.githubusercontent.com/Hariketsu/dsh-herdr-bridge/main/docs/media/herdr-app.webp)

Three DSH sessions in Herdr App, each in a different state. On the right is one session as it looks in its hc terminal: the prompt, the reply, tool calls with their descriptions, and how long the turn took, in the same format as native TUI agents.

## Requirements

| | Developed against | Notes |
|---|---|---|
| DSH (Desktop or `dsh web`) | 0.2.2-rc.1 | The DSH interfaces the plugin uses are still changing, so a DSH upgrade may need a plugin update. `dsh headless` isn't supported; `dsh tui` hasn't been tested |
| herdr-core (`hc`) | 0.1.18 | `hc` must be on your login shell's PATH, or set in the config |
| herdr-app | 0.1.13 | Optional |

Only one of Desktop and `dsh web` can be connected to Herdr at a time (see Known limitations).

Platforms: tested on macOS only. Windows and Linux are implemented but untested. There are no minimum versions yet; only the combination above is known to work.

## Install

1. Add the plugin to the DSH profile you use: `desktop` for Desktop (quit Desktop fully with ⌘Q first), or `web` for `dsh web` (stop it first):
   ```sh
   dsh plugin --profile desktop add dsh-herdr-bridge   # or --profile web
   ```
2. Reopen Desktop or start `dsh web`. That's all: when the plugin loads, it installs the hc template, so Herdr agents can run `hc run dsh "task"`, and, if you use Herdr App, DSH's name and icon there.

**Check that it works:**

```sh
hc templates       # lists dsh
```

Then send any message in DSH. A `dsh-<short id>` terminal should appear in `hc ls`.

**Uninstall:** quit Desktop or stop `dsh web`, then run `dsh plugin --profile <profile> remove dsh-herdr-bridge`. If you added `herdr-bridge` settings to `~/.dsh/profiles/<profile>/cordis.patch.yml`, remove them too. Then delete `~/.config/herdr-core/templates/dsh.md`, `~/.dsh/herdr-bridge/`, the `dsh` entry in `~/.config/herdr-app/programs.json`, and `~/.config/herdr-app/icons/dsh-herdr-bridge.svg`. Any `dsh-*` terminals still open exit on their own after the grace period.

## Quick start

**1. Use DSH as usual.** The first time a session runs, the plugin opens a `dsh-<short id>` terminal for it. The terminal's title is the session title and follows renames. The terminal is labeled `dsh.session=<session id>` and `dsh.title=<session title>`. To bring a session that hasn't run yet into Herdr, type `/herdr` in it; the command prints its hc address. When the session closes, its terminal ends.

**2. Start a DSH session from Herdr.** `/repo` and `fix` are example values:

```sh
hc run --bg --name fix --cwd /repo dsh "Fix the failing test in x.rs"
hc wait fix               # wait for the turn to finish
hc read fix               # read the reply
hc send --wait fix "Go on, and cover the edge cases too"
```

Where the new session goes depends on its folder. If the folder is exactly one of your DSH workspaces, the session joins that workspace. If it's a subfolder of a workspace, the session is created as "Ungrouped" and keeps that folder. Any other folder is added as a new workspace.

**3. Take over an existing session.**

```sh
~/.dsh/herdr-bridge/bin/dsh-hc ls --days 7                         # session id, title, folder, and whether it's already in hc
hc run --bg --name login ~/.dsh/herdr-bridge/bin/dsh-hc attach 3b729fc9   # by id, id prefix, or part of the title
hc read login                                                       # the earlier conversation first, then anything new
```

`dsh-hc` is the small command the plugin creates; it doesn't need to be on your PATH. Herdr agents find its full path in the `dsh` template's description (`hc templates`).

If the session already has an automatic `dsh-<short id>` terminal, that terminal exits and the one taking over replaces it.

**4. Cancel when needed.** `hc interrupt fix` cancels the current turn, like pressing stop in DSH.

## Approvals, questions and trust

When a session waits for an approval or a question, DSH shows its dialog as usual. The hc terminal shows the same question, with status `blocked`.

![Left: the approval dialog in DSH Web. Right: the same session in Herdr App, waiting on the same approval](https://raw.githubusercontent.com/Hariketsu/dsh-herdr-bridge/main/docs/media/approval.webp)

Answering from hc needs `--force`:

```sh
hc send --force fix y      # allow once; n rejects
hc send --force fix 1,3    # a question: option numbers (comma-separated for several), free text, or - to skip
```

This is the same rule hc applies to every agent: it refuses a plain `send` to a blocked program, and `--force` is the only way through. The plugin never answers on its own. When `--force` is appropriate is up to the instructions of the agent driving it (see `hc --skill`).

Boundaries to know:

- **Who can drive a session:** any process that can use your hc can read and drive a mirrored DSH session, as with any other hc terminal. The plugin's control socket is `~/.dsh/herdr-bridge/control.sock`, local to your machine.
- **No extra permissions:** messages from hc go through DSH's normal prompt path, so the session's sandbox and approval rules still apply.
- **Input from hc becomes a user message:** text from `hc send`, helper reports and hc notices (finished, blocked, exited) arrive as the next user message in the DSH session and wake it up. Messages from hc carry an `<hc …>` marker, so the model can see where they came from, but they sit in the same place as messages you type.

## DSH driving other agents

The plugin gives each mirrored session `DSH_HC_TERMINAL`, its own hc address. It also registers a skill, `herdr-bridge`, that tells the model to start helpers like this:

```sh
hc run --bg --parent "$DSH_HC_TERMINAL" --name helper --cwd /repo claude "… when done, report with hc send $DSH_HC_TERMINAL"
```

General hc usage comes from `~/.agents/skills/herdr-core`, which DSH discovers automatically.

## Configuration

Open **Plugins → dsh-herdr-bridge → Configure** in DSH to choose where sessions show in Herdr App; changes apply without a restart. Everything can also be set, all optional, under the `herdr-bridge` entry in `~/.dsh/profiles/<profile>/cordis.patch.yml`:

```yaml
- id: herdr-bridge
  config:
    herdrPlacement: folder      # where Herdr App shows sessions started in DSH: folder (default), dsh, or none
    herdrSpace: sp123           # a fixed Herdr App space id; overrides herdrPlacement
    reconnectGraceSeconds: 30   # how long a terminal waits for the plugin to come back before exiting (default 30)
    hc: /path/to/hc             # the hc executable; default: hc on PATH
```

Herdr App only shows hc terminals placed in one of its spaces. With `folder`, a session started in DSH joins the Herdr App space that already has a terminal in the same folder; if there is none, Herdr App opens a new space for that folder. With `dsh`, all of them share one space, named after the first session's folder until you rename it in Herdr App. With `none`, they stay out of Herdr App but still show in `hc ls` and other clients. Sessions a Herdr agent starts with `hc run dsh` show under that agent either way.

## Troubleshooting

Start with the log, `~/.dsh/herdr-bridge/bridge.log`.

| Symptom | Check |
|---|---|
| A session you started in DSH shows in `hc ls` but not in Herdr App | Check `herdrPlacement` isn't `none`. Herdr App only shows terminals placed in a space; terminals from an older plugin version are placed when they reconnect |
| A session you're using in DSH isn't in `hc ls` | The log, for plugin load or terminal start failures. Whether DSH can find `hc`: Desktop uses your login shell's PATH and `dsh web` uses the PATH of the shell that started it; if needed, set `hc` in the config. Whether Desktop and `dsh web` are both running (see Known limitations) |
| `hc run dsh …` can't find the template, or `~/.dsh/herdr-bridge/bin/dsh-hc` doesn't exist | The plugin didn't load; check the log. A `dsh` template you wrote yourself is never replaced; delete it to get ours, or run `~/.dsh/herdr-bridge/bin/dsh-hc install-template` |
| DSH sessions show a generic robot icon in Herdr App | Herdr App had never been started when the plugin loaded: restart DSH, or run `~/.dsh/herdr-bridge/bin/dsh-hc install-template`. A `dsh` entry already in `programs.json` is kept |
| The terminal shows "disconnected → reconnected" | The plugin reloaded (for example, you changed a setting in DSH). This is expected, and the address stays the same |
| A `dsh-*` terminal exits suddenly | DSH quit, or the plugin didn't come back within `reconnectGraceSeconds`. Reopen DSH; the session is mirrored again the next time it runs |
| A terminal reports a protocol version mismatch | It's still running the proxy from before a plugin upgrade. Close it and `attach` again |
| The plugin stops working after a DSH upgrade | The DSH interfaces changed. Downgrade DSH for now or wait for a plugin update, and attach the log to an issue |

## Known limitations

- **Desktop and `dsh web` can't both be connected:** they share `~/.dsh/herdr-bridge/`, and only the one started first connects to Herdr.
- **Turns you've read in DSH still show as unseen in Herdr:** Herdr doesn't know the DSH window is also a viewer.
- **Each mirrored session runs a proxy process**, using about 13–14 MB of physical memory.
- **After a plugin upgrade, open terminals keep the old proxy** until they're reopened.
- **Withdrawing the other side's dialog relies on DSH internals:** if a DSH change breaks it, the DSH dialog stays open. It never causes a wrong approval.

Plans and untested paths are in [TODO.md](TODO.md).

## How it works

Each hc terminal runs a thin proxy, `dsh-hc`, on the same Node that runs DSH (on Desktop, the one bundled with it). It connects over a local socket to the plugin inside the DSH process. The plugin renders DSH events as terminal text and OSC 7501 status, and turns terminal input into prompts, cancels or approval answers. When the plugin reloads, the proxy reconnects and the hc address stays the same.

The architecture, status mapping, how racing answers work, rejected approaches and test coverage are in [docs/architecture.md](docs/architecture.md) (in Chinese).

## Development

Installing from source, the dev loop and the isolated test environment are in [docs/development.md](docs/development.md) (in Chinese); how agents work on this repo is in [AGENTS.md](AGENTS.md). In short:

```sh
scripts/dev.sh up          # isolated world: mock LLM + isolated hc core + isolated dsh web (Desktop stand-in)
scripts/dev.sh reload      # hot-reload the plugin
scripts/e2e.sh             # 39 hc-side checks
scripts/e2e-ui.sh          # 14 UI-side checks (ego-browser)
scripts/dev.sh down
scripts/desktop.sh reload  # hot-reload changes into your real Desktop (only touches the herdr-bridge entry in cordis.patch.yml; backs it up the first time)
scripts/demo-media.py      # regenerate the README media from a scripted, fully isolated demo
```

## License

MIT. `assets/dsh.svg` is the DeepSeek Harness logo, taken from [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (MIT, Copyright (c) 2026 DeepSeek). The DeepSeek name and logo belong to their owner.
