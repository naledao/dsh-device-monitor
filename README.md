# dsh-device-monitor

DSH 的**本机设备监控**插件：在 Web GUI 输入框下方加一条实时监控栏，点击展开面板
查看读数明细与短时曲线。

监控这台设备本身（不是远程服务器）：

| 分组 | 内容 | 数据源 |
|---|---|---|
| 概览 | 运行时间 | `/proc/uptime` |
| CPU | 使用率、负载/核心数、平均频率、进程数、上下文切换速率、温度 | `/proc/stat`、`/proc/loadavg`、`/proc/cpuinfo`、`/sys/devices/system/cpu/cpufreq/*`、`/sys/class/thermal/thermal_zone*`（`cpuss-*` / `cpu-*-*`） |
| GPU | Adreno 负载、当前/最高频率、温度 | `/sys/class/kgsl/kgsl-3d0/{gpu_model,gpu_busy_percentage,gpubusy,clock_mhz,max_clock_mhz,temp}`、`gpuss-*` 热区 |
| 内存 | 物理内存已使用/可用、交换分区占用 | `/proc/meminfo` |
| 存储 | 各挂载点已用/可用/百分比 | `statfs`（默认挂载点 `/`） |
| 网络 | 下行/上行速率（含活跃接口）、开机以来总下载/总上传 | `/proc/net/dev` 按采样间隔差分 |
| 进程 | 内存排行：PID + 名称 + 相对榜首占比条 + RSS + 占物理内存百分比，滚动区 | `/proc/<pid>/stat` + `/proc/<pid>/cmdline` |

## 安装

插件是标准 DSH 插件包：`package.json` 里声明了 `dsh.bundle.patch` 与 `dsh.client`，
所以 `dsh plugin` 会自动把它接进 profile 的 bundle 层叠，不需要手工改配置。

```bash
# 从本地目录安装（开发/自用）
dsh plugin --profile web add /root/chat/deepseek/dsh-device-monitor

# 安装后确认它进了 bundles 列表
cat ~/.dsh/profiles/web/package.json

# 确认组合后的配置树里有插件行（不启动服务）
dsh --profile web --dump-config | rg -A8 'dsh-device-monitor'
```

`dsh plugin` 把参数原样转发给 profile 目录里的 pnpm，然后按**已安装状态**对账
`dsh.profile.bundles`：声明了 `dsh.bundle` 的依赖自动入列，移除或不再声明 bundle
的依赖自动出列。因此下面这些写法都成立：

```bash
dsh plugin --profile web add /abs/path/to/dsh-device-monitor   # 目录（本机用 link:）
dsh plugin --profile web add ./dsh-device-monitor              # 相对路径，按调用目录解析
dsh plugin --profile web add ./dsh-device-monitor-0.1.0.tgz   # tarball
dsh plugin --profile web add dsh-device-monitor                # npm 上的同名包
```

安装完成后**重启该 profile 的 dsh 进程**才会生效（bundle 层叠在启动时组合；客户端
bundle 也需要重启后才会被 `/plugins` 提供）。

## 卸载与回滚

```bash
dsh plugin --profile web remove dsh-device-monitor
# 然后重启 dsh 进程
```

`remove` 之后 `dsh.profile.bundles` 会自动去掉这一层。插件不写任何系统文件、不改
任何系统配置，所以回滚就是卸载；`lib/` 是唯一的运行产物。

## 使用

- 输入框下方的监控栏显示：`CPU 12% 38℃ │ GPU 0% 37℃ │ 内存 36% │ 交换 12% │ 存储 53% │ 网络 ↓1.2M/s ↑24K/s`。
- **数据由宿主主动推送**：页面打开一条 WebSocket（`/device-monitor/ws`），宿主每个采样周期推一帧；浏览器不再轮询。断线按 1s/2s/4s… 封顶 15s 退避重连，标题栏右侧的圆点显示 `已连接` / `重连中`。
- 点击监控栏展开面板，结构是：
  - **标题栏**：`系统资源监控` + 运行时间，右侧只有一个连接状态圆点（`已连接` / `重连中`）。
    - 采样周期只由 profile 配置的 `intervalMs` 决定；收起面板点监控栏本身即可，面板内不再有额外的收起按钮。
    - 曾经有过「实时刷新」暂停开关与 1s/2s/5s 间隔选择器，均已移除：前者只能冻结本地显示、既不省电也管不到进程表（语义不诚实），后者不如直接写进配置。
  - **第一行**：CPU / GPU / 内存 / 存储四张等高卡片（`auto-fit`，窗口变窄自动减列）。每张是「图标 + 名称 + 右侧副标题 → 大号读数 → 进度条 → 最近 120 秒曲线 → 底部两列小指标」；内存与存储的小指标是「已使用 / 可用」迷你条。
  - **第二行**：网络卡（下行/上行大号读数 + 绿色/橙色曲线 + 底部总下载/总上传）与**进程内存排行**卡并排，进程卡吃掉剩余宽度。
- 进程排行取前 12 名，固定高度可滚动：
  - 面板展开时前端发 `{type:'subscribe', processes:true}`，宿主才扫 `/proc` 并把结果并入推送，**不低于 3s 一次**；收起即退订。
  - 条形按**相对榜首**画（按占物理内存百分比画的话所有条都短得看不见），右侧另有精确的 RSS 与占比。
  - 名称取自 `cmdline`：`/proc/<pid>/stat` 的 comm 只有 15 字符（`com.android.systemui` 会被截成 `ndroid.systemui`），解释器进程退回脚本名，取不到再退回 comm。
- 曲线数据只存在于浏览器内存里（每次推送一个点、上限 120 个），关掉页面即释放，不落盘。
- 没有对应传感器的平台（例如非高通设备没有 kgsl）显示「不可用」，而不是假的 0%。

## 配置

在 profile 的 `cordis.patch.yml` 里按 id 覆盖（或直接改插件自带
`cordis.patch.yml` 的默认值）：

```yaml
- id: dsh-device-monitor
  config:
    intervalMs: 1000     # 采样间隔（毫秒），250..60000
    historySize: 240     # 宿主 REST history 窗口条数，10..86400
    mounts:              # 要展示占用的挂载点
      - /
```

> `intervalMs` 为 0 或负数会被钳到 250；面板曲线由客户端自己攒，不受
> `historySize` 影响，该配置只决定 `/device-monitor/api/snapshot` 的 history 长度。
> 改这个值需要重启 dsh 生效；运行中也可以通过 WebSocket 发 `{type:config, intervalMs}` 改写（不落盘）。

## 数据通道：WebSocket 推送

浏览器读不到 `/proc` 与 sysfs，采样全部在宿主侧完成，然后**由宿主主动推**到页面。

| 方向 | 报文 | 说明 |
|---|---|---|
| 宿主 → 页面 | `{type:'hello', intervalMs}` | 连接建立后第一帧；改采样周期后会再广播一次生效值 |
| 宿主 → 页面 | `{type:'snapshot', now}` | 每个采样周期一帧，`now` 与 REST 的 `now` 同构 |
| 宿主 → 页面 | `{type:'processes', processes}` | 仅发给订阅了的连接，不低于 3s 一次 |
| 页面 → 宿主 | `{type:'subscribe', processes:true/false}` | 面板展开/收起时发送 |
| 页面 → 宿主 | `{type:'config', intervalMs}` | 改采样周期；宿主钳到 250..60000 后把生效值广播回所有连接。**界面已不再发送**，保留给脚本或其他客户端 |

- 路径 `/device-monitor/ws`，用 `ctx.webServer.registerUpgrade` 注册（精确匹配）。
- 协议是**手写的 RFC 6455 最小实现**（`node:crypto`，约 120 行）：握手、文本/二进制帧、
  分片重组、ping/pong 心跳（30s）、关闭帧；不支持扩展与压缩，单帧上限 64 KiB。
  之所以不引 `ws`：插件以 `link:` 装进 profile，Node 按**真实路径**解析插件内部的裸模块，
  profile 里现成的 `ws` 不在插件的解析路径上；手写能保住「零运行时依赖、给个路径就能装」。
- 认证与 HTTP 同门禁：`@xgone/dsh-remote` 会包装每个 upgrade 处理器，未认证的升级会被拒。

## REST 接口（排查用，界面已不依赖）

```bash
curl -sS --noproxy '*' 'http://127.0.0.1:3080/device-monitor/api/health'
curl -sS --noproxy '*' 'http://127.0.0.1:3080/device-monitor/api/snapshot?light=1' | head -c 400
curl -sS --noproxy '*' 'http://127.0.0.1:3080/device-monitor/api/processes?limit=5'
```

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/device-monitor/api/snapshot` | `{ now, history }`，`history` 默认最近 120 条 |
| GET | `/device-monitor/api/snapshot?light=1` | 只要 `{ now }` |
| GET | `/device-monitor/api/processes?limit=12` | `{ at, scanned, processes: [{ pid, name, rssBytes }] }`，按 RSS 降序；缓存 2s，`limit` 上限 50 |
| GET | `/device-monitor/api/health` | 采样器存活状态、采样周期、`wsClients` 连接数、GPU 与 CPU 热区 |

## 测试

```bash
npm test          # = node test/smoke.mjs && node test/websocket.mjs
```

- `test/smoke.mjs`：宿主半侧在真机上真采样一次并校验字段自洽；客户端半侧用最小
  React/hooks 替身加载 `lib/client.js`，校验槽位注册与整棵面板树的渲染。
- `test/websocket.mjs`：起真实 `node:http` server、接上插件注册的 upgrade 路由，再用
  Node 内置的 WHATWG `WebSocket` 客户端连进来——跑的是真握手与真帧编解码。覆盖：
  握手、首帧 hello/snapshot、按周期持续推送、进程订阅与退订、改采样周期、越界钳制、
  坏消息不断连、断开后连接计数回落。

## 结构

```
dsh-device-monitor/
├── package.json          # dsh.bundle.patch + dsh.client 声明
├── cordis.patch.yml      # 插入插件行与默认配置
├── lib/
│   ├── index.js          # 宿主：采样器 + 只读 REST
│   └── client.js         # 浏览器：module-loader bundle（React.createElement，无构建步骤）
└── test/smoke.mjs
```

`lib/client.js` 是手写产物，不经过打包器：它只 `require('react')`（外壳基座表里的
静态模块），因此不需要 DSH 源码仓库或 tsdown 就能维护。
