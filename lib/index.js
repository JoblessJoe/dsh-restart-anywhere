// dsh-restart-anywhere — host half. One restart button for every way dsh is hosted.
//
// The core trick is restarting *in place*: dsh tears its plugin tree down
// gracefully (ctx.appExit, the launcher's own shutdown path), then the same
// process turns into a fresh dsh. Whatever launched dsh — a terminal, tmux,
// Docker without a restart policy, pm2, Kubernetes, launchd, runit, nssm —
// keeps seeing the same PID that never exited, so no supervisor needs
// detecting or configuring, and terminal output keeps flowing where it was.
//
//   execve   Node >= 22.15 on Linux/macOS: process.execve() swaps the process
//            image for a new dsh. Same PID, nothing left behind.
//   wrapper  Windows / older Node: this process stays alive as a thin parent,
//            starts the fresh dsh as its child, forwards signals and mirrors its
//            exit code. A later restart from inside that child just exits with
//            code 75 and the wrapper starts the next one, so there's never more
//            than one wrapper.
//
// systemd gets its native path first (`systemd-run --on-active=1 systemctl
// restart`): a fresh process with no wrapper left behind. The timer lets this
// HTTP reply reach the browser before systemd stops us. If that fails (a system
// unit without root, say), in-place takes over.
//
// The route sits under /api via ctx.connection.fetch, so dsh's own Host/Origin
// fence and browser-cookie auth apply before this handler ever runs.
//
// Agents get the same restart as a `dsh_restart` tool (root sessions only). An
// optional continue_prompt is parked in a wake file; the next dsh reads it on
// boot and follows up into that session, the way dsh's own schedule does.
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'dsh-restart-anywhere'
export const inject = ['connection']

const RESTART_CODE = 75 // child -> wrapper: "start me again"
const PARENT_ENV = 'DSH_RESTART_ANYWHERE_PARENT'
const BOOT = `${process.pid}-${Date.now()}` // lets the browser tell the new server from the old
const WAKE_FILE = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'restart-anywhere', 'wake.json')
const WAKE_TTL = 5 * 60_000 // a wake older than this belongs to a restart that never happened
const readCgroup = () => { try { return readFileSync('/proc/self/cgroup', 'utf8') } catch { return '' } }

/** The systemd service this process runs in, from its cgroup (v2 or v1); null otherwise. */
export function systemdUnit(cgroup) {
  // v2: "0::/user.slice/user-1000.slice/user@1000.service/app.slice/dsh-web.service"
  // v1: "1:name=systemd:/system.slice/dsh.service"
  const line = cgroup.split('\n').find(l => l.startsWith('0::')) ?? cgroup.split('\n').find(l => l.includes(':name=systemd:'))
  const path = line ? line.slice(line.indexOf(':', line.indexOf(':') + 1) + 1) : ''
  const unit = path.split('/').reverse().find(s => s.endsWith('.service'))
  if (!unit || unit.startsWith('user@')) return null
  return { unit, user: path.includes('/user@') }
}

/** How a restart will happen: { mode: 'systemd' | 'child' | 'in-place' | null, via, ... }. */
export function detect({ platform = process.platform, env = process.env, ppid = process.ppid,
  cgroup = platform === 'linux' ? readCgroup() : '', versions = process.versions, argv = process.argv,
  execve = typeof process.execve === 'function' } = {}) {
  if (versions.electron) return { mode: null, via: 'desktop app' } // the desktop app owns its own lifecycle
  if (env[PARENT_ENV] && env[PARENT_ENV] === String(ppid)) return { mode: 'child', via: 'wrapper' }
  // `--port 0` under systemd: a unit restart would land on a new random port, so stay in place.
  const unit = platform === 'linux' && env.INVOCATION_ID && !randomPort(argv) ? systemdUnit(cgroup) : null
  if (unit) return { mode: 'systemd', via: 'systemd', ...unit }
  return { mode: 'in-place', via: execve && platform !== 'win32' ? 'execve' : 'wrapper' }
}

/** True when dsh was told to pick a random port (`--port 0`), which a plain re-run wouldn't reproduce. */
export const randomPort = (argv = process.argv) =>
  argv.some((a, i) => a === '--port=0' || (a === '--port' && argv[i + 1] === '0'))

/** The command line that started this dsh, ready to spawn again (a random port pinned to `port`). */
export function relaunchArgs(port, execArgv = process.execArgv, argv = process.argv, execPath = process.execPath) {
  // A single-executable build repeats execPath as argv[1].
  const args = [...execArgv, ...argv.slice(argv[1] === execPath ? 2 : 1)]
    .map((a, i, all) => (a === '--port=0' ? `--port=${port}` : a === '0' && all[i - 1] === '--port' ? String(port) : a))
  if (!args.includes('--no-open')) args.push('--no-open') // no new browser tab per restart
  return args
}

/** Resolve once nothing answers on host:port any more (or after `ms`). */
function portFreed(host, port, ms = 15_000) {
  const until = Date.now() + ms
  return new Promise((resolve) => {
    if (!port) return setTimeout(resolve, 2000) // no web server info: give teardown a moment
    const probe = () => {
      const s = connect({ host, port })
      s.once('connect', () => { s.destroy(); Date.now() > until ? resolve() : setTimeout(probe, 150) })
      s.once('error', () => resolve())
    }
    probe()
  })
}

/** Replace this process with a fresh dsh: same PID, same stdio, same environment. */
function execInPlace(port) {
  try {
    process.execve(process.execPath, [process.execPath, ...relaunchArgs(port)], process.env)
  } catch (err) {
    console.warn('dsh-restart-anywhere: execve failed, falling back to a wrapper:', err)
    superviseChild(port)
  }
}

/** Become a thin wrapper: start the fresh dsh as a child, forward signals, mirror its exit. */
function superviseChild(port) {
  const args = relaunchArgs(port)
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeAllListeners(sig)
  let child
  const start = () => {
    // POSIX: own process group, so a terminal's Ctrl-C reaches the child once (via
    // our forwarder), not twice. Windows: same console, it gets Ctrl-C directly.
    child = spawn(process.execPath, args, { stdio: 'inherit', detached: process.platform !== 'win32',
      env: { ...process.env, [PARENT_ENV]: String(process.pid) } })
    child.once('exit', (code, signal) => {
      if (code === RESTART_CODE) return start()
      if (signal) { process.removeAllListeners(signal); process.kill(process.pid, signal) } else process.exit(code ?? 1)
    })
    child.once('error', (err) => { console.error('dsh-restart-anywhere: could not start dsh:', err); process.exit(1) })
  }
  // Windows: the child shares our console and gets Ctrl-C / close itself, and
  // child.kill() there is a hard TerminateProcess — so just outlive it.
  const forward = process.platform === 'win32' ? () => {} : (sig) => child?.kill(sig)
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, forward)
  start()
}

const json = (status, body) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

export function apply(ctx) {
  let restarting = false

  const inPlace = (how) => {
    const web = ctx.get('webServer')
    const host = !web?.host || web.host === '0.0.0.0' || web.host === '::' ? '127.0.0.1' : web.host
    const appExit = ctx.get('appExit')
    if (!appExit) throw new Error('this dsh launcher has no graceful exit hook (ctx.appExit)')
    // Let the reply reach the browser, then shut the tree down; the port closing
    // is the signal that teardown is done and the next dsh can bind it.
    setTimeout(() => {
      appExit(how.mode === 'child' ? RESTART_CODE : 0)
      portFreed(host, web?.port).then(() => {
        if (how.mode === 'child') process.exit(RESTART_CODE)
        else if (how.via === 'execve') execInPlace(web?.port)
        else superviseChild(web?.port)
      })
    }, 300)
  }

  /** Start a restart; resolves to [httpStatus, body] once it's committed (or refused). */
  const restart = async () => {
    let how = detect()
    if (!how.mode) return [409, { ok: false, error: `restart is not supported in the ${how.via}` }]
    if (restarting) return [409, { ok: false, error: 'a restart is already in progress' }]
    restarting = true
    try {
      if (how.mode === 'systemd') {
        const scope = how.user ? ['--user'] : []
        const args = [...scope, '--on-active=1', '--timer-property=AccuracySec=100ms', 'systemctl', ...scope, 'restart', how.unit]
        const failed = await new Promise(resolve => execFile('systemd-run', args, { timeout: 10_000 },
          (err, _out, stderr) => resolve(err ? (stderr || err.message).trim() : null)))
        if (!failed) return [202, { ok: true, ...how, boot: BOOT }]
        console.warn(`dsh-restart-anywhere: systemd-run failed (${failed}); restarting in place`)
        how = { ...detect({ env: {} }), fallback: failed }
      }
      inPlace(how)
      return [202, { ok: true, ...how, boot: BOOT }]
    } catch (err) {
      restarting = false
      return [500, { ok: false, error: err instanceof Error ? err.message : String(err) }]
    }
  }

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/dsh-restart',
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method === 'GET') return json(200, { ...detect(), boot: BOOT })
      return json(...await restart())
    },
  }), 'dsh-restart-anywhere: /api/dsh-restart')

  const tool = {
    name: 'dsh_restart',
    description: 'Restart dsh itself, e.g. to load a plugin you just installed or changed, or a config change that needs a restart. '
      + 'Call it last: this session stops while dsh restarts (a few seconds) and every other running session is interrupted too. '
      + 'Pass continue_prompt to be woken in this session once dsh is back up, with that text as your next instruction.',
    parameters: { type: 'object', properties: { continue_prompt: { type: 'string',
      description: 'What to do once dsh is back, e.g. "Plugin X is installed now; test its tool and finish issue #12." Omit to not be woken.' } } },
    output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
    async execute(args, exec) {
      const prompt = typeof args?.continue_prompt === 'string' ? args.continue_prompt.trim() : ''
      if (prompt) {
        mkdirSync(dirname(WAKE_FILE), { recursive: true })
        writeFileSync(WAKE_FILE, JSON.stringify({ sessionId: exec.agent.session.id, prompt, at: Date.now() }))
      }
      const [status, body] = await restart()
      if (status !== 202) {
        if (prompt) rmSync(WAKE_FILE, { force: true })
        throw new Error(`dsh restart refused: ${body.error}`)
      }
      return prompt
        ? 'dsh is restarting now. End your turn; you will be woken in this session with your continue_prompt once dsh is back.'
        : 'dsh is restarting now. End your turn; nothing will wake this session afterwards.'
    },
  }
  // Tools are per agent; root sessions only, so a subagent can't restart dsh under its parent.
  ctx.inject(['agents'], (ctx) => {
    const attach = (agent) => {
      if (ctx.agents.roots().includes(agent)) ctx.effect(() => agent.ctx.effect(() => agent.ctx.tools.register(tool)))
    }
    ctx.on('agent/created', ({ agent }) => attach(agent))
    for (const agent of ctx.agents.roots()) attach(agent)
  })

  // Boot: deliver a wake the previous dsh parked for us.
  ctx.inject(['sessionController', 'sessions'], (ctx) => {
    let wake
    try { wake = JSON.parse(readFileSync(WAKE_FILE, 'utf8')); rmSync(WAKE_FILE, { force: true }) } catch { return }
    if (!wake?.sessionId || !wake.prompt || Date.now() - wake.at > WAKE_TTL) return
    void (async () => {
      const found = await ctx.sessionController.resolveAgent(wake.sessionId)
      if ('error' in found) throw found.error
      found.agent.followup(Object.freeze({
        id: randomUUID(), role: 'user',
        content: Object.freeze([Object.freeze({ type: 'text', text: `dsh has restarted (you called dsh_restart). Continue:\n\n${wake.prompt}` })]),
        source: Object.freeze({ kind: 'dsh-restart-anywhere', form: 'notice', summary: 'dsh restarted; continuing' }),
      }))
      await ctx.sessions.flush(found.agent.session)
    })().catch(err => console.warn('dsh-restart-anywhere: could not wake the session after restart:', err))
  })
}
