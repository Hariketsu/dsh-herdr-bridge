// dsh-hc: the program inside a DSH session's hc terminal, and a small CLI.
// It is a thin pipe: raw keys and window size go to the dsh-herdr-bridge plugin; rendered text
// (including OSC 7501 status) comes back and is written as is. When the plugin goes away (reload,
// update, Desktop quitting) it keeps the terminal and reconnects within a grace period.
//
//   dsh-hc new                          a new DSH session in the current folder (hc template `dsh`)
//   dsh-hc attach <session id | title>  take over an existing DSH session
//   dsh-hc ls [--days N] [--json]       recent DSH sessions
//   dsh-hc install-template             install the hc template `dsh` and DSH's Herdr App entry again
//                                       (the plugin does this itself whenever it loads)
//
// Started through the launcher the plugin writes ($DSH_HOME/herdr-bridge/bin/dsh-hc), which sets
// DSH_HERDR_SOCKET and runs this file with the Node that ships with DSH Desktop.
import net from 'node:net'
import { installHerdrApp, installTemplate } from './install.js'

const PROTOCOL = 1
const SOCKET = process.env.DSH_HERDR_SOCKET
const LAUNCHER = process.env.DSH_HERDR_LAUNCHER
const dim = s => `\x1b[2m${s}\x1b[22m`
const b64 = s => Buffer.from(s).toString('base64')
const errorStatus = msg => `\x1b]7501;state=error:app=dsh:msg=${b64(msg)}\x1b\\`

function fail(message, code = 1) {
  process.stderr.write(`dsh-hc: ${message}\n`)
  process.exit(code)
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
const send = (socket, message) => { if (socket && !socket.destroyed) socket.write(`${JSON.stringify(message)}\n`) }

/** One request, one reply: `ls`. */
function request(hello) {
  return new Promise((resolve, reject) => {
    if (!SOCKET) return reject(new Error('DSH_HERDR_SOCKET is not set; run dsh-hc through its launcher'))
    const socket = net.connect(SOCKET)
    socket.on('error', () => reject(new Error('DSH Desktop is not running, or dsh-herdr-bridge is not loaded')))
    socket.on('connect', () => send(socket, { t: 'hello', v: PROTOCOL, ...hello }))
    lines(socket, message => {
      socket.end()
      if (message.t === 'error') reject(new Error(message.message))
      else resolve(message)
    })
  })
}

/** Interactive terminal mode: `new` and `attach`. */
function terminal(first) {
  const out = process.stdout
  const size = () => ({ cols: out.columns || 100, rows: out.rows || 30 })
  let socket = null
  let welcome = null // { session, origin, grace } once the plugin accepted us
  let live = false
  let leaving = false
  let deadline = 0
  let status = null // the last OSC 7501 report shown, handed back on reconnect

  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  out.write('\x1b[?2004h') // bracketed paste: hc send arrives as one paste
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', d => {
    if (live) send(socket, { t: 'in', d })
    else out.write(dim('\r\n(not sent: reconnecting to DSH Desktop)\r\n'))
  })
  out.on('resize', () => send(socket, { t: 'size', ...size() }))

  const leave = code => {
    leaving = true
    socket?.destroy()
    process.exit(code)
  }

  const connect = hello => {
    socket = net.connect(SOCKET)
    socket.on('connect', () => send(socket, { t: 'hello', v: PROTOCOL, term: process.env.HC_TERMINAL_ID ?? '', ...size(), ...hello }))
    lines(socket, message => {
      if (message.t === 'welcome') {
        const again = welcome !== null
        welcome = { session: message.session, origin: message.origin, grace: message.grace ?? 30 }
        live = true
        deadline = 0
        if (again) out.write(dim('⋯ reconnected\r\n'))
      } else if (message.t === 'out') {
        out.write(message.d)
        status = lastStatus(message.d) ?? status
      } else if (message.t === 'bye') {
        if (message.reason) out.write(dim(`\r\n⋯ ${message.reason}\r\n`))
        leave(0)
      } else if (message.t === 'error') {
        out.write(`${errorStatus(message.message)}dsh-hc: ${message.message}\r\n`)
        leave(1)
      }
    })
    socket.on('error', () => {})
    socket.on('close', () => {
      live = false
      if (leaving) return
      if (!welcome) {
        // Never got in: the plugin is not there (or refused). Report it so hc and its caller see why.
        out.write(`${errorStatus('DSH Desktop is not running, or dsh-herdr-bridge is not loaded')}`
          + 'dsh-hc: DSH Desktop is not running, or dsh-herdr-bridge is not loaded\r\n')
        return setTimeout(() => leave(1), 200)
      }
      if (!deadline) {
        deadline = Date.now() + welcome.grace * 1000
        out.write(dim(`\r\n⋯ DSH Desktop disconnected; reconnecting for up to ${welcome.grace}s\r\n`))
      }
      if (Date.now() > deadline) {
        out.write(dim('⋯ DSH Desktop did not come back\r\n'))
        return leave(0)
      }
      setTimeout(() => {
        connect({ mode: 'attach', session: welcome.session, origin: welcome.origin, resumed: true, status })
      }, 1000)
    })
  }

  if (!SOCKET) fail('DSH_HERDR_SOCKET is not set; run dsh-hc through its launcher')
  connect(first)
}

/** The last OSC 7501 report in a chunk of output, as { state, msg }. */
function lastStatus(text) {
  const reports = [...text.matchAll(/\x1b\]7501;([^\x07\x1b]*)/g)]
  if (!reports.length) return null
  const fields = Object.fromEntries(reports.at(-1)[1].split(':').map(f => [f.slice(0, f.indexOf('=')), f.slice(f.indexOf('=') + 1)]))
  return { state: fields.state, msg: fields.msg ? Buffer.from(fields.msg, 'base64').toString() : '' }
}

function installAll() {
  if (!LAUNCHER) fail('DSH_HERDR_LAUNCHER is not set; run dsh-hc through its launcher')
  for (const { file, result } of [installTemplate(LAUNCHER), installHerdrApp()]) {
    const note = { written: '', unchanged: ' (already up to date)', kept: ' (kept: you made this one)',
      absent: ' (skipped: Herdr App not started here yet)', invalid: ' (left alone: not valid JSON)' }[result]
    process.stdout.write(`${file}${note}\n`)
  }
}

// Terminal columns a string takes: East Asian wide and full-width characters take two.
const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u
const width = s => [...s].reduce((w, ch) => w + (WIDE.test(ch) ? 2 : 1), 0)
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - width(s)))

function table(items) {
  if (!items.length) return 'no DSH sessions in that period\n'
  const rows = items.map(i => [
    i.sessionId.replace(/^session-/, '').slice(0, 8),
    new Date(i.updatedAt).toISOString().slice(0, 16).replace('T', ' '),
    i.running ? 'running' : '',
    i.terminal || '',
    i.title || '(untitled)',
    i.cwd || '',
  ])
  const head = ['ID', 'UPDATED', 'STATE', 'HC', 'TITLE', 'FOLDER']
  const widths = head.map((h, c) => Math.max(width(h), ...rows.map(r => width(r[c]))))
  return [head, ...rows].map(r => r.map((v, c) => (c === r.length - 1 ? v : pad(v, widths[c]))).join('  ')).join('\n') + '\n'
}

const [command, ...args] = process.argv.slice(2)
const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }

switch (command) {
  case 'new':
    terminal({ mode: 'new', cwd: process.cwd() })
    break
  case 'attach': {
    const session = flag('--session')
    const query = session ?? args.filter(a => !a.startsWith('--')).join(' ')
    if (!query) fail('usage: dsh-hc attach <session id | title>', 2)
    terminal({ mode: 'attach', ...(session ? { session } : { query }), auto: args.includes('--auto') })
    break
  }
  case 'ls': {
    const days = Number(flag('--days') ?? 7)
    request({ mode: 'ls', days }).then(
      reply => process.stdout.write(args.includes('--json') ? `${JSON.stringify(reply.items, null, 2)}\n` : table(reply.items)),
      error => fail(error.message),
    )
    break
  }
  case 'install-template':
    installAll()
    break
  default:
    fail('usage: dsh-hc new | attach <session id | title> | ls [--days N] [--json] | install-template', 2)
}
