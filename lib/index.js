/**
 * dsh-device-monitor — 宿主半侧。
 *
 * 浏览器读不到 /proc 与 sysfs，所以采样全部在这里：
 *  1. 定时采样 CPU 负载/温度/频率、GPU 负载/温度/频率、物理内存与交换分区、
 *     存储占用、电池电量与充电状态、网络下行/上行速率；
 *  2. 通过 `ctx.webServer` 暴露只读 REST：
 *       GET /device-monitor/api/snapshot          最新采样 + 历史窗口
 *       GET /device-monitor/api/snapshot?light=1  仅最新采样（底栏 1s 轮询用）
 *       GET /device-monitor/api/health            采样器存活信息
 *  3. 环形缓冲只留最近 `historySize` 个点，不落盘、不写任何系统文件。
 *
 * 全部数据源都是只读的，插件不修改任何设备状态。
 *
 * @module dsh-device-monitor
 */

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statfsSync } from 'node:fs'

/** Cordis 插件名；与 package.json 的包名一致。 */
export const name = 'dsh-device-monitor'

/** 只依赖 webServer：没有 tools，模型看不到任何东西。 */
export const inject = ['webServer']

const API_PREFIX = '/device-monitor/api'
const THERMAL_ROOT = '/sys/class/thermal'
const KGSL_ROOT = '/sys/class/kgsl/kgsl-3d0'
const CPUPOLICY_ROOT = '/sys/devices/system/cpu/cpufreq'

/**
 * 要排除的虚拟/隧道/回环接口名前缀。Android 上 /proc/net/dev 会同时列出
 * `ip6gre0`、`ip6tnl0`、`ip_vti0`、`ifb0`、`p2p0`、`r_rmnet_data*` 等几十个
 * 永远为 0 的设备，只按「真实上网口」求和才不会把面板刷成噪音。
 */
const VIRTUAL_NET_PREFIX = [
  'lo',
  'dummy',
  'ifb',
  'erspan',
  'gre',
  'gretap',
  'ip6',
  'ip_',
  'sit',
  'tunl0',
  'p2p',
  'r_rmnet',
  'rmnet_ipa',
  'rmnet_mhi',
  'wifi-aware',
  'hwsim',
  'bond',
  'br-',
  'veth',
  'docker',
  'nettest',
  'clat',
]

/** @returns 是否是应当忽略的虚拟接口。 */
function isVirtualInterface(iface) {
  return VIRTUAL_NET_PREFIX.some(prefix => iface.startsWith(prefix))
}

/** CPU 温度热区命名：`cpuss-0`、`cpu-1-0`、`cpu_thermal`、`soc_thermal`、`cluster0`… */
const CPU_ZONE = /^(cpuss|cpu-|cpu_thermal|soc_thermal|soc_max|bigcpu|littlecpu|cluster)/

/** GPU 温度热区命名：`gpuss-0`… */
const GPU_ZONE = /^(gpuss|gpu-|gpu_thermal|kgsl)/

//#region 只读读取小工具

/** @returns 文本内容，读不到时 null。 */
function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** @returns 去掉首尾空白的文本，读不到时 null。 */
function readTrim(path) {
  const text = readText(path)
  return text === null ? null : text.trim()
}

/** @returns 数值，读不到或非数值时 null。 */
function readNumber(path) {
  const text = readTrim(path)
  if (text === null) return null
  const value = Number(text)
  return Number.isFinite(value) ? value : null
}

/** 解析 `"12 %"` 这类带单位的数值。 */
function parseFloatPrefix(text) {
  if (text === null) return null
  const value = Number.parseFloat(text)
  return Number.isFinite(value) ? value : null
}

/** `/proc/uptime` 第一列就是开机秒数。 */
function readUptimeSeconds() {
  const text = readTrim('/proc/uptime')
  if (text === null) return null
  const value = Number.parseFloat(text.split(/\s+/)[0])
  return Number.isFinite(value) ? Math.floor(value) : null
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function round(value, digits = 1) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

//#endregion

//#region CPU

/** 解析 /proc/stat 的 cpu 行，顺带取上下文切换计数。 */
function readCpuTimes() {
  const text = readText('/proc/stat')
  if (text === null) return null
  let aggregate = null
  let ctxt = null
  const cores = []
  for (const line of text.split('\n')) {
    if (line.startsWith('ctxt ')) {
      const value = Number(line.slice(5).trim())
      if (Number.isFinite(value)) ctxt = value
      continue
    }
    if (!line.startsWith('cpu')) continue
    const parts = line.trim().split(/\s+/)
    const values = parts.slice(1).map(Number)
    if (values.length < 5 || values.some(v => !Number.isFinite(v))) continue
    const total = values.reduce((a, b) => a + b, 0)
    // user+nice+system+idle+iowait+irq+softirq…；空闲口径取 idle+iowait。
    const idle = values[3] + values[4]
    if (parts[0] === 'cpu') aggregate = { total, idle }
    else cores.push({ total, idle })
  }
  if (aggregate === null) return null
  return { aggregate, cores, ctxt }
}

/** 两次 /proc/stat 快照之间的占用率。 */
function usagePercent(prev, next) {
  if (prev === null || next === null) return null
  const dt = next.total - prev.total
  const di = next.idle - prev.idle
  if (dt <= 0) return null
  return clamp(((dt - di) / dt) * 100, 0, 100)
}

/** 各 cpufreq policy 当前频率的平均值（MHz）。 */
function readCpuFreqMhz() {
  let entries
  try {
    entries = readdirSync(CPUPOLICY_ROOT)
  } catch {
    return null
  }
  const values = []
  for (const entry of entries) {
    if (!entry.startsWith('policy')) continue
    const khz = readNumber(`${CPUPOLICY_ROOT}/${entry}/scaling_cur_freq`)
    if (khz !== null && khz > 0) values.push(khz / 1000)
  }
  if (values.length === 0) return null
  return values.reduce((a, b) => a + b, 0) / values.length
}

function readLoadavg() {
  const text = readTrim('/proc/loadavg')
  if (text === null) return null
  const parts = text.split(/\s+/)
  const [load1, load5, load15] = parts.slice(0, 3).map(Number)
  const running = parts[3] ?? ''
  const [run, total] = running.split('/').map(Number)
  return {
    load1: Number.isFinite(load1) ? load1 : null,
    load5: Number.isFinite(load5) ? load5 : null,
    load15: Number.isFinite(load15) ? load15 : null,
    runnable: Number.isFinite(run) ? run : null,
    procs: Number.isFinite(total) ? total : null,
  }
}

function readCpuCoreCount() {
  const text = readText('/proc/cpuinfo')
  if (text === null) return null
  const matches = text.match(/^processor\s*:/gm)
  return matches === null ? null : matches.length
}

//#endregion

//#region 热区（CPU / GPU 温度）

/** 枚举一次热区列表（同一 boot 内稳定），之后每 tick 只重读 temp。 */
function discoverZones(matcher) {
  let entries
  try {
    entries = readdirSync(THERMAL_ROOT)
  } catch {
    return []
  }
  const zones = []
  for (const entry of entries) {
    if (!entry.startsWith('thermal_zone')) continue
    const type = readTrim(`${THERMAL_ROOT}/${entry}/type`)
    if (type === null || !matcher.test(type)) continue
    zones.push({ zone: entry, name: type })
  }
  return zones
}

/** 读一组热区，过滤未启用热区的哨兵值（-273℃ 等），最热在前。 */
function readZones(zones) {
  const out = []
  for (const { zone, name } of zones) {
    const milli = readNumber(`${THERMAL_ROOT}/${zone}/temp`)
    if (milli === null) continue
    const tempC = milli / 1000
    // 未启用/未校准的 zone 会报 -273℃ 或离谱高值，直接丢弃。
    if (tempC < -40 || tempC > 200) continue
    out.push({ name, tempC: round(tempC, 1) })
  }
  out.sort((a, b) => b.tempC - a.tempC)
  return out
}

/** 一组热区的最热值；无可用热区时 null。 */
function maxTemp(zones) {
  return zones.length === 0 ? null : zones[0].tempC
}

//#endregion

//#region GPU（Qualcomm Adreno / kgsl）

/**
 * 读 Adreno GPU。整组 sysfs 不存在（例如非高通平台）时返回 null，
 * 由客户端渲染「不可用」而不是 0%。
 */
function discoverGpu() {
  const model = readTrim(`${KGSL_ROOT}/gpu_model`)
  if (model === null) return null
  return {
    model,
    zones: discoverZones(GPU_ZONE),
    hasBusyPercent: readTrim(`${KGSL_ROOT}/gpu_busy_percentage`) !== null,
  }
}

function readGpu(device) {
  if (device === null) return null
  let percent = null
  if (device.hasBusyPercent) {
    percent = parseFloatPrefix(readTrim(`${KGSL_ROOT}/gpu_busy_percentage`))
  }
  if (percent === null) {
    const busy = readTrim(`${KGSL_ROOT}/gpubusy`)
    if (busy !== null) {
      const [used, total] = busy.split(/\s+/).map(Number)
      if (Number.isFinite(used) && Number.isFinite(total) && total > 0) {
        percent = clamp((used / total) * 100, 0, 100)
      }
    }
  }
  const milli = readNumber(`${KGSL_ROOT}/temp`)
  const zones = readZones(device.zones)
  const zoneMax = maxTemp(zones)
  const tempC = milli === null ? zoneMax : round(milli / 1000, 1)
  return {
    model: device.model,
    percent: percent === null ? null : round(percent, 1),
    clockMhz: readNumber(`${KGSL_ROOT}/clock_mhz`),
    maxClockMhz: readNumber(`${KGSL_ROOT}/max_clock_mhz`),
    tempC,
    tempZones: zones,
  }
}

//#endregion

//#region 内存 / 交换

function readMemory() {
  const text = readText('/proc/meminfo')
  if (text === null) return null
  const fields = new Map()
  for (const line of text.split('\n')) {
    const match = /^(\w+):\s+(\d+)\s*kB$/.exec(line.trim())
    if (match !== null) fields.set(match[1], Number(match[2]) * 1024)
  }
  const total = fields.get('MemTotal')
  if (total === undefined) return null
  const available = fields.get('MemAvailable') ?? fields.get('MemFree') ?? 0
  const used = Math.max(0, total - available)
  const swapTotal = fields.get('SwapTotal') ?? 0
  const swapFree = fields.get('SwapFree') ?? 0
  const swapUsed = Math.max(0, swapTotal - swapFree)
  return {
    totalBytes: total,
    usedBytes: used,
    availableBytes: available,
    percent: total > 0 ? round((used / total) * 100, 1) : null,
    swapTotalBytes: swapTotal,
    swapUsedBytes: swapUsed,
    swapFreeBytes: swapFree,
    swapPercent: swapTotal > 0 ? round((swapUsed / swapTotal) * 100, 1) : null,
  }
}

//#endregion

//#region 存储

function readStorage(mounts) {
  const out = []
  for (const mount of mounts) {
    try {
      const stat = statfsSync(mount)
      const blockSize = stat.bsize
      const total = stat.blocks * blockSize
      const free = stat.bfree * blockSize
      const avail = stat.bavail * blockSize
      const used = Math.max(0, total - free)
      const denominator = used + avail
      out.push({
        mount,
        totalBytes: total,
        usedBytes: used,
        availBytes: avail,
        percent: denominator > 0 ? round((used / denominator) * 100, 1) : null,
      })
    } catch {
      out.push({ mount, totalBytes: null, usedBytes: null, availBytes: null, percent: null })
    }
  }
  return out
}

//#endregion

//#region 电池（/sys/class/power_supply）

const POWER_SUPPLY_ROOT = '/sys/class/power_supply'

/** 充电器节点的 type：USB（含各种充电协议）、市电、无线充电都算「插着电」。 */
const CHARGER_TYPES = new Set(['USB', 'USB_CDP', 'USB_DCP', 'USB_HVDCP', 'Mains', 'Wireless'])

/** @returns 目录下的条目名；目录不存在时是空数组。 */
function listDir(path) {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

/**
 * 找电池节点。目录名各机型不同（`battery` / `BAT0` / `bms`…），所以按
 * `type=Battery` 认，而不是写死路径；没有电池的机器（容器、台式机、开发板）
 * 返回 null，由客户端整块隐藏。
 */
function discoverBattery() {
  const names = listDir(POWER_SUPPLY_ROOT)
  const dir = names
    .map(name => `${POWER_SUPPLY_ROOT}/${name}`)
    .find(path => readTrim(`${path}/type`) === 'Battery')
  if (dir === undefined) return null
  if (readTrim(`${dir}/capacity`) === null && readTrim(`${dir}/status`) === null) return null
  return {
    name: dir.slice(POWER_SUPPLY_ROOT.length + 1),
    dir,
    chargers: names
      .map(name => `${POWER_SUPPLY_ROOT}/${name}`)
      .filter(path => CHARGER_TYPES.has(readTrim(`${path}/type`) ?? '')),
  }
}

/** 内核给的是微伏；少数驱动直接给毫伏或伏，按量级兜底成伏。 */
function toVolts(raw) {
  if (raw === null || !Number.isFinite(raw)) return null
  const magnitude = Math.abs(raw)
  if (magnitude >= 100_000) return round(raw / 1e6, 2)
  if (magnitude >= 1_000) return round(raw / 1e3, 2)
  return round(raw, 2)
}

/**
 * 电流统一成毫安（内核约定放电为负）。Android 的 `CURRENT_NOW` 是微安，
 * 个别驱动给毫安，用「手机电池不可能持续 20A」这条上限兜底。
 */
function toMilliAmps(raw) {
  if (raw === null || !Number.isFinite(raw)) return null
  return Math.abs(raw) > 20_000_000 ? raw : raw / 1000
}

/** 温度：多数驱动给 0.1℃（286 = 28.6℃），已经给摄氏度的直接放行。 */
function toCelsius(raw) {
  if (raw === null || !Number.isFinite(raw)) return null
  return Math.abs(raw) >= 200 ? round(raw / 10, 1) : round(raw, 1)
}

/** 采一次电池；这台机器没有电池节点时返回 null。 */
function readBattery(device) {
  if (device === null) return null
  const dir = device.dir
  const capacity = readNumber(`${dir}/capacity`)
  const status = readTrim(`${dir}/status`) ?? 'Unknown'
  return {
    name: device.name,
    percent: capacity === null ? null : clamp(capacity, 0, 100),
    // 状态保留内核原文（Charging / Discharging / Full / Not charging / Unknown），
    // 由客户端翻成中英文；这里再给出两个布尔量，省得两边各判断一次。
    status,
    charging: status === 'Charging',
    full: status === 'Full',
    // 状态字偶尔会停在 Not charging，电源节点 online 更可靠。
    plugged: device.chargers.some(path => readNumber(`${path}/online`) === 1),
    tempC: toCelsius(readNumber(`${dir}/temp`)),
    voltageV: toVolts(readNumber(`${dir}/voltage_now`)),
    currentMa: toMilliAmps(readNumber(`${dir}/current_now`)),
    health: readTrim(`${dir}/health`),
    technology: readTrim(`${dir}/technology`),
    cycleCount: readNumber(`${dir}/cycle_count`),
  }
}

//#endregion

//#region 网络

function readNetCounters() {
  const text = readText('/proc/net/dev')
  if (text === null) return null
  const counters = new Map()
  for (const line of text.split('\n')) {
    const separator = line.indexOf(':')
    if (separator < 0) continue
    const iface = line.slice(0, separator).trim()
    if (iface === '' || isVirtualInterface(iface)) continue
    const values = line.slice(separator + 1).trim().split(/\s+/).map(Number)
    if (values.length < 9) continue
    const rxBytes = values[0]
    const txBytes = values[8]
    if (!Number.isFinite(rxBytes) || !Number.isFinite(txBytes)) continue
    counters.set(iface, { rxBytes, txBytes })
  }
  return counters
}

/** 用两次计数器快照与时间差算速率（字节/秒）。 */
function netRates(prev, next, elapsedMs) {
  const interfaces = []
  if (prev !== null && next !== null && elapsedMs > 0) {
    const seconds = elapsedMs / 1000
    for (const [name, now] of next) {
      const before = prev.get(name)
      if (before === undefined) continue
      const down = Math.max(0, (now.rxBytes - before.rxBytes) / seconds)
      const up = Math.max(0, (now.txBytes - before.txBytes) / seconds)
      interfaces.push({ name, downBps: round(down, 0), upBps: round(up, 0) })
    }
    // 新出现的接口下一 tick 才有速率；计数器回绕（重启/换网）时取 0 而不是负数。
    interfaces.sort((a, b) => (b.downBps + b.upBps) - (a.downBps + a.upBps))
  }
  const downBps = interfaces.reduce((sum, i) => sum + i.downBps, 0)
  const upBps = interfaces.reduce((sum, i) => sum + i.upBps, 0)
  // 累计流量：开机以来的收发总量，网络卡片底部用。
  let rxBytesTotal = null
  let txBytesTotal = null
  if (next !== null) {
    rxBytesTotal = 0
    txBytesTotal = 0
    for (const counters of next.values()) {
      rxBytesTotal += counters.rxBytes
      txBytesTotal += counters.txBytes
    }
  }
  return { downBps: round(downBps, 0), upBps: round(upBps, 0), interfaces, rxBytesTotal, txBytesTotal }
}

//#endregion

//#region 进程内存排行

/**
 * `/proc/<pid>/stat` 的 rss 以页为单位，而 Node 不暴露页大小。启动时用自身
 * 进程反推一次：`/proc/self/statm` 的 resident 页数对上 `/proc/self/status`
 * 的 VmRSS，两者相除即页大小；只接受 2 的幂且落在常见区间内的结果。
 *
 * @returns 页大小（字节）。
 */
function detectPageSize() {
  const statm = readTrim('/proc/self/statm')
  const status = readText('/proc/self/status')
  if (statm === null || status === null) return 4096
  const residentPages = Number(statm.split(/\s+/)[1])
  const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status)
  if (!Number.isFinite(residentPages) || residentPages <= 0 || match === null) return 4096
  const size = Math.round((Number(match[1]) * 1024) / residentPages)
  return size >= 1024 && size <= 262_144 && (size & (size - 1)) === 0 ? size : 4096
}

const PAGE_SIZE = detectPageSize()

/**
 * `/proc/<pid>/stat` 的 comm 只有 15 字符（`com.android.systemui` 会被截成
 * `ndroid.systemui`），所以对要展示的前 N 名再读一次 `cmdline` 取全名。
 * 解释器进程的 cmdline[0] 只是 `node`/`python3`，就退到脚本名。
 *
 * @param pid - 进程号。
 * @param comm - 截断过的内核进程名。
 * @returns 用于展示的进程名。
 */
const INTERPRETERS = new Set(['node', 'python', 'python3', 'sh', 'bash', 'dash', 'java', 'deno', 'bun', 'perl', 'ruby', 'php'])

function displayName(pid, comm) {
  const cmdline = readText(`/proc/${pid}/cmdline`)
  if (cmdline === null || cmdline === '') return comm
  const argv = cmdline.split('\0')
  const base = (value) => (value === undefined ? '' : value.slice(value.lastIndexOf('/') + 1))
  const first = base(argv[0])
  if (first === '') return comm
  if (!INTERPRETERS.has(first)) return first
  const script = base(argv[1])
  return script !== '' && !script.startsWith('-') ? script : comm
}

/**
 * 按 RSS 从大到小列出进程。只读 `/proc/<pid>/stat` 一个文件就同时拿到进程名
 * 与 RSS，3700+ 进程约几十毫秒，所以调用方要自己缓存，别每个请求都扫。
 *
 * @param limit - 最多返回多少条。
 * @returns `{ processes, scanned }`，各条含 pid / name / rssBytes。
 */
function listProcesses(limit) {
  let entries
  try {
    entries = readdirSync('/proc')
  } catch {
    return { processes: [], scanned: 0 }
  }
  const all = []
  for (const entry of entries) {
    const pid = Number(entry)
    if (!Number.isInteger(pid) || pid <= 0) continue
    const stat = readText(`/proc/${pid}/stat`)
    if (stat === null) continue
    // comm 在括号里且可能含空格/括号，所以取第一对括号之间；再从最后一个右
    // 括号之后切字段——那里 token[0] 是 state（第 3 个字段），rss 是第 24 个。
    const open = stat.indexOf('(')
    const close = stat.lastIndexOf(')')
    if (open < 0 || close < open) continue
    const rssPages = Number(stat.slice(close + 2).split(' ')[21])
    if (!Number.isFinite(rssPages) || rssPages <= 0) continue
    all.push({ pid, comm: stat.slice(open + 1, close), rssBytes: rssPages * PAGE_SIZE })
  }
  all.sort((a, b) => b.rssBytes - a.rssBytes)
  return {
    scanned: all.length,
    processes: all.slice(0, limit).map(p => ({ pid: p.pid, name: displayName(p.pid, p.comm), rssBytes: p.rssBytes })),
  }
}

//#endregion

//#region 最小 WebSocket 服务端

/**
 * 只用 `node:crypto` 实现 RFC 6455 的服务端握手与帧收发。
 *
 * 之所以不引入 `ws`：这个插件被 `dsh plugin --profile web add <path>` 以
 * `link:` 装进 profile，Node 会按**真实路径**解析插件内部的裸模块请求，所以
 * profile 里现成的 `ws` 并不在插件的解析路径上。手写这 100 多行可以保住
 * 「零运行时依赖、加个路径就能装」这个性质，代价只是不支持扩展与压缩——
 * 本插件用不到（只推小段 JSON，帧长一律 < 64 KiB）。
 *
 * @module dsh-device-monitor/ws
 */

const WS_PATH = '/device-monitor/ws'
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
/** 单帧上限：控制消息都是几十字节，超过这个体积说明对端不正常。 */
const WS_MAX_PAYLOAD = 64 * 1024
/** 心跳间隔；连续两个周期没有 pong 就断开，避免半开连接堆积。 */
const WS_PING_MS = 30_000

const OP_TEXT = 0x1
const OP_BINARY = 0x2
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xa

/** 握手应答值：base64(sha1(key + GUID))。 */
function wsAccept(key) {
  return createHash('sha1').update(key + WS_GUID).digest('base64')
}

/** 编码一帧（服务端发出的帧不掩码）。 */
function wsFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8')
  let header
  if (data.length < 126) {
    header = Buffer.allocUnsafe(2)
    header[1] = data.length
  } else if (data.length < 65_536) {
    header = Buffer.allocUnsafe(4)
    header[1] = 126
    header.writeUInt16BE(data.length, 2)
  } else {
    header = Buffer.allocUnsafe(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(data.length), 2)
  }
  header[0] = 0x80 | opcode
  return Buffer.concat([header, data])
}

/**
 * 一条已升级的连接的帧状态机。
 */
class WsPeer {
  /** @param socket - 升级后的裸 socket。 */
  constructor(socket) {
    this.socket = socket
    this.buffer = Buffer.alloc(0)
    this.fragments = []
    this.fragmentOpcode = 0
    this.awaitingPong = false
    this.closed = false
    this.onText = null
    this.onGone = null
    /** 面板是否展开：只有展开的连接才需要进程排行。 */
    this.wantProcesses = false
  }

  /** 把新到的字节喂进状态机，能解析出多少帧就处理多少帧。 */
  push(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    for (;;) {
      const frame = this.readFrame()
      if (frame === null) return
      this.dispatch(frame)
      if (this.closed) return
    }
  }

  /** @returns 解析出的一帧，字节不够时 null。 */
  readFrame() {
    const buffer = this.buffer
    if (buffer.length < 2) return null
    const opcode = buffer[0] & 0x0f
    const fin = (buffer[0] & 0x80) !== 0
    const masked = (buffer[1] & 0x80) !== 0
    let length = buffer[1] & 0x7f
    let offset = 2
    if (length === 126) {
      if (buffer.length < offset + 2) return null
      length = buffer.readUInt16BE(offset)
      offset += 2
    } else if (length === 127) {
      if (buffer.length < offset + 8) return null
      const wide = buffer.readBigUInt64BE(offset)
      offset += 8
      if (wide > BigInt(WS_MAX_PAYLOAD)) {
        this.fail(1009)
        return null
      }
      length = Number(wide)
    }
    if (length > WS_MAX_PAYLOAD) {
      this.fail(1009)
      return null
    }
    // RFC 6455：客户端发来的帧必须掩码，否则按协议错误断开。
    if (!masked) {
      this.fail(1002)
      return null
    }
    if (buffer.length < offset + 4 + length) return null
    const mask = buffer.subarray(offset, offset + 4)
    offset += 4
    const payload = Buffer.allocUnsafe(length)
    for (let index = 0; index < length; index += 1) payload[index] = buffer[offset + index] ^ mask[index & 3]
    this.buffer = buffer.subarray(offset + length)
    return { opcode, fin, payload }
  }

  dispatch(frame) {
    switch (frame.opcode) {
      case OP_TEXT:
      case OP_BINARY:
        if (frame.fin) {
          if (frame.opcode === OP_TEXT) this.emit(frame.payload.toString('utf8'))
          return
        }
        this.fragmentOpcode = frame.opcode
        this.fragments = [frame.payload]
        return
      case 0x0:
        if (this.fragments.length === 0) {
          this.fail(1002)
          return
        }
        this.fragments.push(frame.payload)
        if (frame.fin) {
          const payload = Buffer.concat(this.fragments)
          const opcode = this.fragmentOpcode
          this.fragments = []
          if (opcode === OP_TEXT) this.emit(payload.toString('utf8'))
        }
        return
      case OP_CLOSE:
        this.close(1000)
        return
      case OP_PING:
        this.write(wsFrame(OP_PONG, frame.payload))
        return
      case OP_PONG:
        this.awaitingPong = false
        return
      default:
        this.fail(1002)
    }
  }

  emit(text) {
    if (typeof this.onText === 'function') this.onText(text)
  }

  write(buffer) {
    if (this.closed || this.socket.destroyed) return
    try {
      this.socket.write(buffer)
    } catch {
      this.gone()
    }
  }

  /** 推一条 JSON 文本消息（内部 stringify）。 */
  send(value) {
    this.sendRaw(JSON.stringify(value))
  }

  /** 推一条已经序列化好的文本帧（广播热路径上复用同一份字符串）。 */
  sendRaw(text) {
    this.write(wsFrame(OP_TEXT, text))
  }

  ping() {
    if (this.awaitingPong) {
      // 上一轮心跳没回，认定对端已死。
      this.close(1001)
      return
    }
    this.awaitingPong = true
    this.write(wsFrame(OP_PING, Buffer.alloc(0)))
  }

  close(code) {
    if (this.closed) return
    const payload = Buffer.allocUnsafe(2)
    payload.writeUInt16BE(code, 0)
    this.write(wsFrame(OP_CLOSE, payload))
    this.closed = true
    try {
      this.socket.end()
    } catch {
      /* 已经断了 */
    }
    this.gone()
  }

  /** 协议错误：用对应状态码关闭。 */
  fail(code) {
    this.close(code)
  }

  gone() {
    this.closed = true
    if (typeof this.onGone === 'function') {
      const callback = this.onGone
      this.onGone = null
      callback(this)
    }
  }
}

//#endregion

//#region 采样器

const DEFAULT_MOUNTS = ['/']

function resolveConfig(raw) {
  return {
    intervalMs: clamp(Math.round(raw?.intervalMs ?? 1000), 250, 60_000),
    historySize: clamp(Math.round(raw?.historySize ?? 240), 10, 86_400),
    mounts:
      Array.isArray(raw?.mounts) && raw.mounts.length > 0 && raw.mounts.every(m => typeof m === 'string')
        ? raw.mounts
        : DEFAULT_MOUNTS,
  }
}

/**
 * 周期性把设备指标采成一个 JSON 点，并在内存里保留一小段历史。
 */
export class DeviceSampler {
  /** @param config - 已归一化的配置。 */
  constructor(config) {
    this.config = config
    this.gpuDevice = discoverGpu()
    this.batteryDevice = discoverBattery()
    this.cpuZones = discoverZones(CPU_ZONE)
    this.cores = readCpuCoreCount()
    this.history = []
    this.timer = null
    this.prevCpu = null
    this.prevNet = null
    this.prevAt = null
    this.startedAt = Date.now()
    this.lastError = null
    /** 每个 tick 之后拿到最新点的订阅者（WebSocket 推送用）。 */
    this.listeners = new Set()
  }

  /**
   * 订阅每个采样点。
   * @param listener - 收到最新点的回调。
   * @returns 退订函数。
   */
  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 采一个点并写入环形缓冲。 */
  tick() {
    const now = Date.now()
    try {
      const cpuTimes = readCpuTimes()
      const netCounters = readNetCounters()
      const elapsedMs = this.prevAt === null ? 0 : now - this.prevAt

      const perCore = []
      if (cpuTimes !== null && this.prevCpu !== null && cpuTimes.cores.length === this.prevCpu.cores.length) {
        for (let i = 0; i < cpuTimes.cores.length; i += 1) {
          const pct = usagePercent(this.prevCpu.cores[i], cpuTimes.cores[i])
          if (pct !== null) perCore.push(round(pct, 1))
        }
      }

      const cpuZones = readZones(this.cpuZones)
      const load = readLoadavg()
      const point = {
        ts: now,
        uptimeSec: readUptimeSeconds(),
        cpu: {
          percent: usagePercent(this.prevCpu?.aggregate ?? null, cpuTimes?.aggregate ?? null),
          perCore,
          cores: this.cores ?? cpuTimes?.cores.length ?? null,
          load1: load?.load1 ?? null,
          load5: load?.load5 ?? null,
          load15: load?.load15 ?? null,
          runnable: load?.runnable ?? null,
          procs: load?.procs ?? null,
          // 上下文切换是累计值；面板要的是 /s，用本 tick 与上一 tick 的差算。
          ctxt: cpuTimes?.ctxt ?? null,
          ctxtPerSec:
            cpuTimes?.ctxt !== null && cpuTimes?.ctxt !== undefined && this.prevCpu?.ctxt !== null && this.prevCpu?.ctxt !== undefined && elapsedMs > 0
              ? round(((cpuTimes.ctxt - this.prevCpu.ctxt) / elapsedMs) * 1000, 0)
              : null,
          freqMhz: round(readCpuFreqMhz(), 0),
          tempC: maxTemp(cpuZones),
          tempZones: cpuZones,
        },
        gpu: readGpu(this.gpuDevice),
        memory: readMemory(),
        storage: readStorage(this.config.mounts),
        battery: readBattery(this.batteryDevice),
        net: netRates(this.prevNet, netCounters, elapsedMs),
      }

      this.prevCpu = cpuTimes
      this.prevNet = netCounters
      this.prevAt = now
      this.lastError = null

      this.history.push(point)
      while (this.history.length > this.config.historySize) this.history.shift()
      for (const listener of this.listeners) {
        try {
          listener(point)
        } catch {
          // 一个订阅者出错不影响采样本身。
        }
      }
      return point
    } catch (error) {
      // 采样失败绝不能让宿主崩掉：记录一次，下一 tick 继续。
      this.lastError = error instanceof Error ? error.message : String(error)
      return null
    }
  }

  start() {
    this.dispose()
    this.tick()
    this.timer = setInterval(() => { this.tick() }, this.config.intervalMs)
    // 不要因为这个纯展示用的定时器把进程钉在 event loop 上。
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  /**
   * 改采样周期并立即按新周期重排定时器（面板头部那个 1s/2s/5s 选择器）。
   * @param intervalMs - 期望周期，会被钳进 250..60000。
   * @returns 实际生效的周期。
   */
  setIntervalMs(intervalMs) {
    const next = clamp(Math.round(intervalMs), 250, 60_000)
    if (next === this.config.intervalMs) return next
    this.config.intervalMs = next
    if (this.timer !== null) this.start()
    return next
  }

  dispose() {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  latest() {
    return this.history.length === 0 ? null : this.history[this.history.length - 1]
  }

  slice(window) {
    const take = clamp(Math.round(window ?? this.history.length), 1, this.history.length || 1)
    return this.history.slice(-take)
  }
}

//#endregion

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    // 每次响应独立连接：DSH webserver 有 keep-alive，浏览器池化的高频轮询
    // 曾出现半开 socket 挂死；本地回环重建连接的成本可以忽略。
    connection: 'close',
  })
  res.end(JSON.stringify(body))
}

/**
 * 插件入口：起采样器，并把只读快照挂到 webServer 上。
 *
 * @param ctx - Cordis 上下文（inject `webServer`）。
 * @param rawConfig - cordis.patch.yml 中的 config 块。
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const sampler = new DeviceSampler(config)
  // 扫一遍 /proc 要十几到几十毫秒，所以进程排行不跟着每个 tick 走：只有至少
  // 一个连接订阅了进程、且距上次超过 PROCESS_PUSH_MS 时才扫。
  const PROCESS_PUSH_MS = 3000
  let processCache = { at: 0, limit: 0, body: null }
  let processPushedAt = 0
  /** 所有活着的 WebSocket 连接。 */
  const peers = new Set()

  ctx.effect(() => {
    sampler.start()
    const summary =
      `[dsh-device-monitor] sampler started (interval ${config.intervalMs}ms, history ${config.historySize}, ` +
      `mounts ${config.mounts.join(',')}, gpu ${sampler.gpuDevice?.model ?? 'unavailable'}, ` +
      `battery ${sampler.batteryDevice?.name ?? 'unavailable'}, cpu zones ${sampler.cpuZones.length})`
    // console.log 是为了让这行落进 dsh 的 web.log：宿主重启后不必登录 GUI
    // 就能确认插件有没有被加载。
    console.log(summary)
    ctx.logger?.info?.(summary)
    return () => sampler.dispose()
  }, 'dsh-device-monitor: sampler')

  ctx.effect(() => {
    /**
     * 每个采样点推给所有连接。进程排行走独立的 3s 节流，且只发给订阅了的连接。
     * @param point - 最新采样点。
     */
    const unsubscribe = sampler.subscribe(point => {
      let wantsProcesses = false
      for (const peer of peers) if (peer.wantProcesses) wantsProcesses = true

      let processes = null
      if (wantsProcesses && Date.now() - processPushedAt >= PROCESS_PUSH_MS) {
        processPushedAt = Date.now()
        processes = listProcesses(12).processes
      }

      const snapshot = JSON.stringify({ type: 'snapshot', now: point })
      const processFrame = processes === null ? null : JSON.stringify({ type: 'processes', processes })
      for (const peer of peers) {
        peer.sendRaw(snapshot)
        if (processFrame !== null && peer.wantProcesses) peer.sendRaw(processFrame)
      }
    })

    // 心跳：连续两个周期没回 pong 的连接会被 peer.ping() 关掉。
    const heartbeat = setInterval(() => { for (const peer of peers) peer.ping() }, WS_PING_MS)
    if (typeof heartbeat.unref === 'function') heartbeat.unref()

    return () => {
      unsubscribe()
      clearInterval(heartbeat)
      for (const peer of peers) peer.close(1001)
      peers.clear()
    }
  }, 'dsh-device-monitor: websocket broadcast')

  ctx.effect(
    () =>
      ctx.webServer.registerUpgrade({
        path: WS_PATH,
        handler: (req, socket, head) => {
          const key = req.headers['sec-websocket-key']
          const version = req.headers['sec-websocket-version']
          if (typeof key !== 'string' || version !== '13') {
            socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
            return
          }

          socket.write(
            'HTTP/1.1 101 Switching Protocols\r\n' +
              'Upgrade: websocket\r\n' +
              'Connection: Upgrade\r\n' +
              `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`,
          )
          socket.setNoDelay?.(true)

          const peer = new WsPeer(socket)
          peers.add(peer)
          peer.onGone = gone => {
            peers.delete(gone)
            if (peers.size === 0) processPushedAt = 0
          }
          peer.onText = text => {
            // 控制消息都很小；解析失败就当没看见，不因此断开。
            let message = null
            try {
              message = JSON.parse(text)
            } catch {
              return
            }
            if (message === null || typeof message !== 'object') return
            if (message.type === 'subscribe') {
              peer.wantProcesses = message.processes === true
              if (peer.wantProcesses) processPushedAt = 0
              return
            }
            if (message.type === 'config') {
              // 头部的刷新间隔直接驱动宿主采样周期，并把生效值广播回所有连接。
              const applied = sampler.setIntervalMs(Number(message.intervalMs))
              for (const each of peers) each.send({ type: 'hello', intervalMs: applied })
            }
          }

          // 首帧先给一条 hello + 当前快照，不必等下一个 tick。
          peer.send({ type: 'hello', intervalMs: sampler.config.intervalMs })
          const now = sampler.latest()
          if (now !== null) peer.send({ type: 'snapshot', now })

          socket.on('data', chunk => peer.push(chunk))
          socket.on('error', () => peer.gone())
          socket.on('close', () => peer.gone())
          if (head !== undefined && head.length > 0) peer.push(head)
        },
      }),
    'dsh-device-monitor: websocket',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: (req, res) => {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const path = url.pathname

          if (path === `${API_PREFIX}/snapshot`) {
            const light = url.searchParams.get('light') === '1'
            const now = sampler.latest()
            json(res, 200, light ? { now } : { now, history: sampler.slice(Number(url.searchParams.get('window') ?? '120')) })
            return
          }

          if (path === `${API_PREFIX}/processes`) {
            const raw = Number(url.searchParams.get('limit') ?? '12')
            const limit = Number.isInteger(raw) && raw > 0 ? Math.min(raw, 50) : 12
            const at = Date.now()
            if (processCache.body === null || processCache.limit !== limit || at - processCache.at > 2000) {
              const listed = listProcesses(limit)
              processCache = { at, limit, body: { at, scanned: listed.scanned, processes: listed.processes } }
            }
            json(res, 200, processCache.body)
            return
          }

          if (path === `${API_PREFIX}/health`) {
            json(res, 200, {
              ok: sampler.lastError === null,
              startedAt: sampler.startedAt,
              intervalMs: config.intervalMs,
              samples: sampler.history.length,
              gpu: sampler.gpuDevice?.model ?? null,
              cpuZones: sampler.cpuZones.map(z => z.name),
              wsClients: peers.size,
              lastError: sampler.lastError,
            })
            return
          }

          json(res, 404, { error: 'not-found' })
        },
      }),
    'dsh-device-monitor: rest api',
  )
}
