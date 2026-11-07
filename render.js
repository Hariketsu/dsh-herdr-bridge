// Turn DSH session events into terminal text, laid out the way TUI agents (Claude Code, pi) show
// a conversation: the prompt, streamed assistant text, one line per tool call with its result, and
// a closing line per turn. Pure functions plus a small per-session state object.

const CSI = '\x1b['
export const style = {
  bold: s => `${CSI}1m${s}${CSI}22m`,
  dim: s => `${CSI}2m${s}${CSI}22m`,
  red: s => `${CSI}31m${s}${CSI}39m`,
  green: s => `${CSI}32m${s}${CSI}39m`,
  yellow: s => `${CSI}33m${s}${CSI}39m`,
  cyan: s => `${CSI}36m${s}${CSI}39m`,
}

/** Raw-mode terminals need CR LF. */
export const crlf = s => s.replace(/\r?\n/g, '\r\n')
export const oneLine = (s, n = 120) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
const clip = (s, n) => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s)
const indent = (s, pad) => s.replace(/\n/g, `\n${pad}`)
const b64 = s => Buffer.from(s).toString('base64')

/** OSC 7501 Program Status Protocol report. */
export function osc({ state, msg, kind }, title) {
  const parts = [`state=${state}`, 'app=dsh']
  if (title) parts.push(`title=${b64(title)}`)
  if (msg) parts.push(`msg=${b64(msg)}`)
  if (kind) parts.push(`kind=${kind}`)
  return `\x1b]7501;${parts.join(':')}\x1b\\`
}

/** The terminal's own title (OSC 2): Herdr App names agent rows and tabs after it, as it does for TUI agents. */
export const windowTitle = title => `\x1b]2;${String(title).replace(/[\x00-\x1f\x7f]/g, '')}\x1b\\`

const textOf = content => (Array.isArray(content) ? content : [])
  .filter(p => p?.type === 'text' && typeof p.text === 'string')
  .map(p => p.text)
  .join('\n')

/** The most telling argument of a tool call, for its one-line summary. */
function toolSummary(args) {
  if (typeof args === 'string') {
    try { args = JSON.parse(args) } catch { return oneLine(args) }
  }
  if (!args || typeof args !== 'object') return ''
  for (const key of ['description', 'command', 'file_path', 'path', 'pattern', 'query', 'url', 'name', 'prompt']) {
    if (typeof args[key] === 'string' && args[key].trim()) return oneLine(args[key])
  }
  if (Array.isArray(args.questions)) return oneLine(args.questions.map(q => q?.question).join(' / '))
  return ''
}

function seconds(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

/** Per-session rendering state: which steps were streamed live, and when each turn started. */
export class Renderer {
  constructor() {
    this.cols = 100
    this.streamed = new Set()
    this.turnStarted = new Map()
    this.inText = false
    this.partial = '' // the streamed text of the step in flight
  }

  /** The step in flight as a terminal that joins now would have seen it, so it can follow on. */
  inFlight() {
    return this.inText ? `${style.cyan('⏺')} ${crlf(this.partial.replace(/\n/g, '\n  '))}` : ''
  }

  /** A durable session event (live or replayed from history) to terminal text. */
  event(event) {
    const data = event?.data ?? {}
    switch (event?.type) {
      case 'turn/start':
        this.turnStarted.set(data.turn, event.time ?? Date.now())
        return ''
      case 'user/message': {
        if (data.source?.kind !== 'user') return ''
        const text = textOf(data.content).trim()
        return text ? crlf(`\n${style.bold('❯')} ${indent(text, '  ')}\n`) : ''
      }
      case 'assistant/message': {
        // Streamed already, even if the stream began before this renderer existed (a reload).
        if (this.inText) { this.inText = false; return '\r\n' }
        if (this.streamed.has(`${data.turn}:${data.step}`)) return ''
        const text = textOf(data.message?.content).trim()
        return text ? crlf(`${style.cyan('⏺')} ${indent(text, '  ')}\n`) : ''
      }
      case 'tool/call': {
        const summary = toolSummary(data.arguments)
        const head = `${style.cyan('⏺')} ${style.bold(data.name ?? 'tool')}`
        return crlf(`${head}${summary ? ` ${style.dim(clip(summary, this.cols - (data.name?.length ?? 4) - 4))}` : ''}\n`)
      }
      case 'tool/result': {
        const message = data.message ?? {}
        const lines = textOf(message.content).split('\n').map(l => l.trimEnd())
          .filter(l => l.trim() && !/^\[(stdout|stderr)\]$/.test(l.trim()))
        const failed = message.isError || data.error !== undefined
        let first = lines[0] ?? (failed ? 'failed' : 'done')
        first = clip(first.trim(), this.cols - 16)
        const more = lines.length > 1 ? style.dim(` (+${lines.length - 1} lines)`) : ''
        return crlf(`  ${style.dim('⎿')} ${failed ? style.red(first) : style.dim(first)}${more}\n`)
      }
      case 'turn/end': {
        const reason = data.reason ?? { kind: 'completed' }
        const started = this.turnStarted.get(data.turn)
        this.turnStarted.delete(data.turn)
        const took = started !== undefined ? ` · ${seconds((event.time ?? Date.now()) - started)}` : ''
        if (reason.kind === 'completed' || reason.kind === 'max-tokens') return crlf(`${style.dim(`✻ done${took}`)}\n`)
        if (reason.kind === 'aborted') return crlf(`${style.yellow('✻ cancelled')}${style.dim(took)}\n`)
        if (reason.kind === 'interrupted') return ''
        return crlf(`${style.red(`✻ error: ${oneLine(reason.error?.message ?? reason.kind, 200)}`)}\n`)
      }
      default:
        return ''
    }
  }

  /** A live assistant-stream frame to terminal text (text deltas only). */
  stream(frame) {
    if (frame?.type === 'start') {
      this.step = `${frame.turn}:${frame.step}`
      this.inText = false
      this.partial = ''
      return ''
    }
    if (frame?.type === 'chunk' && frame.chunk?.type === 'text-delta' && frame.chunk.text) {
      const lead = this.inText ? '' : `${style.cyan('⏺')} `
      this.inText = true
      this.partial += frame.chunk.text
      if (this.step) this.streamed.add(this.step)
      return lead + crlf(frame.chunk.text.replace(/\n/g, '\n  '))
    }
    if (frame?.type === 'end') {
      const close = this.inText ? '\r\n' : ''
      this.inText = false
      this.partial = ''
      return close
    }
    return ''
  }

  /** The question an approval or ask_user_question puts to whoever answers first. */
  approval(req) {
    const what = `${req.toolName}${req.reason ? `: ${req.reason}` : ''}`
    return crlf(`${style.yellow('⏸ permission')} ${oneLine(what, 400)}\n`
      + `  ${style.dim('answer here (y = allow once, n = reject) or in DSH Desktop')}\n`)
  }

  question(q, index, total) {
    const options = q.options ?? []
    let s = `${style.yellow(`⏸ question ${index + 1}/${total}`)} ${q.header ? `${q.header}: ` : ''}${q.question}\n`
    if (q.detail) s += `  ${q.detail}\n`
    options.forEach((o, n) => { s += `  ${n + 1}. ${o.label}${o.description ? style.dim(` — ${o.description}`) : ''}\n` })
    s += `  ${style.dim(options.length
      ? `answer here (${q.multiSelect ? 'numbers like 1,3' : 'a number'}, your own text, or - to skip) or in DSH Desktop`
      : 'answer here (your text, or - to skip) or in DSH Desktop')}\n`
    return crlf(s)
  }
}
