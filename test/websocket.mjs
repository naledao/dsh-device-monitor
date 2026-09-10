/**
 * WebSocket 端到端测试（`node test/websocket.mjs`）。
 *
 * 起一个真实的 `node:http` server，把插件注册的 upgrade 路由按 webserver 的
 * 语义接上去，然后用 Node 内置的 WHATWG `WebSocket` 客户端连进来——也就是说
 * 这里跑的是真正的 RFC 6455 握手与帧编解码，不是替身。
 *
 * 覆盖：握手、首帧 hello/snapshot、按采样周期持续推送、进程订阅、改采样周期、
 * 坏消息不致断连、断开后连接计数回落。
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'

const host = await import('../lib/index.js')

//#region 用最小 webserver 影子接上插件

const upgrades = new Map()
const routes = new Map()
const server = createServer((req, res) => {
  for (const route of routes.values()) {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    if (route.kind === 'prefix' ? path === route.path || path.startsWith(`${route.path}/`) : path === route.path) {
      route.handler(req, res)
      return
    }
  }
  res.writeHead(404)
  res.end()
})

server.on('upgrade', (req, socket, head) => {
  const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
  const route = upgrades.get(path)
  // 与 dsh-host-webserver 一致：未注册的 upgrade 路径直接关闭连接。
  if (route === undefined) {
    socket.destroy()
    return
  }
  route.handler(req, socket, head)
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const disposers = []
host.apply(
  {
    effect: fn => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    webServer: {
      register: route => {
        routes.set(`${route.kind}:${route.path}`, route)
        return () => routes.delete(`${route.kind}:${route.path}`)
      },
      registerUpgrade: route => {
        upgrades.set(route.path, route)
        return () => upgrades.delete(route.path)
      },
    },
    logger: { info: () => {} },
  },
  { intervalMs: 300, historySize: 10, mounts: ['/'] },
)

assert.equal(upgrades.size, 1, '注册了一条 upgrade 路由')
assert.ok(upgrades.has('/device-monitor/ws'), 'upgrade 路径是 /device-monitor/ws')

/** 直连路由表取一次 /health。 */
async function health() {
  const route = routes.get('prefix:/device-monitor/api')
  const text = await new Promise(resolve => {
    route.handler({ url: '/device-monitor/api/health' }, { writeHead() {}, end(body) { resolve(body) } })
  })
  return JSON.parse(text)
}

//#endregion

//#region 客户端

const messages = []
const ws = new WebSocket(`ws://127.0.0.1:${port}/device-monitor/ws`)
ws.addEventListener('message', event => {
  messages.push(JSON.parse(event.data))
})

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return
    if (Date.now() > deadline) assert.fail(`等待超时：${label}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true })
})

// 握手成功后立刻应当收到 hello + 一条当前快照，不必等下一个 tick。
await waitFor(() => messages.some(m => m.type === 'snapshot'), 2000, '首帧快照')
const hello = messages.find(m => m.type === 'hello')
assert.ok(hello !== undefined, '收到 hello')
assert.equal(hello.intervalMs, 300, 'hello 带上当前采样周期')

const first = messages.find(m => m.type === 'snapshot')
assert.ok(first.now !== null && typeof first.now === 'object', 'snapshot 带 now')
assert.ok(first.now.memory.totalBytes > 0, '快照里有物理内存')
assert.ok(Array.isArray(first.now.storage) && first.now.storage.length > 0, '快照里有存储')
// 首个点没有前一帧可差分，cpu.percent 允许为 null；后面的点必须是数字。

await waitFor(() => health().then === undefined || true, 1, 'noop')
assert.equal((await health()).wsClients, 1, 'health 报告 1 个连接')

// 按采样周期持续推送：300ms 周期下 1.2s 至少 3 条。
const before = messages.filter(m => m.type === 'snapshot').length
await new Promise(resolve => setTimeout(resolve, 1200))
const after = messages.filter(m => m.type === 'snapshot').length
assert.ok(after - before >= 3, `持续推送（1.2s 内新到 ${after - before} 条，期望 ≥3）`)

const latest = messages.filter(m => m.type === 'snapshot').at(-1)
assert.ok(typeof latest.now.cpu.percent === 'number', '后续快照有 CPU 占用')
assert.ok(typeof latest.now.net.downBps === 'number', '后续快照有网络速率')

// 进程订阅：订阅前不应有 processes 帧，订阅后 3s 内必须到。
assert.equal(messages.some(m => m.type === 'processes'), false, '未订阅时不推进程')
ws.send(JSON.stringify({ type: 'subscribe', processes: true }))
await waitFor(() => messages.some(m => m.type === 'processes'), 4000, '订阅后收到进程排行')
const procs = messages.find(m => m.type === 'processes').processes
assert.ok(Array.isArray(procs) && procs.length > 0 && procs.length <= 12, '进程条数在 1..12')
for (let index = 1; index < procs.length; index += 1) {
  assert.ok(procs[index - 1].rssBytes >= procs[index].rssBytes, '进程按内存降序')
}

// 退订后不再推进程。
ws.send(JSON.stringify({ type: 'subscribe', processes: false }))
await new Promise(resolve => setTimeout(resolve, 400))
const procsBefore = messages.filter(m => m.type === 'processes').length
await new Promise(resolve => setTimeout(resolve, 1200))
assert.equal(messages.filter(m => m.type === 'processes').length, procsBefore, '退订后不再推进程')

// 改采样周期：宿主周期确实变慢，并把生效值广播回来。
ws.send(JSON.stringify({ type: 'config', intervalMs: 5000 }))
await waitFor(() => messages.some(m => m.type === 'hello' && m.intervalMs === 5000), 2000, '配置生效广播')
assert.equal((await health()).intervalMs, 5000, 'health 反映新的采样周期')

const slowBefore = messages.filter(m => m.type === 'snapshot').length
await new Promise(resolve => setTimeout(resolve, 1200))
assert.equal(messages.filter(m => m.type === 'snapshot').length, slowBefore, '5000ms 周期下 1.2s 内不应有新点')

// 越界值被钳制，且坏消息不会踢掉连接。
ws.send(JSON.stringify({ type: 'config', intervalMs: 1 }))
await waitFor(() => messages.some(m => m.type === 'hello' && m.intervalMs === 250), 2000, '周期被钳到 250ms')
ws.send('这不是 JSON')
ws.send(JSON.stringify(['数组不是对象']))
await waitFor(() => messages.filter(m => m.type === 'snapshot').length > slowBefore, 2000, '坏消息后仍在推送')
assert.equal(ws.readyState, WebSocket.OPEN, '坏消息没有断开连接')

// 断开后连接计数回落。
ws.close()
await waitFor(() => true, 1, 'noop')
const deadline = Date.now() + 3000
for (;;) {
  if ((await health()).wsClients === 0) break
  if (Date.now() > deadline) assert.fail('断开后 wsClients 未回落')
  await new Promise(resolve => setTimeout(resolve, 50))
}

//#endregion

for (const dispose of disposers.reverse()) dispose()
await new Promise(resolve => server.close(resolve))

console.log('websocket: 握手 / 推送 / 订阅 / 改周期 / 断连 OK')
console.log(`  ${messages.length} 帧 · 采样周期 300ms→5000ms→250ms · 进程 ${procs.length} 条`)
