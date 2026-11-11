// What hc and Herdr App need on disk to know about DSH: the hc template `dsh` and Herdr App's
// program entry. The plugin installs both whenever it loads; `dsh-hc install-template` runs the
// same code by hand. Both leave a file or entry the person made themselves alone.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Marks a template this package wrote (hc ignores unknown header fields). */
const GENERATOR = 'dsh-herdr-bridge'

function writeAtomic(file, text) {
  writeFileSync(`${file}.tmp`, text)
  renameSync(`${file}.tmp`, file)
}

function templateDir() {
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'herdr-core', 'templates')
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'herdr-core', 'templates')
}

/**
 * Install the hc template `dsh`, so `hc run dsh "task"` starts a DSH session. Its description tells
 * Herdr agents (`hc templates`) the launcher's full path for listing and taking over sessions, so
 * nobody needs `dsh-hc` on PATH.
 * @param launcher - absolute path of the dsh-hc launcher.
 * @returns the template file and `written`, `unchanged`, or `kept` (a template the person made).
 */
export function installTemplate(launcher) {
  const quoted = /\s/.test(launcher) ? `"${launcher}"` : launcher
  const dir = templateDir()
  const file = join(dir, 'dsh.md')
  const text = `---
description: DeepSeek Harness (DSH) coding agent, like claude or codex: give it a task. Sessions opened in DSH Desktop or dsh web also show in \`hc ls\` as agent=dsh. List recent sessions: \`${quoted} ls\`; take one over: \`hc run --bg --name <name> ${quoted} attach <id|title>\`.
command: ${quoted} new
generator: ${GENERATOR}
---
`
  if (existsSync(file)) {
    const current = readFileSync(file, 'utf8')
    if (current === text) return { file, result: 'unchanged' }
    if (!current.includes(GENERATOR)) return { file, result: 'kept' }
  }
  mkdirSync(dir, { recursive: true })
  writeAtomic(file, text)
  return { file, result: 'written' }
}

// Herdr App names and draws agents from its program table: the built-in one, with the person's
// programs.json on top, entry by entry. DSH isn't built in, so add an entry for 7501 app `dsh`.
// Same folder on every platform: $HERDR_APP_HOME, else $XDG_CONFIG_HOME/herdr-app, else ~/.config/herdr-app.
const HERDR_PROGRAM = { name: 'DSH', icon: 'icons/dsh-herdr-bridge.svg', tint: true, tile: '#4d6bfe', color: '#ffffff' }

/**
 * Give DSH its name and icon in Herdr App, when Herdr App has been started here.
 * @returns the programs.json file and `written`, `kept` (a dsh entry is already there), `absent`
 * (no Herdr App), or `invalid` (not valid JSON; left alone).
 */
export function installHerdrApp() {
  const dir = process.env.HERDR_APP_HOME || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'herdr-app')
  const file = join(dir, 'programs.json')
  if (!existsSync(dir)) return { file, result: 'absent' } // Herdr App creates the folder on first start
  let table = {}
  try {
    if (existsSync(file)) table = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return { file, result: 'invalid' }
  }
  const icon = join(dir, HERDR_PROGRAM.icon)
  const ours = fileURLToPath(new URL('./assets/dsh.svg', import.meta.url))
  if (!existsSync(icon) || readFileSync(icon, 'utf8') !== readFileSync(ours, 'utf8')) {
    mkdirSync(join(dir, 'icons'), { recursive: true })
    copyFileSync(ours, icon)
  }
  if (table.programs?.dsh) return { file, result: 'kept' }
  table.programs = { ...table.programs, dsh: HERDR_PROGRAM }
  writeAtomic(file, `${JSON.stringify(table, null, 2)}\n`)
  return { file, result: 'written' }
}
