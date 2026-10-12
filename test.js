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
console.log('ok')
