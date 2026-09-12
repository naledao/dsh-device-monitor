/**
 * dsh-device-monitor 冒烟测试（`node test/smoke.mjs`）。
 *
 * 覆盖两半：
 *  1. 宿主半侧：真机采样一次，断言各分组字段齐备且数值自洽；
 *  2. 客户端半侧：用最小 React/hooks 替身加载 `lib/client.js`，断言它注册了
 *     槽位、并且底栏与展开面板两条渲染路径都不抛异常。
 *
 * 客户端替身只实现本插件用到的那几个 API，因此这里验证的是「bundle 结构、
 * 接线与渲染逻辑」而不是 React 本身。
 */

import assert from 'node:assert/strict'

//#region 宿主半侧

const host = await import('../lib/index.js')
assert.equal(host.name, 'dsh-device-monitor', 'host 插件名')
assert.deepEqual(host.inject, ['webServer'], 'host 只注入 webServer')

const sampler = new host.DeviceSampler({ intervalMs: 250, historySize: 4, mounts: ['/'] })
sampler.start()
await new Promise(resolve => setTimeout(resolve, 900))
sampler.dispose()

const point = sampler.latest()
assert.ok(point !== null, '采到一个点')
assert.ok(sampler.history.length > 0 && sampler.history.length <= 4, '环形缓冲受 historySize 约束')

assert.ok(point.cpu !== null, 'CPU 分组存在')
assert.ok(point.cpu.percent === null || (point.cpu.percent >= 0 && point.cpu.percent <= 100), 'CPU 占用在 0..100')
assert.ok(point.cpu.load1 !== null, '读到 loadavg')
assert.ok(point.cpu.tempC === null || (point.cpu.tempC > -40 && point.cpu.tempC < 200), 'CPU 温度已过滤哨兵值')
assert.ok(Array.isArray(point.cpu.tempZones), 'CPU 热区明细是数组')
for (const zone of point.cpu.tempZones) {
  assert.ok(zone.tempC > -40 && zone.tempC < 200, `热区 ${zone.name} 温度合理`)
}
for (let i = 1; i < point.cpu.tempZones.length; i += 1) {
  assert.ok(point.cpu.tempZones[i - 1].tempC >= point.cpu.tempZones[i].tempC, '热区按最热在前排序')
}

assert.ok(point.memory !== null, '内存分组存在')
assert.ok(point.memory.usedBytes > 0 && point.memory.usedBytes <= point.memory.totalBytes, '物理内存用量自洽')
assert.ok(point.memory.swapUsedBytes <= point.memory.swapTotalBytes, '交换分区用量自洽')
assert.ok(point.memory.swapTotalBytes === 0 || (point.memory.swapPercent >= 0 && point.memory.swapPercent <= 100), '交换占用在 0..100')

assert.ok(Array.isArray(point.storage) && point.storage.length === 1, '存储按挂载点返回')
assert.ok(point.storage[0].usedBytes + point.storage[0].availBytes <= point.storage[0].totalBytes + 1, '存储用量自洽')
assert.ok(point.storage[0].percent >= 0 && point.storage[0].percent <= 100, '存储占用在 0..100')

assert.ok(point.net !== null, '网络分组存在')
assert.ok(point.net.downBps >= 0 && point.net.upBps >= 0, '速率非负')
for (const iface of point.net.interfaces) {
  assert.ok(!/^(lo|ip6|ifb|r_rmnet|rmnet_ipa|dummy)/.test(iface.name), `虚拟接口 ${iface.name} 已被过滤`)
}

// 电池：有 power_supply 的机器（手机、笔记本）应当读到；没有时必须是 null 而不是假 0%。
if (point.battery !== null) {
  assert.equal(typeof point.battery.status, 'string', '电池状态来自内核原文')
  assert.ok(point.battery.percent === null || (point.battery.percent >= 0 && point.battery.percent <= 100), '电量在 0..100')
  assert.equal(typeof point.battery.charging, 'boolean', '充电标志是布尔量')
  assert.equal(typeof point.battery.plugged, 'boolean', '插电标志是布尔量')
  assert.ok(point.battery.tempC === null || (point.battery.tempC > -40 && point.battery.tempC < 100), '电池温度已换算成摄氏度')
  assert.ok(point.battery.voltageV === null || (point.battery.voltageV > 2 && point.battery.voltageV < 30), '电池电压已换算成伏')
  assert.ok(
    point.battery.currentMa === null || Math.abs(point.battery.currentMa) < 20_000,
    '电池电流已换算成毫安（不会把微安原样吐出来）',
  )
}

// GPU 在高通平台应当可读；读不到时按「平台无 kgsl」接受，但结构必须是 null 而不是假 0。
if (point.gpu !== null) {
  assert.equal(typeof point.gpu.model, 'string', 'GPU 型号')
  assert.ok(point.gpu.percent === null || (point.gpu.percent >= 0 && point.gpu.percent <= 100), 'GPU 占用在 0..100')
  assert.ok(point.gpu.tempC === null || (point.gpu.tempC > -40 && point.gpu.tempC < 200), 'GPU 温度合理')
}

//#endregion

//#region 客户端半侧替身

const FAKE_POINT = JSON.parse(JSON.stringify(point))
// 客户端断言不该取决于跑测试的机器有没有电池：这里固定一份「正在充电」的假数据。
FAKE_POINT.battery = {
  name: 'battery',
  percent: 42,
  status: 'Charging',
  charging: true,
  full: false,
  plugged: true,
  tempC: 31.5,
  voltageV: 4.35,
  currentMa: 1234,
  health: 'Good',
  technology: 'Li-ion',
  cycleCount: 321,
}
const FAKE_PROCS = [
  { pid: 10210, name: 'dsh', rssBytes: 512 * 1024 * 1024 },
  { pid: 2214, name: 'system_server', rssBytes: 256 * 1024 * 1024 },
]

// 宿主路由：用假 ctx 走一遍 apply，确认各接口的形状与缓存行为。
{
  let route = null
  const host = await import('../lib/index.js')
  host.apply({
    effect: fn => { fn() },
    webServer: { register: r => { route = r; return () => {} }, registerUpgrade: () => () => {} },
    logger: { info: () => {} },
  }, { intervalMs: 300, historySize: 3, mounts: ['/'] })

  assert.equal(route.kind, 'prefix', '注册的是 prefix 路由')
  assert.equal(route.path, '/device-monitor/api', '路由前缀')

  const call = async url => {
    const body = await new Promise(resolve => {
      route.handler({ url }, { writeHead() {}, end(text) { resolve(text) } })
    })
    return JSON.parse(body)
  }

  const light = await call('/device-monitor/api/snapshot?light=1')
  assert.ok(light.now !== null, 'light 快照带 now')

  const full = await call('/device-monitor/api/snapshot')
  assert.ok(Array.isArray(full.history), '完整快照带 history')

  const procs = await call('/device-monitor/api/processes?limit=8')
  assert.ok(Array.isArray(procs.processes), '进程接口返回数组')
  assert.ok(procs.processes.length <= 8, '进程条数受 limit 约束')
  assert.ok(procs.scanned > 0, '至少扫到一些进程')
  for (let i = 1; i < procs.processes.length; i += 1) {
    assert.ok(procs.processes[i - 1].rssBytes >= procs.processes[i].rssBytes, '进程按内存从大到小排序')
  }
  for (const proc of procs.processes) {
    assert.ok(Number.isInteger(proc.pid) && proc.pid > 0, '进程 pid 是正整数')
    assert.equal(typeof proc.name, 'string', '进程名是字符串')
    assert.ok(proc.name.length > 0, '进程名非空')
    assert.ok(!/^\d+$/.test(proc.name), `进程名不该是纯数字（pid ${proc.pid} -> ${proc.name}）`)
  }
  assert.deepEqual(await call('/device-monitor/api/processes?limit=8'), procs, '2s 内命中缓存返回同一结果')
}

let hooks = []
let hookIndex = 0
let pendingEffects = []

const fakeReact = {
  Fragment: Symbol('react.fragment'),
  createElement(type, props, ...children) {
    // 与真实 React 一致：children 同时投影进 props.children，
    // 组件里 `props.children` 的写法才走得通。
    const merged = { ...(props ?? {}) }
    if (children.length === 1) merged.children = children[0]
    else if (children.length > 1) merged.children = children
    return { type, props: merged, children }
  },
  useState(initial) {
    const index = hookIndex
    hookIndex += 1
    if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial
    return [hooks[index], value => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value }]
  },
  useEffect(effect) {
    hookIndex += 1
    pendingEffects.push(effect)
  },
  useCallback(fn) {
    hookIndex += 1
    return fn
  },
  useRef(initial) {
    const index = hookIndex
    hookIndex += 1
    if (!(index in hooks)) hooks[index] = { current: initial }
    return hooks[index]
  },
}

const styleStub = { dataset: {}, textContent: '', remove() {} }
globalThis.document = { createElement: () => styleStub, head: { appendChild() {} } }
// Node 24 的 navigator 是只读 getter，只能用 defineProperty 覆盖。
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })
// 组件的数据通道已改成 WebSocket；这里只提供 URL 解析需要的 location，
// 连接本身由 test/websocket.mjs 用真实 http server + 真实握手覆盖。
globalThis.location = { protocol: 'http:', host: '127.0.0.1:3080' }
globalThis.WebSocket = class {
  constructor(url) { this.url = url; this.readyState = 1 }
  send() {}
  close() {}
}

const registered = []
globalThis.window = {
  __ModuleLoader__: { load: registration => { registered.push(registration) } },
  setTimeout: () => 1,
  clearTimeout: () => {},
}

await import('../lib/client.js')

assert.equal(registered.length, 1, 'bundle 注册了一次')
const registration = registered[0]
assert.equal(registration.id, 'dsh-device-monitor', 'bundle id 是包名')
assert.equal(typeof registration.factory, 'function', 'factory 存在')

const clientExports = registration.factory(specifier => {
  assert.equal(specifier, 'react', `只允许请求基座里的 react，实际请求了 ${specifier}`)
  return fakeReact
})

assert.deepEqual(clientExports.inject, ['slots'], 'client 只注入 slots')
assert.equal(typeof clientExports.apply, 'function', '导出 apply')

let componentReg = null
let slotName = null
const effects = []
clientExports.apply({
  effect: (fn, label) => { effects.push({ fn, label }) },
  slots: {
    // 真实契约：register 返回 disposer，inject 的回调返回这个 disposer。
    inject: (name, callback) => {
      slotName = name
      const dispose = callback()
      assert.equal(typeof dispose, 'function', 'inject 回调要返回 disposer')
    },
    register: (options, component) => {
      componentReg = { options, component }
      return () => {}
    },
  },
})

assert.equal(slotName, 'conversation.composer.dock', '挂到 composer dock 槽位')
assert.equal(componentReg.options.id, 'device-monitor', '槽位条目 id')
assert.equal(componentReg.options.order, 1, '排在内置 stats 行之后')
assert.equal(typeof componentReg.component, 'function', '注册的是函数组件')

// 渲染一：effects 尚未运行，组件处于「采样中」占位。
hookIndex = 0
hooks = []
pendingEffects = []
componentReg.component()
for (const { fn } of effects) if (fn.length === 0 && fn.name !== 'installStyles') fn()
// installStyles 需要 document 真节点；替身里同样安全。
effects[0].fn()

// 渲染二：把第一次轮询塞进 hooks，并展开面板。
// hooks 顺序：0 latest / 1 series / 2 open / 3 procs / 4 status。
hookIndex = 0
pendingEffects = []
hooks[0] = FAKE_POINT
hooks[1] = [FAKE_POINT, FAKE_POINT]
hooks[2] = true
hooks[3] = FAKE_PROCS
const tree = componentReg.component()

const classes = new Set()
const counts = new Map()
const bump = name => counts.set(name, (counts.get(name) ?? 0) + 1)
const collect = node => {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) collect(child)
    return
  }
  // 替身不做真正的组件展开，这里手工展开无 hooks 的函数组件（Card/Row/Spark/Meter/ProcessList）。
  if (typeof node.type === 'function') {
    collect(node.type(node.props))
    return
  }
  if (typeof node.props?.className === 'string') {
    for (const name of node.props.className.split(/\s+/)) {
      if (name === '') continue
      classes.add(name)
      bump(name)
    }
  }
  if (Array.isArray(node.children)) for (const child of node.children) collect(child)
}
collect(tree)

for (const expected of [
  'ddm-bar',
  'ddm-panel',
  'ddm-head',
  'ddm-head-title',
  'ddm-head-meta',
  'ddm-status',
  'ddm-dot',
  'ddm-body',
  'ddm-row1',
  'ddm-row2',
  'ddm-card',
  'ddm-card-head',
  'ddm-card-name',
  'ddm-card-sub',
  'ddm-ico',
  'ddm-main',
  'ddm-big',
  'ddm-meter',
  'ddm-chart',
  'ddm-spark',
  'ddm-stats',
  'ddm-stat',
  'ddm-usage',
  'ddm-usage-meter',
  'ddm-battery',
  'ddm-note',
  'ddm-note-live',
  'ddm-net',
  'ddm-net-col',
  'ddm-net-value',
  'ddm-net-foot',
  'ddm-procs',
  'ddm-scroll',
  'ddm-tr',
  'ddm-td-pid',
  'ddm-td-name',
  'ddm-td-bar',
  'ddm-td-mem',
  'ddm-td-pct',
]) {
  assert.ok(classes.has(expected), `面板渲染出 .${expected}`)
}
// 四张指标卡 + 电量卡 + 网络卡 + 进程表卡。
assert.equal(counts.get('ddm-card'), 7, '一共七张卡片')
assert.equal(counts.get('ddm-card-head'), 7, '七张卡片都有卡片头')
assert.ok(counts.get('ddm-td-bar') >= 1, '进程表有占比条')
assert.ok(!String(JSON.stringify(tree)).includes('undefined℃'), '没有渲染出 undefined 温度占位')
assert.ok(String(JSON.stringify(tree)).includes('42%'), '电量卡渲染出电量读数')
assert.ok(String(JSON.stringify(tree)).includes('1.23 A'), '电流按安培显示')

// 没有电池的机器（台式机 / 容器）应当少一张卡，而不是渲染 0%。
{
  hookIndex = 0
  hooks[0] = { ...FAKE_POINT, battery: null }
  const bare = componentReg.component()
  const bareClasses = new Set()
  const walk = node => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    if (typeof node.type === 'function') {
      walk(node.type(node.props))
      return
    }
    if (typeof node.props?.className === 'string') for (const name of node.props.className.split(/\s+/)) if (name !== '') bareClasses.add(name)
    if (Array.isArray(node.children)) for (const child of node.children) walk(child)
  }
  walk(bare)
  assert.ok(!bareClasses.has('ddm-battery'), '没有电池时不渲染电量卡')
  assert.ok(String(JSON.stringify(bare)).includes('ddm-net'), '没有电池时网络卡照旧')
}

//#endregion

console.log('smoke: host + client OK')
console.log(`  cpu ${point.cpu.percent?.toFixed(1) ?? '—'}% ${point.cpu.tempC ?? '—'}℃ · gpu ${point.gpu ? `${point.gpu.percent}% ${point.gpu.tempC}℃` : 'n/a'} · mem ${point.memory.percent}% · swap ${point.memory.swapPercent}% · disk ${point.storage[0].percent}% · net ↓${point.net.downBps} ↑${point.net.upBps} B/s`)
