import assert from 'node:assert'
import { detect, randomPort, relaunchArgs, systemdUnit } from './lib/index.js'

// systemd unit from cgroup v2 and v1
const USER_UNIT = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/dsh-web.service\n'
assert.deepStrictEqual(systemdUnit(USER_UNIT), { unit: 'dsh-web.service', user: true })
assert.deepStrictEqual(systemdUnit('0::/system.slice/dsh.service\n'), { unit: 'dsh.service', user: false })
assert.deepStrictEqual(systemdUnit('12:pids:/system.slice/dsh.service\n1:name=systemd:/system.slice/dsh.service\n'), { unit: 'dsh.service', user: false })
// terminals, docker, desktop sessions: no service of our own
assert.strictEqual(systemdUnit('0::/user.slice/user-1000.slice/user@1000.service/app.slice/vte-spawn-1.scope\n'), null)
assert.strictEqual(systemdUnit('0::/user.slice/user-1000.slice/user@1000.service/init.scope\n'), null)
assert.strictEqual(systemdUnit('0::/\n'), null)
assert.strictEqual(systemdUnit(''), null)

const d = (o) => detect({ platform: 'linux', env: {}, ppid: 4242, cgroup: '', versions: {}, execve: true, argv: ['node', 'dsh', 'web'], ...o })
assert.deepStrictEqual(d({ env: { INVOCATION_ID: 'x' }, cgroup: USER_UNIT }), { mode: 'systemd', via: 'systemd', unit: 'dsh-web.service', user: true })
assert.strictEqual(d({ cgroup: USER_UNIT }).mode, 'in-place')
assert.strictEqual(d({ env: { INVOCATION_ID: 'x' }, cgroup: USER_UNIT, argv: ['node', 'dsh', 'web', '--port', '0'] }).mode, 'in-place') // random port: stay in place // service cgroup but no INVOCATION_ID: not ours
assert.deepStrictEqual(d({}), { mode: 'in-place', via: 'execve' }) // terminal, docker, pm2, k8s, ...
assert.strictEqual(d({ execve: false }).via, 'wrapper') // Node < 22.15
assert.strictEqual(d({ platform: 'darwin' }).mode, 'in-place')
assert.deepStrictEqual(d({ platform: 'win32' }), { mode: 'in-place', via: 'wrapper' })
assert.strictEqual(d({ versions: { electron: '33.0.0' } }).mode, null)
// child of an in-place wrapper; the env var leaking to a grandchild doesn't count
assert.strictEqual(d({ env: { DSH_RESTART_ANYWHERE_PARENT: '4242' } }).mode, 'child')
assert.strictEqual(d({ env: { DSH_RESTART_ANYWHERE_PARENT: '999' } }).mode, 'in-place')
assert.strictEqual(d({ env: { DSH_RESTART_ANYWHERE_PARENT: '4242', INVOCATION_ID: 'x' }, cgroup: USER_UNIT }).mode, 'child')

// relaunch command line
assert.deepStrictEqual(relaunchArgs(3080, ['--import', 'tsx/esm'], ['/n/node', '/h/bin.ts', 'web'], '/n/node'), ['--import', 'tsx/esm', '/h/bin.ts', 'web', '--no-open'])
assert.deepStrictEqual(relaunchArgs(3080, [], ['/n/node', '/h/dsh', 'web', '--no-open'], '/n/node'), ['/h/dsh', 'web', '--no-open'])
assert.deepStrictEqual(relaunchArgs(3080, [], ['/b/dsh', '/b/dsh', 'web'], '/b/dsh'), ['web', '--no-open']) // single-executable build
assert.deepStrictEqual(relaunchArgs(41234, [], ['/n/node', '/h/dsh', 'web', '--port', '0'], '/n/node'), ['/h/dsh', 'web', '--port', '41234', '--no-open'])
assert.deepStrictEqual(relaunchArgs(41234, [], ['/n/node', '/h/dsh', 'web', '--port=0'], '/n/node'), ['/h/dsh', 'web', '--port=41234', '--no-open'])
assert.deepStrictEqual(relaunchArgs(41234, [], ['/n/node', '/h/dsh', 'web', 'fix bug 0'], '/n/node'), ['/h/dsh', 'web', 'fix bug 0', '--no-open']) // only a --port value
assert.ok(randomPort(['n', 'd', '--port', '0']) && randomPort(['n', 'd', '--port=0']) && !randomPort(['n', 'd', '--port', '3080']))
console.log('ok: detect + relaunch')

// ---- dsh_restart tool + boot wake, against a fake ctx ----
const { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } = await import('node:fs')
const { join } = await import('node:path')
const { tmpdir } = await import('node:os')
delete process.env.INVOCATION_ID // never let a test pick the systemd path and restart a real unit
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-ra-'))
const WAKE = join(process.env.DSH_HOME, 'restart-anywhere', 'wake.json')
const { apply } = await import('./lib/index.js?wake') // fresh import picks up DSH_HOME
const execs = []
process.execve = (...a) => { execs.push(a) } // an accepted restart must not turn this test into a new dsh

/** Mount the plugin on a fake ctx; `appExit` undefined makes every restart fail (500). */
function mount({ appExit, roots = [], resolveAgent } = {}) {
  const tools = new Map(), listeners = {}, followups = [], flushed = []
  const services = { appExit, webServer: undefined }
  const agentOf = (id) => ({ session: { id }, ctx: { effect: f => f(), tools: { register: t => tools.set(id, t) } } })
  const agents = { roots: () => roots, list: [] }
  const ctx = {
    get: k => services[k], effect: f => f(), on: (e, f) => { listeners[e] = f },
    connection: { fetch: { register: r => { ctx.route = r } } },
    agents,
    sessions: { flush: async s => { flushed.push(s.id); return true } },
    sessionController: { resolveAgent: resolveAgent ?? (async id => ({ agent: { ...agentOf(id), followup: m => followups.push(m) } })) },
    inject: (_deps, f) => f(ctx),
  }
  apply(ctx)
  return { ctx, tools, listeners, followups, flushed, agentOf }
}
const tick = () => new Promise(r => setTimeout(r, 20))

{ // tool goes to root agents only, including ones created later
  const m = mount({ roots: [] })
  const a = { ...m.agentOf('root') }, sub = m.agentOf('sub')
  m.ctx.agents.roots = () => [a]
  m.listeners['agent/created']({ agent: a })
  m.listeners['agent/created']({ agent: sub })
  assert.deepStrictEqual([...m.tools.keys()], ['root'])
  assert.strictEqual(m.tools.get('root').name, 'dsh_restart')
}
{ // a refused restart throws and leaves no wake file behind
  const m = mount({ roots: [] })
  const a = m.agentOf('s1'); m.ctx.agents.roots = () => [a]; m.listeners['agent/created']({ agent: a })
  await assert.rejects(m.tools.get('s1').execute({ continue_prompt: 'go on' }, { agent: a }), /dsh restart refused/)
  assert.ok(!existsSync(WAKE))
}
{ // an accepted restart parks the wake; GET still answers; render passes text through
  let exited = null
  const m = mount({ roots: [], appExit: (code) => { exited = code } })
  const a = m.agentOf('s2'); m.ctx.agents.roots = () => [a]; m.listeners['agent/created']({ agent: a })
  const tool = m.tools.get('s2')
  const text = await tool.execute({ continue_prompt: '  test plugin X  ' }, { agent: a })
  assert.match(text, /woken/)
  assert.deepStrictEqual(tool.output.render({}, 'hi'), [{ type: 'text', text: 'hi' }])
  const wake = JSON.parse(readFileSync(WAKE, 'utf8'))
  assert.strictEqual(wake.sessionId, 's2'); assert.strictEqual(wake.prompt, 'test plugin X')
  // a second call while restarting is refused
  await assert.rejects(tool.execute({}, { agent: a }), /already in progress/)
  const res = await m.ctx.route.fetch(new Request('http://x/api/dsh-restart'))
  assert.strictEqual(res.status, 200)
  // teardown runs, then the process would exec the same dsh command line
  await new Promise(r => setTimeout(r, 2500)); assert.strictEqual(exited, 0)
  assert.strictEqual(execs.length, 1); assert.strictEqual(execs[0][0], process.execPath); assert.ok(execs[0][1].includes('--no-open'))
}
{ // no continue_prompt: no wake file
  const { rmSync } = await import('node:fs'); rmSync(WAKE, { force: true })
  const m = mount({ roots: [], appExit: () => {} })
  const a = m.agentOf('s3'); m.ctx.agents.roots = () => [a]; m.listeners['agent/created']({ agent: a })
  assert.match(await m.tools.get('s3').execute({}, { agent: a }), /nothing will wake/)
  assert.ok(!existsSync(WAKE))
}
const park = (w) => { mkdirSync(join(process.env.DSH_HOME, 'restart-anywhere'), { recursive: true }); writeFileSync(WAKE, typeof w === 'string' ? w : JSON.stringify(w)) }
{ // boot: a fresh wake is delivered once, as a follow-up into its session, and the file is gone
  park({ sessionId: 'sX', prompt: 'carry on', at: Date.now() })
  const m = mount(); await tick()
  assert.strictEqual(m.followups.length, 1)
  assert.match(m.followups[0].content[0].text, /carry on/)
  assert.strictEqual(m.followups[0].role, 'user')
  assert.ok(Object.isFrozen(m.followups[0]))
  assert.deepStrictEqual(m.flushed, ['sX'])
  assert.ok(!existsSync(WAKE))
  const again = mount(); await tick(); assert.strictEqual(again.followups.length, 0)
}
for (const bad of [
  { sessionId: 'sX', prompt: 'old', at: Date.now() - 6 * 60_000 }, // stale
  { prompt: 'no session', at: Date.now() },
  '{not json',
]) { // boot: stale or broken wakes are dropped (and removed when readable)
  park(bad); const m = mount(); await tick()
  assert.strictEqual(m.followups.length, 0)
}
{ // boot: a session that can't be resumed only logs
  park({ sessionId: 'gone', prompt: 'x', at: Date.now() })
  const warn = console.warn; let warned = ''; console.warn = (...a) => { warned = a.join(' ') }
  mount({ resolveAgent: async () => ({ error: new Error('no such session') }) }); await tick()
  console.warn = warn
  assert.match(warned, /could not wake/)
  assert.ok(!existsSync(WAKE))
}
console.log('ok: tool + wake')
