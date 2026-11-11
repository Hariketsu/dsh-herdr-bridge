// dsh-herdr-bridge: DSH sessions as ordinary Herdr Core (hc) terminals.
//
// Each mirrored session has an hc terminal running `dsh-hc` (proxy.js), a thin pipe that connects
// to this plugin's control socket. The plugin renders the conversation (render.js) and OSC 7501
// status into that pipe, and turns keys coming back into prompts, cancellation, and answers.
// See README.md for the design.
import net from 'node:net'
import { execFile, spawn } from 'node:child_process'
import { accessSync, appendFileSync, chmodSync, constants, existsSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, delimiter, join, sep } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Renderer, crlf, oneLine, osc, style, windowTitle } from './render.js'
import { installHerdrApp, installTemplate } from './install.js'

export const name = 'herdr-bridge'

// Settings DSH validates and edits. Schemastery ships with DSH but may not resolve from a linked
// checkout; without it the settings still work from cordis.patch.yml, just unvalidated and not live.
// The volatile fields are what the Plugins page form (client.js) edits; they apply without a reload.
const Schema = await import('@deepseek-ai/schemastery').then(m => m.default, () => null)
export const Config = Schema?.object({
  herdrPlacement: Schema.union(['folder', 'dsh', 'none']).default('folder').volatile()
    .description('Where Herdr App shows the terminals of sessions started in DSH: by folder, in one space, or not at all'),
  herdrSpace: Schema.string().volatile().description('A fixed Herdr App space id; overrides herdrPlacement when set'),
  reconnectGraceSeconds: Schema.natural().default(30).description('How long a terminal waits for the plugin to come back before it exits'),
  hc: Schema.string().description('The hc executable (default: hc on PATH)'),
})

const PROTOCOL = 1
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
const HC_REQUEST_PREFIX = 'hc-'
const HISTORY_MESSAGES = 20

/** Split terminal input into submitted text (Enter outside a paste) and cancel (lone Esc / Ctrl+C). */
function inputParser({ submit, cancel, echo }) {
  let text = ''
  let pasting = false
  let held = ''
  return chunk => {
    const s = held + chunk
    held = ''
    if (s === '\x1b') return cancel()
    let i = 0
    while (i < s.length) {
      const rest = s.slice(i)
      if (rest.startsWith(PASTE_START)) { pasting = true; i += PASTE_START.length; continue }
      if (rest.startsWith(PASTE_END)) { pasting = false; i += PASTE_END.length; continue }
      if (rest[0] === '\x1b') {
        if (PASTE_START.startsWith(rest) || PASTE_END.startsWith(rest)) { held = rest; break }
        const seq = /^\x1b(\[[0-9;?]*[ -/]*[@-~]|.)/.exec(rest)
        i += seq ? seq[0].length : 1
        continue
      }
      const c = rest[0]
      i += 1
      if (pasting) { text += c === '\r' ? '\n' : c; continue }
      if (c === '\r') {
        const done = text
        text = ''
        echo('\r\n')
        if (done.trim()) submit(done)
      } else if (c === '\x7f' || c === '\b') {
        if (text) { text = text.slice(0, -1); echo('\b \b') }
      } else if (c === '\x03') {
        cancel()
      } else if (c >= ' ' || c === '\t') {
        text += c
        echo(c)
      }
    }
  }
}

/** Newline-delimited JSON on a socket. */
function lines(socket, onMessage) {
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('data', chunk => {
    buffer += chunk
    let end
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      if (!line) continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      onMessage(message)
    }
  })
}
const send = (socket, message) => { if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`) }

const realpath = p => { try { return realpathSync(p) } catch { return p } }
/** The first executable `name` in `dirs` (with Windows' extensions), like a shell's PATH lookup. */
const findOnPath = (name, dirs) => {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = join(dir, name + ext)
      try { accessSync(file, constants.X_OK); if (statSync(file).isFile()) return file } catch {}
    }
  }
  return null
}

const SKILL = `# DSH session in Herdr (herdr-bridge)

This DSH session is mirrored into Herdr Core (hc) as an ordinary terminal, and \`hc\` in your shell
acts as that terminal: use it as any agent in hc does (see the \`herdr-core\` skill or \`hc --skill\`).
Helpers you start show under you and know to report back to you.

- \`$DSH_HC_TERMINAL\` is your own hc address. It is empty until the session is mirrored (on its
  first run); until then hc doesn't know who you are, so use \`hc run --bg --no-parent …\` and ask
  for reports to a file.
- Reports from helpers, and hc's notes about them (finished, blocked, exited), arrive as your next
  user message. After starting helpers, end your turn instead of waiting; you will be woken.
- Your shell calls time out after about 60 s: if you must wait, use \`hc wait <t> --timeout 50\`
  and repeat, never a bare \`hc wait\`.
`

export function apply(ctx, config = {}) {
  // Volatile settings are references read at each use; a linked checkout passes plain values.
  const live = value => typeof value?.get === 'function' ? value.get() : value
  const herdrSpace = () => live(config.herdrSpace) || ''
  const herdrPlacement = () => live(config.herdrPlacement) || 'folder'
  const grace = Number(config.reconnectGraceSeconds ?? 30)
  const home = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'herdr-bridge')
  mkdirSync(home, { recursive: true })
  const log = (...a) => appendFileSync(join(home, 'bridge.log'), `${new Date().toISOString()} ${a.join(' ')}\n`)
  const socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\dsh-herdr-bridge-${createHash('sha1').update(home).digest('hex').slice(0, 12)}`
    : join(home, 'control.sock')

  // The launcher runs proxy.js with the Node that ships with DSH (this process's executable).
  const launcher = (() => {
    const proxy = fileURLToPath(new URL('./proxy.js', import.meta.url))
    const bin = join(home, 'bin')
    mkdirSync(bin, { recursive: true })
    if (process.platform === 'win32') {
      const file = join(bin, 'dsh-hc.cmd')
      writeFileSync(file, `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\nset "DSH_HERDR_SOCKET=${socketPath}"\r\nset "DSH_HERDR_LAUNCHER=${file}"\r\n"${process.execPath}" "${proxy}" %*\r\n`)
      return file
    }
    const q = s => `'${s.replace(/'/g, `'\\''`)}'`
    const file = join(bin, 'dsh-hc')
    writeFileSync(file, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 DSH_HERDR_SOCKET=${q(socketPath)} DSH_HERDR_LAUNCHER=${q(file)} exec ${q(process.execPath)} ${q(proxy)} "$@"\n`)
    chmodSync(file, 0o755)
    return file
  })()

  // The DSH process may have been started from an hc terminal and inherited its identity; it is not
  // that terminal, and neither are the sessions' shells. Instead, an `hc` shim first on PATH turns
  // each shell's $DSH_HC_TERMINAL into HC_TERMINAL_ID, so hc knows the session as the caller, the way
  // it knows any agent running in a terminal. The plugin's own calls go straight to the real hc.
  delete process.env.HC_TERMINAL_ID
  delete process.env.HC_TERMINAL_SOCKET
  const hc = (() => {
    const bin = join(home, 'bin')
    const pathKey = Object.keys(process.env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH'
    const dirs = (process.env[pathKey] ?? '').split(delimiter).filter(d => d && d !== bin)
    const real = config.hc && /[\\/]/.test(config.hc) ? config.hc : findOnPath(config.hc || 'hc', dirs)
    if (!real) {
      log('hc not found on PATH; set `hc` in the config')
      return config.hc || 'hc'
    }
    if (process.platform === 'win32') {
      writeFileSync(join(bin, 'hc.cmd'), `@echo off\r\nif defined DSH_HC_TERMINAL set "HC_TERMINAL_ID=%DSH_HC_TERMINAL%"\r\n"${real}" %*\r\n`)
    } else {
      const file = join(bin, 'hc')
      writeFileSync(file, `#!/bin/sh\n[ -n "\${DSH_HC_TERMINAL:-}" ] && export HC_TERMINAL_ID="$DSH_HC_TERMINAL"\nexec '${real.replace(/'/g, `'\\''`)}' "$@"\n`)
      chmodSync(file, 0o755)
    }
    process.env[pathKey] = [bin, ...dirs].join(delimiter)
    return real
  })()

  // hc's `dsh` template and Herdr App's DSH entry, kept current so nobody runs an install step.
  for (const install of [() => installTemplate(launcher), installHerdrApp]) {
    try {
      const { file, result } = install()
      if (result !== 'unchanged' && result !== 'absent') log('install', file, result)
    } catch (error) {
      log('install failed:', error?.message ?? error)
    }
  }

  const runHc = (args, done) => execFile(hc, args, (error, stdout, stderr) => {
    if (error) log('hc', args[0], 'failed:', oneLine(stderr || error.message, 300))
    done?.(error, stdout)
  })
  const hcJson = args => new Promise(resolve => runHc([...args, '--json'], (error, stdout) => {
    try { resolve(error ? null : JSON.parse(stdout)) } catch { resolve(null) }
  }))

  // Herdr App names a space it doesn't know after its first terminal's folder, and no hc label can
  // name one; only its own CLI (`herdr-app do space.rename`) can. So the shared space is named DSH
  // through that CLI, once Herdr App has made it, while its name is still the automatic folder name
  // (a name the person chose is left alone). Skipped when Herdr App isn't installed or running.
  const DSH_SPACE = 'dsh'
  const herdrAppCandidates = [process.env.HERDR_APP_BIN, '/Applications/Herdr.app/Contents/MacOS/Herdr',
    join(homedir(), 'Applications/Herdr.app/Contents/MacOS/Herdr')].filter(file => file && existsSync(file))
  const herdrApp = args => new Promise(resolve => execFile(herdrAppCandidates[0] ?? 'herdr-app', args, { timeout: 5000 },
    (error, stdout) => resolve(error ? null : stdout)))
  let naming = false
  async function nameDshSpace(cwd) {
    if (naming) return
    naming = true
    try {
      // Herdr App places a newly labeled terminal on its next listing, so the space can take a moment to exist.
      for (let attempt = 0; attempt < 15; attempt++) {
        const listed = await herdrApp(['ls'])
        if (listed === null) return
        const space = JSON.parse(listed).spaces?.find(s => s.id === DSH_SPACE)
        if (space) {
          const automatic = [space.folder, cwd].filter(Boolean).map(folder => basename(folder))
          if (space.name !== 'DSH' && automatic.includes(space.name)) {
            const done = await herdrApp(['do', 'space.rename', JSON.stringify({ id: DSH_SPACE, name: 'DSH' })])
            log('herdr app: named the shared space DSH', done === null ? '(failed)' : '')
          }
          return
        }
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
    } catch (error) {
      log('herdr app: naming the shared space failed:', error?.message ?? error)
    } finally {
      naming = false
    }
  }

  /**
   * The Herdr App space for a session started in DSH (`herdr.space` label; Herdr App only shows
   * hc terminals that carry one, and makes a new space for an id it doesn't know).
   * By folder: the space a live terminal in the same folder is already in (the person's own space
   * first), else one per folder. `dsh`: one space for every session. `none`: not placed.
   */
  async function herdrSpaceFor(cwd) {
    if (herdrSpace()) return herdrSpace()
    if (herdrPlacement() === 'none') return ''
    if (herdrPlacement() === 'dsh') return DSH_SPACE
    const here = realpath(cwd || homedir())
    const spaces = []
    for (const t of (await hcJson(['ls']))?.terminals ?? []) {
      if (!t.cwd || realpath(t.cwd) !== here) continue
      const space = (await hcJson(['get', t.address]))?.labels?.['herdr.space']
      if (space) spaces.push(space)
    }
    // The person's own space first; the plugin's (`dsh`, `dsh-…`) never count, so switching back
    // from one shared space doesn't keep pulling sessions into it.
    return spaces.find(s => s !== DSH_SPACE && !s.startsWith('dsh-'))
      ?? `dsh-${createHash('sha1').update(here).digest('hex').slice(0, 12)}`
  }

  /** Host session services, present only in hosts that have them (Desktop, `dsh web`). */
  let sessions = null
  /** The Agent registry, to know whether a session is running when its bridge is (re)created. */
  let agents = null
  /** @type {Map<string, Bridge>} by session id */
  const bridges = new Map()

  // Sessions a person is looking at in a DSH window, as client.js reports them: the session in the
  // main view while the window is visible and focused. Each window repeats its report while it
  // looks, so a window that went away without saying so stops counting after VIEW_TTL.
  const VIEW_TTL = 25_000
  /** @type {Map<string, { ids: Set<string>, timer: NodeJS.Timeout }>} by window */
  const viewers = new Map()
  const viewed = id => [...viewers.values()].some(v => v.ids.has(id))
  function setViewing(client, ids) {
    const before = viewers.get(client)
    clearTimeout(before?.timer)
    const newly = ids.filter(id => !viewed(id))
    if (ids.length) viewers.set(client, { ids: new Set(ids), timer: setTimeout(() => setViewing(client, []), VIEW_TTL) })
    else viewers.delete(client)
    // Looking again later counts again, even within the same turn.
    for (const id of newly) { const bridge = bridges.get(id); if (bridge) bridge.wroteTurn = null }
    for (const id of new Set([...(before?.ids ?? []), ...ids])) bridges.get(id)?.watch()
  }

  class Bridge {
    constructor(sessionId, cwd) {
      this.sessionId = sessionId
      this.cwd = cwd
      this.title = basename(cwd || '') || 'dsh'
      this.terminal = '' // hc address of the terminal mirroring it
      this.status = { state: agents?.get(sessionId)?.status === 'running' ? 'working' : 'idle' }
      this.statusSeen = false // whether this instance has seen the session change state itself
      this.lastEnd = null
      this.waiter = null // a pending answer typed in hc
      this.conns = new Map() // socket → { auto }
      this.renderer = new Renderer()
      this.launching = false
      this.seenWatch = null // { term, child, check }: `hc events` while in error or in view, see watch()
      this.wroteTurn = null // the turn this plugin last marked seen while the session was in view
      bridges.set(sessionId, this)
      this.loadTitle()
    }

    get short() { return this.sessionId.replace(/^session-/, '').slice(0, 8) }
    get mirrored() { return this.conns.size > 0 || this.launching }

    // A terminal that is still being caught up queues live output until its history is out.
    out(s) {
      if (!s) return
      for (const [socket, conn] of this.conns) {
        if (conn.queue) conn.queue.push(s)
        else send(socket, { t: 'out', d: s })
      }
    }
    set(state, extra = {}) {
      this.status = { state, ...extra }
      this.statusSeen = true
      this.out(osc(this.status, this.title))
      this.watch()
    }

    /**
     * `herdr.seen=<turn>` is how Herdr clients share what a person has looked at (Herdr App
     * docs/labels.md). A DSH window showing this session counts as looking, so while it does, the
     * plugin follows the terminal's `hc events` and writes the label like any Herdr client: when the
     * session comes into view and when a turn ends in view. Seeing never changes the status: like
     * Claude Code, an error stays `error` until the next turn.
     */
    watch() {
      const term = viewed(this.sessionId) ? this.terminal : ''
      if (this.seenWatch?.term === term) return this.seenWatch?.check()
      this.seenWatch?.child.kill()
      this.seenWatch = null
      if (!term) return
      const child = spawn(hc, ['events', '--json', '--terminal', term], { stdio: ['ignore', 'pipe', 'ignore'] })
      let turn = null, seen = null
      const number = value => value === undefined || value === null || value === '' ? null : Number(value)
      const check = () => {
        if (turn === null) return
        // Once per turn while in view, and only to raise it: a "mark unread" elsewhere stays.
        if (viewed(this.sessionId) && this.wroteTurn !== turn && (seen === null || seen < turn)) {
          this.wroteTurn = seen = turn
          runHc(['label', term, `herdr.seen=${turn}`])
        }
      }
      const watch = this.seenWatch = { term, child, check }
      child.on('error', error => log('hc events failed:', error.message))
      child.on('close', () => { if (this.seenWatch === watch) this.seenWatch = null })
      lines(child.stdout, message => {
        const snapshot = message.terminals?.[0]
        const { type, data } = message.params ?? {}
        if (snapshot) {
          turn = snapshot.turn
          seen = number(snapshot.labels?.['herdr.seen'])
        } else if (type === 'labels') seen = number(data?.labels?.['herdr.seen'])
        // A turn ends with its status, then a `turn` event: decide on the turn (docs/labels.md).
        else if (type === 'turn') turn = data?.turn ?? turn
        else return
        check()
      })
    }
    retitle(title) {
      title = oneLine(title, 80)
      if (!title || title === this.title) return
      this.title = title
      this.out(osc(this.status, this.title) + windowTitle(this.title))
      if (this.terminal) runHc(['label', this.terminal, `dsh.title=${title}`])
    }

    async loadTitle() {
      try {
        const item = (await sessions?.sessionController.list({}, new AbortController().signal))
          ?.items.find(i => i.sessionId === this.sessionId)
        this.retitle(item?.projections?.values?.title)
      } catch (error) {
        log('title lookup failed', this.sessionId, error?.message ?? error)
      }
    }

    /** Recent conversation, rendered like the live one, for a terminal that just joined. */
    async history(socket, auto) {
      try {
        const page = await sessions?.sessionController.page(
          { address: { kind: 'session', sessionId: this.sessionId }, maxMessages: HISTORY_MESSAGES },
          new AbortController().signal)
        const replay = new Renderer()
        replay.cols = this.renderer.cols
        // History records wrap the session event: { type: 'event', event }.
        const text = (page?.records ?? []).map(record => replay.event(record?.event ?? record)).join('')
        // An automatic mirror opens on the session's first run: its history is the turn in flight.
        if (text) send(socket, { t: 'out', d: auto ? text : text + crlf(`${style.dim('─── earlier conversation above ───')}\n`) })
      } catch (error) {
        log('history failed', this.sessionId, error?.message ?? error)
      }
    }

    async attach(socket, hello, origin) {
      this.launching = false
      // After a plugin reload an idle session can't tell how its last turn ended; the terminal
      // that comes back remembers what it last showed (done or error), so keep that.
      const kept = hello.status
      if (hello.resumed && !this.statusSeen && this.status.state === 'idle' && ['done', 'error'].includes(kept?.state)) {
        this.status = { state: kept.state, ...(kept.msg ? { msg: oneLine(kept.msg, 500) } : {}) }
      }
      const conn = { auto: Boolean(hello.auto), queue: [] }
      const inFlight = this.renderer.inFlight()
      this.conns.set(socket, conn)
      if (hello.term) {
        const changed = this.terminal !== hello.term
        this.terminal = hello.term
        if (changed) runHc(['label', this.terminal, `dsh.session=${this.sessionId}`, `dsh.title=${this.title}`])
        if (hello.auto || origin === 'desktop') this.place(hello.term)
      }
      this.watch()
      if (hello.cols) this.renderer.cols = hello.cols
      socket.on('close', () => this.conns.delete(socket))
      send(socket, { t: 'welcome', v: PROTOCOL, session: this.sessionId, origin, grace })
      // An automatic mirror opens on a run that may have ended before it joined: report the run
      // first, so hc counts the turn and Herdr's seen rules treat its done or error as news.
      const missed = hello.auto && !hello.resumed && ['done', 'error'].includes(this.status.state)
      send(socket, { t: 'out', d: (missed ? osc({ state: 'working' }, this.title) : '') + osc(this.status, this.title) + windowTitle(this.title) })
      const feed = inputParser({
        submit: text => this.submit(text),
        cancel: () => this.cancel(),
        echo: s => send(socket, { t: 'out', d: s }),
      })
      lines(socket, message => {
        if (message.t === 'in' && typeof message.d === 'string') feed(message.d)
        else if (message.t === 'size' && message.cols) this.renderer.cols = message.cols
      })
      if (!hello.resumed) {
        send(socket, { t: 'out', d: crlf(`${style.bold(this.title)} ${style.dim(`· dsh ${this.short} · ${this.cwd ?? ''}`)}\n${style.dim('Enter sends · Esc cancels')}\n`) })
        if (hello.mode === 'attach') await this.history(socket, conn.auto)
        // Text streamed before this terminal joined is not in the history yet.
        if (inFlight) send(socket, { t: 'out', d: inFlight })
      }
      for (const s of conn.queue) send(socket, { t: 'out', d: s })
      conn.queue = null
    }

    submit(text) {
      if (this.waiter) {
        const resolve = this.waiter
        this.waiter = null
        return resolve(text.trim())
      }
      return this.prompt(text)
    }

    /** Wait for the next line typed in hc; null when withdrawn. */
    ask(signal) {
      return new Promise(resolve => {
        if (signal?.aborted) return resolve(null)
        this.waiter = resolve
        signal?.addEventListener('abort', () => {
          if (this.waiter === resolve) { this.waiter = null; resolve(null) }
        }, { once: true })
      })
    }

    async prompt(text) {
      const controller = sessions?.sessionController
      if (!controller) return this.out(crlf('[bridge] this DSH host cannot take prompts\n'))
      try {
        await controller.prompt({
          requestId: HC_REQUEST_PREFIX + randomUUID(),
          sessionId: this.sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }],
        }, new AbortController().signal)
      } catch (error) {
        log('prompt failed', this.sessionId, error?.message ?? error)
        this.out(crlf(`${style.red(`[bridge] prompt failed: ${error?.message ?? error}`)}\n`))
      }
    }

    async cancel() {
      try {
        await sessions?.sessionController.cancel({ sessionId: this.sessionId })
      } catch (error) {
        log('cancel failed', this.sessionId, error?.message ?? error)
      }
    }

    /** Mirror into hc: a terminal named dsh-<short id> running `dsh-hc attach`. */
    async launch() {
      if (this.mirrored) return
      this.launching = true
      const args = ['run', '--bg', '--rm', '--no-parent', '--json', '--name', `dsh-${this.short}`,
        '--label', `dsh.session=${this.sessionId}`, '--label', `dsh.title=${this.title}`]
      const space = await herdrSpaceFor(this.cwd)
      if (space) args.push('--label', `herdr.space=${space}`)
      if (space === DSH_SPACE) nameDshSpace(this.cwd)
      if (this.cwd) args.push('--cwd', this.cwd)
      args.push('--', launcher, 'attach', '--session', this.sessionId, '--auto')
      // A failure is usually the name being taken: that terminal is still ours and reconnecting.
      runHc(args, error => { if (error) this.launching = false })
    }

    /** Put an automatic mirror into a Herdr App space, unless it is in one already (placed by us before, or moved by the person). */
    async place(term) {
      if ((await hcJson(['get', term]))?.labels?.['herdr.space']) return
      const space = await herdrSpaceFor(this.cwd)
      if (space) runHc(['label', term, `herdr.space=${space}`])
      if (space === DSH_SPACE) nameDshSpace(this.cwd)
    }

    /** Close every terminal mirroring this session; `except` keeps one. */
    release(reason, except) {
      for (const socket of this.conns.keys()) {
        if (socket === except) continue
        send(socket, { t: 'bye', reason })
        socket.end()
        this.conns.delete(socket)
      }
    }

    dispose(reason) {
      this.waiter?.(null)
      this.seenWatch?.child.kill()
      this.release(reason)
      bridges.delete(this.sessionId)
    }
  }

  const sessionOf = agent => agent?.session
  const isSubagent = agent => agent?.session.header?.origin === 'subagent'
  const bridgeFor = (sessionId, cwd) => bridges.get(sessionId) ?? new Bridge(sessionId, cwd)
  /** A top-level agent's bridge; a subagent speaks through its parent's. */
  const bridgeOf = agent => {
    const session = sessionOf(agent)
    if (!session) return undefined
    if (!isSubagent(agent)) return bridgeFor(session.id, session.header?.cwd)
    return session.header?.parentSession ? bridges.get(session.header.parentSession) : undefined
  }

  ctx.on('agent/status', ({ agent, status }) => {
    if (isSubagent(agent)) return
    const bridge = bridgeOf(agent)
    if (status === 'running') {
      bridge.lastEnd = null
      bridge.launch()
      bridge.set('working')
      return
    }
    const end = bridge.lastEnd
    if (!end || end.kind === 'completed' || end.kind === 'max-tokens') bridge.set(end ? 'done' : 'idle')
    else if (end.kind === 'aborted') bridge.set('idle')
    else bridge.set('error', { msg: oneLine(end.error?.message ?? end.kind, 500) })
  })

  ctx.on('session/event', (session, event) => {
    if (session.header?.origin === 'subagent') return
    const bridge = bridges.get(session.id)
    if (!bridge) return
    if (event.type === 'turn/end') bridge.lastEnd = event.data?.reason ?? { kind: 'completed' }
    else if (event.type === 'session/title') bridge.retitle(event.data?.title)
    bridge.out(bridge.renderer.event(event))
  })

  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (isSubagent(agent)) return
    const bridge = bridges.get(agent.session.id)
    if (bridge) bridge.out(bridge.renderer.stream(frame))
  })

  ctx.on('agent/disposed', ({ agent }) => {
    if (!isSubagent(agent)) bridges.get(agent.session.id)?.dispose('the DSH session closed')
  })

  // Blocked: Desktop and hc race to answer; the first answer wins and withdraws the other.
  // DSH forwards an approval/question to Desktop's UI and withdraws that dialog when the request's
  // signal aborts, so we hand the rest of the chain a signal we can abort. Prepended: the shipped
  // answerer never calls next(), so a later listener would never run.
  const WITHDRAWN = Symbol('withdrawn')
  const race = (kind, describe, render, fromHc, settledByDesktop) => async (req, next) => {
    const bridge = req?.agent && bridgeOf(req.agent)
    if (!bridge || bridge.conns.size === 0) return next()
    const ours = new AbortController()
    const original = req.signal
    try { req.signal = original ? AbortSignal.any([original, ours.signal]) : ours.signal } catch {}
    bridge.set('blocked', { kind, msg: oneLine(describe(req)) })
    bridge.out(render(req))
    const desktop = Promise.resolve().then(next).then(
      value => ({ from: 'desktop', value }),
      error => ({ from: 'desktop', error }),
    )
    const answered = fromHc(bridge, req, ours.signal).then(value => ({ from: 'hc', value }))
    try {
      let first = await Promise.race([desktop, answered])
      // No Desktop answerer (e.g. no window): keep waiting for hc.
      if (first.from === 'desktop' && !settledByDesktop(first)) {
        const later = await answered
        if (later.value !== WITHDRAWN) first = later
      }
      // The request was withdrawn (the turn was cancelled): Desktop's side settles on its own.
      if (first.from === 'hc' && first.value === WITHDRAWN) first = await desktop
      if (first.from === 'hc') {
        ours.abort(new Error('answered in hc'))
        desktop.catch(() => {})
        bridge.out(crlf(`  ${style.dim(`answered in hc: ${oneLine(JSON.stringify(first.value), 120)}`)}\n`))
        return first.value
      }
      ours.abort(new Error('answered in DSH Desktop'))
      bridge.out(crlf(`  ${style.dim('answered in DSH Desktop')}\n`))
      if (first.error) throw first.error
      return first.value
    } finally {
      try { req.signal = original } catch {}
      if (bridge.status.state === 'blocked') bridge.set('working')
    }
  }

  const approvalFromHc = async (bridge, req, signal) => {
    for (;;) {
      const answer = await bridge.ask(AbortSignal.any([signal, req.signal].filter(Boolean)))
      if (answer === null) return WITHDRAWN
      if (/^(y|yes|allow|1)$/i.test(answer)) return 'allowed-once'
      if (/^(n|no|reject|deny|2)$/i.test(answer)) return 'rejected'
      bridge.out(crlf(`  ${style.dim('y = allow once, n = reject')}\n`))
    }
  }

  const questionsFromHc = async (bridge, req, signal) => {
    const answers = []
    const questions = req.questions ?? []
    const stop = AbortSignal.any([signal, req.signal].filter(Boolean))
    for (const [index, q] of questions.entries()) {
      if (index > 0) bridge.out(bridge.renderer.question(q, index, questions.length))
      const answer = await bridge.ask(stop)
      if (answer === null) return WITHDRAWN
      const options = q.options ?? []
      const picks = /^\d+(\s*,\s*\d+)*$/.test(answer)
        ? answer.split(',').map(n => options[Number(n) - 1]?.label).filter(Boolean)
        : null
      if (answer === '-') answers.push({ id: q.id, selected: [] })
      else if (picks?.length) answers.push({ id: q.id, selected: q.multiSelect ? picks : picks.slice(0, 1) })
      else answers.push({ id: q.id, selected: [], custom: answer })
    }
    return { answers }
  }

  ctx.on('approval/request', race('permission',
    r => `${r.toolName}${r.reason ? `: ${r.reason}` : ''}`,
    r => bridgeOf(r.agent).renderer.approval(r),
    approvalFromHc,
    first => !first.error && first.value !== 'unavailable',
  ), { prepend: true })
  ctx.on('user-questions/request', race('question',
    r => (r.questions ?? []).map(q => q.question ?? q.header ?? '').join(' / ') || 'question',
    r => (r.questions?.length ? bridgeOf(r.agent).renderer.question(r.questions[0], 0, r.questions.length) : ''),
    questionsFromHc,
    first => !first.error,
  ), { prepend: true })

  // The control socket: dsh-hc terminals (new / attach / reconnect) and `dsh-hc ls`.
  // Only hosts that can create and prompt sessions serve it, and a live owner is never displaced.
  ctx.inject(['sessionController', 'workspaceRegistry'], c => {
    sessions = c

    /** The folder's Workspace; a subfolder of one goes ungrouped; anything else gets its own. */
    const placement = async cwd => {
      const real = realpath(cwd)
      const spaces = c.workspaceRegistry.list().map(w => ({ id: w.id, path: realpath(w.path) }))
      const exact = spaces.find(w => w.path === real)
      if (exact) return { workspaceId: exact.id }
      if (spaces.some(w => real.startsWith(w.path + sep))) return { cwd: real }
      return { workspaceId: (await c.workspaceRegistry.create(real)).id }
    }

    const recent = async days => {
      const { items } = await c.sessionController.list({}, new AbortController().signal)
      const since = Date.now() - days * 86_400_000
      return items
        .filter(i => !i.origin && !i.blank && i.updatedAt >= since)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(i => ({
          sessionId: i.sessionId,
          title: i.projections?.values?.title ?? '',
          cwd: i.cwd ?? '',
          updatedAt: i.updatedAt,
          running: i.running,
          terminal: bridges.get(i.sessionId)?.terminal ?? '',
        }))
    }

    const resolve = async (hello) => {
      const items = await recent(36500)
      if (hello.session) return items.find(i => i.sessionId === hello.session) ?? { sessionId: hello.session }
      const query = String(hello.query ?? '').trim()
      const hits = items.filter(i => i.sessionId === query || i.sessionId === `session-${query}`
        || i.sessionId.replace(/^session-/, '').startsWith(query))
      const matches = hits.length ? hits : items.filter(i => i.title.toLowerCase().includes(query.toLowerCase()))
      if (matches.length === 1) return matches[0]
      if (!matches.length) throw new Error(`no DSH session matches "${query}" (see dsh-hc ls)`)
      throw new Error(`"${query}" matches ${matches.length} sessions: ${matches.slice(0, 5)
        .map(m => `${m.sessionId.replace(/^session-/, '').slice(0, 8)} ${m.title}`).join('; ')}`)
    }

    const serve = socket => {
      let greeted = false
      socket.on('error', () => {})
      lines(socket, async message => {
        if (greeted || message.t !== 'hello') return
        greeted = true
        socket.removeAllListeners('data')
        try {
          if (message.v !== PROTOCOL) throw new Error(`dsh-hc speaks protocol ${message.v}; this plugin speaks ${PROTOCOL}`)
          if (message.mode === 'ls') {
            send(socket, { t: 'ls', items: await recent(Number(message.days) || 7) })
            return socket.end()
          }
          if (message.mode === 'new') {
            if (!message.cwd) throw new Error('missing folder')
            const { sessionId } = await c.sessionController.create(await placement(message.cwd))
            return bridgeFor(sessionId, realpath(message.cwd)).attach(socket, message, 'hc')
          }
          if (message.mode === 'attach') {
            const found = await resolve(message)
            const bridge = bridgeFor(found.sessionId, found.cwd)
            if (!message.auto && !message.resumed) {
              // A Herdr agent takes the session over: the automatic mirror makes way for it.
              for (const [other, meta] of bridge.conns) {
                if (meta.auto) { send(other, { t: 'bye', reason: `taken over by ${message.term || 'another hc terminal'}` }); other.end(); bridge.conns.delete(other) }
              }
            }
            const origin = message.resumed ? (message.origin ?? 'desktop') : (message.auto ? 'desktop' : 'hc')
            return bridge.attach(socket, message, origin)
          }
          throw new Error(`unknown mode ${message.mode}`)
        } catch (error) {
          log('control', message.mode, 'failed:', error?.message ?? error)
          send(socket, { t: 'error', message: String(error?.message ?? error) })
          socket.end()
        }
      })
    }

    const control = net.createServer(serve)
    control.on('error', error => log('control socket error', error.message))
    const probe = net.connect(socketPath)
    probe.on('connect', () => { probe.destroy(); log('control socket owned by another host; not serving it') })
    probe.on('error', () => {
      if (process.platform !== 'win32') rmSync(socketPath, { force: true })
      control.listen(socketPath)
    })
    c.effect(() => () => { control.close(); sessions = null }, 'herdr-bridge: close control socket')
  })

  // client.js reports which sessions a DSH window shows (an exact Connection Fetch route, the way
  // DSH's own session export talks to its browser half; only the owner's browsers reach it).
  ctx.inject(['connection'], c => {
    c.connection.fetch.register({
      path: '/api/herdr-bridge.viewing',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async request => {
        const body = await request.json().catch(() => null)
        if (typeof body?.client !== 'string' || !Array.isArray(body.sessions)) return new Response('bad request', { status: 400 })
        setViewing(body.client, body.sessions.filter(id => typeof id === 'string'))
        return new Response(null, { status: 204 })
      },
    })
  })

  // An archived session is hidden everywhere in DSH, so its terminals close too. DSH emits
  // `domain/changed` once the archive set is durable, with the new set in its value (what its own
  // workspace feed follows; the registry's getter can still hold the old set at that point).
  ctx.on('domain/changed', change => {
    if (change.domain !== 'workspace' || change.table !== '' || change.operation !== 'put') return
    for (const id of change.value?.archivedSessionIds ?? []) bridges.get(id)?.dispose('the DSH session was archived')
  })

  // /herdr: mirror this session into Herdr now and show its hc address.
  // The Plugins page shows this plugin's own settings page (client.js), not a generated one.
  ctx.inject(['settings'], c => { c.effect(() => c.settings.configure({ auto: false }, ctx.fiber), 'herdr-bridge: own settings page') })

  ctx.inject(['commands'], c => {
    c.commands.register({
      name: 'herdr',
      description: 'Show this session in Herdr (hc) and print its hc address',
      handler: async ({ agent }) => {
        if (!agent || isSubagent(agent)) return { kind: 'error', text: 'Only a top-level session can be shown in Herdr.' }
        const bridge = bridgeOf(agent)
        bridge.launch()
        for (let i = 0; i < 50 && !bridge.terminal; i++) await new Promise(r => setTimeout(r, 100))
        if (!bridge.terminal) return { kind: 'error', text: 'Could not open an hc terminal; see ~/.dsh/herdr-bridge/bridge.log' }
        return { kind: 'success', text: `In Herdr as ${bridge.terminal} (dsh-${bridge.short}). A Herdr agent can use: hc send ${bridge.terminal} "…" / hc read ${bridge.terminal}` }
      },
    })
  })

  // Reverse direction: each session's shell learns its own hc address; the model learns how to use it.
  ctx.inject(['shellEnv'], c => {
    c.shellEnv.register({
      name: 'herdr-bridge',
      variables: { DSH_HC_TERMINAL: { description: "This session's own Herdr Core (hc) terminal address." } },
      resolve: execution => {
        const bridge = execution.agent && bridgeOf(execution.agent)
        return bridge?.terminal ? { DSH_HC_TERMINAL: bridge.terminal } : {}
      },
    })
  })
  ctx.inject(['skills'], c => {
    c.skills.register({
      name: 'herdr-bridge',
      description: 'Use hc from this DSH session: your own hc address ($DSH_HC_TERMINAL), starting helper agents that report back to you, and waiting without blocking.',
      whenToUse: 'Before using hc (Herdr Core) to start, message, or wait for other agents or terminals.',
      source: 'runtime',
      content: SKILL,
    })
  })

  // After a reload, proxies reconnect on their own; mirror the running sessions that did not.
  ctx.inject(['agents'], c => {
    agents = c.agents
    const timer = setTimeout(() => {
      for (const agent of c.agents.list()) {
        if (agent.status === 'running' && !isSubagent(agent)) bridgeOf(agent).launch()
      }
    }, 3000)
    c.effect(() => () => { clearTimeout(timer); agents = null }, 'herdr-bridge: re-mirror running sessions')
  })

  ctx.effect(() => () => {
    // Proxies keep their terminals and reconnect to the next instance within the grace period.
    for (const bridge of bridges.values()) {
      bridge.waiter?.(null)
      bridge.seenWatch?.child.kill()
      for (const socket of bridge.conns.keys()) socket.destroy()
    }
    bridges.clear()
    for (const v of viewers.values()) clearTimeout(v.timer)
    viewers.clear()
  }, 'herdr-bridge: drop connections')
  log('loaded', Schema ? '(settings schema on)' : '(settings schema off: schemastery not found)', `herdrPlacement=${herdrPlacement()}`)
}
