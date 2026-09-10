window.__ModuleLoader__.load({
	id: 'dsh-device-monitor',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const React = require('react')
		const { useCallback, useEffect, useRef, useState } = React

		//#region 文案
		const LANG = (typeof navigator !== 'undefined' && typeof navigator.language === 'string' ? navigator.language : 'zh')
			.toLowerCase()
			.startsWith('zh') ? 'zh' : 'en'

		const TEXT = {
			zh: {
				waiting: '设备采样中…',
				title: '系统资源监控',
				uptime: '运行时间',
				connected: '已连接',
				reconnecting: '重连中',
				connecting: '连接监控服务…',
				day: '天',
				cpu: 'CPU',
				gpu: 'GPU',
				memory: '内存',
				swap: '交换',
				storage: '存储',
				net: '网络',
				cores: '核心',
				freq: '频率',
				procs: '进程数',
				ctxt: '上下文切换',
				temp: '温度',
				model: '型号',
				used: '已使用',
				avail: '可用',
				swapPart: '交换分区',
				down: '下行',
				up: '上行',
				totalDown: '总下载',
				totalUp: '总上传',
				unavailable: '不可用',
				clickHint: '点击展开设备监控面板',
				procTitle: '进程内存排行',
				procTop: 'Top 12',
				pid: 'PID',
				procName: '进程名',
				procMem: '内存',
				procPct: '占比',
				scanning: '读取进程…',
			},
			en: {
				waiting: 'sampling…',
				title: 'System monitor',
				uptime: 'Uptime',
				connected: 'live',
				reconnecting: 'reconnecting',
				connecting: 'connecting…',
				day: 'd',
				cpu: 'CPU',
				gpu: 'GPU',
				memory: 'Memory',
				swap: 'Swap',
				storage: 'Storage',
				net: 'Network',
				cores: 'cores',
				freq: 'Clock',
				procs: 'Processes',
				ctxt: 'Ctx switches',
				temp: 'Temp',
				model: 'Model',
				used: 'Used',
				avail: 'Free',
				swapPart: 'Swap',
				down: 'DOWN',
				up: 'UP',
				totalDown: 'Total down',
				totalUp: 'Total up',
				unavailable: 'unavailable',
				clickHint: 'Click to open the device monitor panel',
				procTitle: 'Processes by memory',
				procTop: 'Top 12',
				pid: 'PID',
				procName: 'Process',
				procMem: 'Memory',
				procPct: 'Share',
				scanning: 'scanning…',
			},
		}
		const t = TEXT[LANG]
		//#endregion

		//#region 图标
		/** 每个值是一组 SVG path 的 `d`；统一 16×16、描边取 currentColor。 */
		const ICONS = {
			cpu: ['M5.5 5.5h5v5h-5z', 'M7 2.5v3M9 2.5v3M7 10.5v3M9 10.5v3M2.5 7h3M2.5 9h3M10.5 7h3M10.5 9h3'],
			gpu: ['M2.5 4.5h11v7h-11z', 'M5 11.5v2M11 11.5v2', 'M5 7.5h5.5'],
			memory: ['M2.5 5h11v5.5h-11z', 'M5 10.5v2M8 10.5v2M11 10.5v2', 'M5 7h6'],
			storage: [
				'M2.5 4.5c0-1.1 2.5-2 5.5-2s5.5.9 5.5 2-2.5 2-5.5 2-5.5-.9-5.5-2z',
				'M2.5 4.5v7c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2v-7',
				'M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2',
			],
			net: ['M8 2.2a5.8 5.8 0 1 0 0 11.6A5.8 5.8 0 0 0 8 2.2z', 'M2.4 8h11.2', 'M8 2.2c1.9 2.1 1.9 9.5 0 11.6M8 2.2c-1.9 2.1-1.9 9.5 0 11.6'],
			list: ['M3 4.2h10M3 8h10M3 11.8h10'],
			pulse: ['M2 8h2.8l1.6-4.2L8.8 12l1.5-4H14'],
		}

		function Icon(props) {
			return React.createElement(
				'svg',
				{
					className: 'ddm-ico',
					width: 14,
					height: 14,
					viewBox: '0 0 16 16',
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.3,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
					'aria-hidden': 'true',
				},
				(ICONS[props.name] ?? []).map((d, index) => React.createElement('path', { key: index, d })),
			)
		}
		//#endregion

		//#region 样式
		/** 每张卡片一个强调色，通过 --ddm-accent 下发给进度条与曲线。 */
		const ACCENT = {
			cpu: '#5b8def',
			gpu: '#22c55e',
			memory: '#f59e0b',
			storage: '#a855f7',
			net: '#0ea5e9',
			procs: '#5b8def',
		}

		const STYLES = `
.ddm-wrap {
  display: block;
  width: 100%;
  max-width: var(--dsh-composer-card-max-width, 780px);
  margin: 0 auto;
  box-sizing: border-box;
}
.ddm-bar {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: center;
  column-gap: 10px;
  row-gap: 2px;
  width: 100%;
  margin: 0;
  padding: 4px 0 0;
  border: none;
  background: transparent;
  font: inherit;
  font-size: 12px;
  line-height: 20px;
  color: var(--dsw-alias-label-tertiary, #9aa0aa);
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  text-align: center;
}
.ddm-bar:hover { color: var(--dsw-alias-label-secondary, #c8ccd4); }
.ddm-seg { display: inline-block; white-space: nowrap; }

/* ── 外层卡片 ─────────────────────────────────────────── */
.ddm-panel {
  margin: 6px auto 0;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.18));
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  color: var(--dsw-alias-label-primary, #1a1d24);
  font-size: 12px;
  color-scheme: light dark;
  text-align: left;
  overflow: hidden;
}
.ddm-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.14));
  background: rgba(127, 127, 127, 0.05);
}
.ddm-head-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #1a1d24);
}
.ddm-head-title .ddm-ico { color: #5b8def; }
.ddm-head-meta {
  color: var(--dsw-alias-label-tertiary, #9aa0aa);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.ddm-grow { flex: 1 1 auto; }
/* 连接状态：推送断了要看得见，否则数字停住会以为是设备闲。 */
.ddm-status { display: inline-flex; align-items: center; gap: 5px; color: #e8871e; white-space: nowrap; }
.ddm-status-on { color: #16a34a; }
.ddm-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.ddm-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 12px 12px;
}
/* 第一行四张等高卡片；第二行网络固定一份宽度、进程表吃掉其余。 */
.ddm-row1 {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(212px, 1fr));
  align-items: stretch;
  gap: 10px;
}
.ddm-row2 { display: flex; flex-wrap: wrap; align-items: stretch; gap: 10px; }
.ddm-row2 > .ddm-net { flex: 0 1 250px; min-width: 212px; }
.ddm-row2 > .ddm-procs { flex: 1 1 340px; min-width: 0; }

/* ── 指标卡片 ─────────────────────────────────────────── */
.ddm-card {
  display: flex;
  flex-direction: column;
  min-width: 0;
  /* 卡片宽度由外层网格决定，这里只按自身宽度响应式（见 .ddm-stats 的容器查询）。 */
  container-type: inline-size;
  padding: 8px 10px 9px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.16));
  border-radius: 8px;
  background: rgba(127, 127, 127, 0.03);
}
.ddm-card-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
.ddm-ico { flex: 0 0 auto; display: inline-block; color: var(--ddm-accent, #5b8def); }
.ddm-card-name { flex: 0 0 auto; font-weight: 600; color: var(--dsw-alias-label-secondary, #5b6472); }
.ddm-card-sub {
  flex: 0 1 auto;
  margin-left: auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-tertiary, #9aa0aa);
  font-variant-numeric: tabular-nums;
}
.ddm-main { display: flex; align-items: baseline; gap: 8px; margin-top: 3px; }
.ddm-big {
  font-size: 21px;
  font-weight: 600;
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
}
.ddm-meter {
  height: 5px;
  margin-top: 6px;
  border-radius: 3px;
  background: var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.16));
  overflow: hidden;
}
.ddm-meter > span {
  display: block;
  height: 100%;
  border-radius: 3px;
  background: var(--ddm-accent, #5b8def);
}
.ddm-chart { margin-top: 7px; color: var(--ddm-accent, #5b8def); }
.ddm-spark { display: block; width: 100%; }
.ddm-stats {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 2px 12px;
  margin: 0;
  margin-top: auto;
  padding-top: 7px;
  border-top: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.12));
}
/* 卡片窄到放不下并排的「标签 + 条 + 数值」时，只保守留「标签 + 数值」：
   这个宽度下迷你条本来就被压到几像素，留着只会把数值挤进隔壁格子。独占一行的长条目
   （交换分区、多挂载点）仍有空间画条，所以只对并排的小条目隐藏。 */
@container (max-width: 260px) {
  .ddm-usage:not(.ddm-usage-wide) .ddm-usage-meter { display: none; }
}
.ddm-stat-wide { grid-column: 1 / -1; }
.ddm-usage-wide { grid-column: 1 / -1; }
.ddm-stat { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.ddm-stat dt { flex: 0 0 auto; margin: 0; color: var(--dsw-alias-label-tertiary, #9aa0aa); }
.ddm-stat dd {
  flex: 1 1 auto;
  margin: 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
/* 内存 / 存储卡片里的「已使用 / 可用」：小标签 + 迷你条 + 数值。 */
/* 三个子项都允许收缩并且不溢出：任何宽度下都不会压到相邻格子。 */
.ddm-usage { display: flex; align-items: center; gap: 8px; min-height: 18px; line-height: 18px; min-width: 0; }
.ddm-usage-label { flex: 0 0 auto; min-width: 0; color: var(--dsw-alias-label-tertiary, #9aa0aa); white-space: nowrap; }
.ddm-usage-meter {
  flex: 1 1 0;
  min-width: 0;
  height: 5px;
  border-radius: 3px;
  background: var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.16));
  overflow: hidden;
}
.ddm-usage-meter > span {
  display: block;
  height: 100%;
  border-radius: 3px;
  background: var(--ddm-accent, #5b8def);
}
.ddm-usage-value {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.ddm-usage + .ddm-usage { margin-top: 4px; }

/* ── 网络卡片 ─────────────────────────────────────────── */
.ddm-net-grid { display: flex; gap: 12px; margin-top: 4px; }
.ddm-net-col { flex: 1 1 0; min-width: 0; }
.ddm-net-label { display: flex; align-items: center; gap: 4px; color: var(--dsw-alias-label-tertiary, #9aa0aa); }
.ddm-net-value { margin-top: 1px; font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }
.ddm-net-value.ddm-down { color: #16a34a; }
.ddm-net-value.ddm-up { color: #ea580c; }
.ddm-net-chart { margin-top: 3px; }
.ddm-net-chart.ddm-down { color: #16a34a; }
.ddm-net-chart.ddm-up { color: #ea580c; }
.ddm-net-foot {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin-top: auto;
  padding-top: 7px;
  border-top: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.12));
  color: var(--dsw-alias-label-tertiary, #9aa0aa);
}
.ddm-net-foot b { font-weight: 500; color: var(--dsw-alias-label-secondary, #5b6472); font-variant-numeric: tabular-nums; }

/* ── 进程表 ───────────────────────────────────────────── */
.ddm-scroll { max-height: 152px; overflow-y: auto; overscroll-behavior: contain; }
.ddm-tr {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 19px;
  line-height: 19px;
  font-variant-numeric: tabular-nums;
}
.ddm-tr-head {
  position: sticky;
  top: 0;
  z-index: 1;
  margin-bottom: 2px;
  padding-bottom: 3px;
  border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.14));
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  color: var(--dsw-alias-label-tertiary, #9aa0aa);
}
.ddm-td-pid { flex: 0 0 3.6em; text-align: right; color: var(--dsw-alias-label-tertiary, #9aa0aa); }
.ddm-td-name { flex: 0 1 auto; max-width: 22em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ddm-td-bar {
  flex: 1 1 60px;
  height: 5px;
  border-radius: 3px;
  background: var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.16));
  overflow: hidden;
}
.ddm-td-bar > span { display: block; height: 100%; border-radius: 3px; background: #5b8def; }
.ddm-td-mem { flex: 0 0 auto; min-width: 5.6em; text-align: right; }
.ddm-td-pct { flex: 0 0 3.4em; text-align: right; color: var(--dsw-alias-label-secondary, #5b6472); }

.ddm-note { margin: 6px 0 0; color: var(--dsw-alias-label-tertiary, #9aa0aa); }
.ddm-hot { color: #e8871e; }
.ddm-crit { color: #e5484d; }
`
		//#endregion

		//#region 格式化
		function formatBytes(bytes) {
			if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '—'
			const units = ['B', 'K', 'M', 'G', 'T', 'P']
			let value = bytes
			let unit = 0
			while (value >= 1024 && unit < units.length - 1) {
				value /= 1024
				unit += 1
			}
			return `${value >= 100 || unit === 0 ? value.toFixed(0) : value.toFixed(1)}${units[unit]}`
		}

		function formatRate(bytesPerSecond) {
			if (typeof bytesPerSecond !== 'number' || !Number.isFinite(bytesPerSecond)) return '—'
			return `${formatBytes(bytesPerSecond)}/s`
		}

		function formatPercent(value, digits = 1) {
			if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
			return `${value.toFixed(digits)}%`
		}

		function formatTemp(celsius) {
			if (typeof celsius !== 'number' || !Number.isFinite(celsius)) return '—'
			return `${celsius.toFixed(0)}℃`
		}

		/** MHz 上千后换 GHz，避免一长串数字。 */
		function formatClock(mhz) {
			if (typeof mhz !== 'number' || !Number.isFinite(mhz)) return '—'
			return mhz >= 1000 ? `${(mhz / 1000).toFixed(2)} GHz` : `${mhz.toFixed(0)} MHz`
		}

		/** 开机时长：超过一天才带天数。 */
		function formatUptime(seconds) {
			if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '—'
			const days = Math.floor(seconds / 86400)
			const rest = Math.floor(seconds % 86400)
			const clock = [Math.floor(rest / 3600), Math.floor((rest % 3600) / 60), rest % 60]
				.map(part => String(part).padStart(2, '0'))
				.join(':')
			return days > 0 ? `${days}${t.day} ${clock}` : clock
		}

		function usageClass(percent) {
			if (typeof percent !== 'number') return ''
			if (percent >= 90) return 'ddm-crit'
			if (percent >= 75) return 'ddm-hot'
			return ''
		}

		function tempClass(celsius) {
			if (typeof celsius !== 'number') return ''
			if (celsius >= 80) return 'ddm-crit'
			if (celsius >= 65) return 'ddm-hot'
			return ''
		}

		/** 取序列里的数值字段，null 用 0 补齐，保证曲线连续。 */
		function seriesOf(points, pick) {
			const out = []
			for (const point of points) {
				if (point === null || point === undefined) continue
				const value = pick(point)
				out.push(typeof value === 'number' && Number.isFinite(value) ? value : 0)
			}
			return out
		}

		/** 面板头部的运行时间：取最近一个带 uptimeSec 的采样点。 */
		function latestUptime(points) {
			for (let index = points.length - 1; index >= 0; index -= 1) {
				const value = points[index]?.uptimeSec
				if (typeof value === 'number' && Number.isFinite(value)) return value
			}
			return null
		}
		//#endregion

		//#region 数据通道（WebSocket 推送）
		/** 与宿主推送端约定的路径，和 lib/index.js 的 WS_PATH 必须一致。 */
		const WS_PATH = '/device-monitor/ws'
		/** 断线重连退避：1s、2s、4s…封顶 15s。 */
		const RECONNECT_MAX_MS = 15000

		/** 按当前页面协议选 ws / wss，避免在 HTTPS 下被浏览器拦成混合内容。 */
		function socketUrl() {
			const secure = typeof location !== 'undefined' && location.protocol === 'https:'
			const host = typeof location !== 'undefined' ? location.host : '127.0.0.1:3080'
			return `${secure ? 'wss:' : 'ws:'}//${host}${WS_PATH}`
		}
		//#endregion

		//#region 组件
		function Spark(props) {
			const values = props.values ?? []
			if (values.length < 2) return null
			const height = props.height ?? 26
			const width = 100
			const top = props.max ?? Math.max.apply(null, values.concat([1]))
			const span = top > 0 ? top : 1
			const step = width / (values.length - 1)
			const points = values
				.map((value, index) => {
					const ratio = Math.max(0, Math.min(1, value / span))
					return `${(index * step).toFixed(2)},${(height - ratio * height).toFixed(2)}`
				})
				.join(' ')
			return React.createElement(
				'svg',
				{
					className: 'ddm-spark',
					width: '100%',
					height,
					viewBox: `0 0 ${width} ${height}`,
					preserveAspectRatio: 'none',
					'aria-hidden': 'true',
				},
				React.createElement('polyline', {
					points,
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.4,
					strokeLinejoin: 'round',
					strokeLinecap: 'round',
					// 横向拉伸时不让线宽跟着变形。
					vectorEffect: 'non-scaling-stroke',
				}),
			)
		}

		function Stat(props) {
			return React.createElement(
				'div',
				{ className: props.wide === true ? 'ddm-stat ddm-stat-wide' : 'ddm-stat' },
				React.createElement('dt', null, props.label),
				React.createElement('dd', { className: props.valueClass ?? '', title: props.title ?? undefined }, props.value),
			)
		}

		/** 小标签 + 迷你条 + 数值（内存 / 存储的「已使用 / 可用」）。 */
		function Usage(props) {
			const percent = typeof props.percent === 'number' && Number.isFinite(props.percent) ? Math.max(0, Math.min(100, props.percent)) : 0
			return React.createElement(
				'div',
				{ className: props.wide === true ? 'ddm-usage ddm-usage-wide' : 'ddm-usage' },
				React.createElement('span', { className: 'ddm-usage-label' }, props.label),
				React.createElement('span', { className: 'ddm-usage-meter' }, React.createElement('span', { style: { width: `${percent}%` } })),
				React.createElement('span', { className: 'ddm-usage-value' }, props.value),
			)
		}

		function MetricCard(props) {
			const percent = typeof props.percent === 'number' && Number.isFinite(props.percent) ? Math.max(0, Math.min(100, props.percent)) : 0
			return React.createElement(
				'section',
				{ className: 'ddm-card', style: { '--ddm-accent': props.accent } },
				React.createElement(
					'div',
					{ className: 'ddm-card-head' },
					React.createElement(Icon, { name: props.icon }),
					React.createElement('span', { className: 'ddm-card-name' }, props.name),
					props.sub === undefined || props.sub === null
						? null
						: React.createElement('span', { className: 'ddm-card-sub', title: props.subTitle ?? undefined }, props.sub),
				),
				React.createElement('div', { className: 'ddm-main' }, React.createElement('span', { className: `ddm-big ${props.valueClass ?? ''}` }, props.value)),
				React.createElement('div', { className: 'ddm-meter' }, React.createElement('span', { style: { width: `${percent}%` } })),
				props.series === undefined || props.series === null || props.series.length < 2
					? null
					: React.createElement('div', { className: 'ddm-chart' }, React.createElement(Spark, { values: props.series, max: props.seriesMax })),
				React.createElement('dl', { className: 'ddm-stats' }, props.stats),
			)
		}

		function ProcessTable(props) {
			const { processes, totalBytes } = props
			// 条形按「相对榜首」画：按占物理内存百分比画的话所有条都短得看不见。
			const top = processes.length === 0 ? 0 : processes[0].rssBytes
			return React.createElement(
				'div',
				{ className: 'ddm-scroll' },
				React.createElement(
					'div',
					{ className: 'ddm-tr ddm-tr-head' },
					React.createElement('span', { className: 'ddm-td-pid' }, t.pid),
					React.createElement('span', { className: 'ddm-td-name' }, t.procName),
					React.createElement('span', { className: 'ddm-td-bar' }),
					React.createElement('span', { className: 'ddm-td-mem' }, t.procMem),
					React.createElement('span', { className: 'ddm-td-pct' }, t.procPct),
				),
				processes.length === 0
					? React.createElement(
							'div',
							{ className: 'ddm-tr' },
							React.createElement('span', { className: 'ddm-td-name' }, t.scanning),
						)
					: processes.map(proc =>
							React.createElement(
								'div',
								{ className: 'ddm-tr', key: proc.pid },
								React.createElement('span', { className: 'ddm-td-pid' }, proc.pid),
								React.createElement('span', { className: 'ddm-td-name', title: `PID ${proc.pid} · ${proc.name}` }, proc.name),
								React.createElement(
									'span',
									{ className: 'ddm-td-bar' },
									React.createElement('span', { style: { width: `${top > 0 ? Math.max(1, (proc.rssBytes / top) * 100) : 0}%` } }),
								),
								React.createElement('span', { className: 'ddm-td-mem' }, formatBytes(proc.rssBytes)),
								React.createElement(
									'span',
									{ className: 'ddm-td-pct' },
									totalBytes > 0 ? `${((proc.rssBytes / totalBytes) * 100).toFixed(1)}%` : '—',
								),
							),
						),
			)
		}

		function DeviceMonitor() {
			const [latest, setLatest] = useState(null)
			const [series, setSeries] = useState([])
			const [open, setOpen] = useState(false)
			const [procs, setProcs] = useState([])
			const [status, setStatus] = useState('connecting')

			// 连接回调里要读到最新的展开态，用 ref 避免重建 socket。
			const socketRef = useRef(null)
			const openRef = useRef(false)

			// 宿主主动推送：连上就收，断了按退避重连。整个组件只建一条连接。
			useEffect(() => {
				let alive = true
				let retry = 0
				let timer = null
				let socket = null

				const scheduleRetry = () => {
					if (!alive) return
					retry += 1
					const delay = Math.min(1000 * 2 ** (retry - 1), RECONNECT_MAX_MS)
					timer = window.setTimeout(connect, delay)
				}

				const connect = () => {
					if (!alive) return
					let next
					try {
						next = new WebSocket(socketUrl())
					} catch {
						scheduleRetry()
						return
					}
					socket = next
					socketRef.current = next
					setStatus('connecting')

					next.onopen = () => {
						if (!alive) return
						retry = 0
						setStatus('open')
						// 采样周期由 profile 配置决定，这里只同步「面板是否展开」。
						next.send(JSON.stringify({ type: 'subscribe', processes: openRef.current }))
					}

					next.onmessage = event => {
						let message = null
						try {
							message = JSON.parse(event.data)
						} catch {
							return
						}
						if (message === null || typeof message !== 'object') return
						if (message.type === 'processes') {
							if (Array.isArray(message.processes)) setProcs(message.processes)
							return
						}
						if (message.type === 'snapshot' && message.now !== null && typeof message.now === 'object') {
							const point = message.now
							setLatest(point)
							setSeries(previous =>
								previous.length >= 120 ? previous.slice(previous.length - 119).concat([point]) : previous.concat([point]),
							)
						}
					}

					next.onclose = () => {
						if (socketRef.current === next) socketRef.current = null
						if (!alive) return
						setStatus('closed')
						scheduleRetry()
					}

					next.onerror = () => {
						try {
							next.close()
						} catch {
							/* 已经断了 */
						}
					}
				}

				connect()
				return () => {
					alive = false
					if (timer !== null) window.clearTimeout(timer)
					if (socket !== null) {
						socket.onclose = null
						try {
							socket.close()
						} catch {
							/* 已经断了 */
						}
					}
					socketRef.current = null
				}
			}, [])

			// 面板展开/收起：告诉宿主要不要推进程排行（宿主只对订阅了的连接扫 /proc）。
			useEffect(() => {
				openRef.current = open
				const socket = socketRef.current
				if (socket !== null && socket.readyState === 1) {
					socket.send(JSON.stringify({ type: 'subscribe', processes: open }))
				}
			}, [open, status])

			const toggle = useCallback(() => { setOpen(value => !value) }, [])

			if (latest === null) {
				return React.createElement(
					'div',
					{ className: 'ddm-wrap' },
					React.createElement(
						'div',
						{ className: 'ddm-bar' },
						React.createElement('span', { className: 'ddm-seg' }, status === 'open' ? t.waiting : t.connecting),
					),
				)
			}

			const cpu = latest.cpu ?? {}
			const gpu = latest.gpu ?? null
			const memory = latest.memory ?? null
			const storage = Array.isArray(latest.storage) ? latest.storage : []
			const net = latest.net ?? { downBps: null, upBps: null, interfaces: [] }
			const rootDisk = storage.length > 0 ? storage[0] : null

			const segments = [
				React.createElement('span', {
					key: 'cpu',
					className: `ddm-seg ${tempClass(cpu.tempC)}`,
					title: `CPU ${formatPercent(cpu.percent)} · ${t.temp} ${formatTemp(cpu.tempC)} · ${t.cores} ${cpu.cores ?? '—'}`,
				}, `${t.cpu} ${formatPercent(cpu.percent, 0)} ${formatTemp(cpu.tempC)}`),
				React.createElement('span', {
					key: 'gpu',
					className: `ddm-seg ${gpu === null ? '' : tempClass(gpu.tempC)}`,
					title: gpu === null ? t.unavailable : `${gpu.model} · ${formatPercent(gpu.percent)} · ${formatTemp(gpu.tempC)}`,
				}, gpu === null ? `${t.gpu} ${t.unavailable}` : `${t.gpu} ${formatPercent(gpu.percent, 0)} ${formatTemp(gpu.tempC)}`),
				React.createElement('span', {
					key: 'mem',
					className: 'ddm-seg',
					title: memory === null ? undefined : `${t.used} ${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)}`,
				}, `${t.memory} ${memory === null ? '—' : formatPercent(memory.percent, 0)}`),
				memory !== null && memory.swapTotalBytes > 0
					? React.createElement('span', {
							key: 'swap',
							className: 'ddm-seg',
							title: `${t.swapPart} ${formatBytes(memory.swapUsedBytes)} / ${formatBytes(memory.swapTotalBytes)}`,
						}, `${t.swap} ${formatPercent(memory.swapPercent, 0)}`)
					: null,
				rootDisk !== null
					? React.createElement('span', {
							key: 'disk',
							className: `ddm-seg ${usageClass(rootDisk.percent)}`,
							title: storage.map(item => `${item.mount} ${formatBytes(item.usedBytes)}/${formatBytes(item.totalBytes)}`).join(' · '),
						}, `${t.storage} ${formatPercent(rootDisk.percent, 0)}`)
					: null,
				React.createElement('span', {
					key: 'net',
					className: 'ddm-seg',
					title: net.interfaces.map(item => `${item.name} ↓${formatRate(item.downBps)} ↑${formatRate(item.upBps)}`).join(' · ') || undefined,
				}, `${t.net} ↓${formatRate(net.downBps)} ↑${formatRate(net.upBps)}`),
			].filter(segment => segment !== null)

			return React.createElement(
				'div',
				{ className: 'ddm-wrap' },
				React.createElement(
					'button',
					{ type: 'button', className: 'ddm-bar', onClick: toggle, 'aria-expanded': open, title: t.clickHint },
					segments,
				),
				open
					? renderPanel({ cpu, gpu, memory, storage, net, series, procs, status })
					: null,
			)
		}

		/** 展开面板：外层标题栏 + 第一行四张指标卡 + 第二行网络与进程表。 */
		function renderPanel(state) {
			const { cpu, gpu, memory, storage, net, series, procs, status } = state
			const cpuSeries = seriesOf(series, point => point.cpu?.percent)
			const gpuSeries = seriesOf(series, point => point.gpu?.percent)
			const downSeries = seriesOf(series, point => point.net?.downBps)
			const upSeries = seriesOf(series, point => point.net?.upBps)
			const totalBytes = memory === null ? 0 : memory.totalBytes
			const rootDisk = storage.length > 0 ? storage[0] : null
			const activeIfaces = net.interfaces.filter(i => (i.downBps ?? 0) + (i.upBps ?? 0) > 0)

			const head = React.createElement(
				'div',
				{ className: 'ddm-head' },
				React.createElement('span', { className: 'ddm-head-title' }, React.createElement(Icon, { name: 'pulse' }), t.title),
				React.createElement('span', { className: 'ddm-head-meta' }, `${t.uptime} ${formatUptime(latestUptime(series))}`),
				React.createElement('span', { className: 'ddm-grow' }),
				React.createElement(
					'span',
					{ className: status === 'open' ? 'ddm-status ddm-status-on' : 'ddm-status' },
					React.createElement('span', { className: 'ddm-dot' }),
					status === 'open' ? t.connected : t.reconnecting,
				),
			)

			// ── CPU ──────────────────────────────────────────
			const cpuCard = React.createElement(MetricCard, {
				key: 'cpu',
				accent: ACCENT.cpu,
				icon: 'cpu',
				name: t.cpu,
				sub: `${cpu.load1 ?? '—'} / ${cpu.cores ?? '—'} ${t.cores}`,
				value: formatPercent(cpu.percent),
				percent: cpu.percent,
				series: cpuSeries,
				seriesMax: 100,
				stats: [
					React.createElement(Stat, { key: 'freq', label: t.freq, value: formatClock(cpu.freqMhz) }),
					React.createElement(Stat, { key: 'procs', label: t.procs, value: cpu.procs ?? '—' }),
					React.createElement(Stat, {
						key: 'ctxt',
						label: t.ctxt,
						value: cpu.ctxtPerSec === null || cpu.ctxtPerSec === undefined ? '—' : `${cpu.ctxtPerSec}/s`,
					}),
					React.createElement(Stat, { key: 'temp', label: t.temp, value: formatTemp(cpu.tempC), valueClass: tempClass(cpu.tempC) }),
				],
			})

			// ── GPU ──────────────────────────────────────────
			const gpuCard = React.createElement(MetricCard, {
				key: 'gpu',
				accent: ACCENT.gpu,
				icon: 'gpu',
				name: t.gpu,
				sub: gpu === null ? t.unavailable : gpu.model,
				value: gpu === null ? '—' : formatPercent(gpu.percent),
				percent: gpu === null ? null : gpu.percent,
				series: gpuSeries,
				seriesMax: 100,
				stats:
					gpu === null
						? [React.createElement(Stat, { key: 'na', label: t.model, value: t.unavailable, wide: true })]
						: [
								React.createElement(Stat, { key: 'freq', label: t.freq, value: `${gpu.clockMhz ?? '—'} / ${gpu.maxClockMhz ?? '—'} MHz` }),
								React.createElement(Stat, { key: 'temp', label: t.temp, value: formatTemp(gpu.tempC), valueClass: tempClass(gpu.tempC) }),
							],
			})

			// ── 内存 ─────────────────────────────────────────
			const memCard = React.createElement(MetricCard, {
				key: 'memory',
				accent: ACCENT.memory,
				icon: 'memory',
				name: t.memory,
				sub: memory === null ? null : `${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)}`,
				value: memory === null ? '—' : formatPercent(memory.percent),
				percent: memory === null ? null : memory.percent,
				series: null,
				stats:
					memory === null
						? [React.createElement(Stat, { key: 'na', label: t.used, value: '—', wide: true })]
						: [
								React.createElement(Usage, { key: 'used', label: t.used, percent: memory.percent, value: formatBytes(memory.usedBytes) }),
								React.createElement(Usage, {
									key: 'avail',
									label: t.avail,
									percent: memory.totalBytes > 0 ? (memory.availableBytes / memory.totalBytes) * 100 : 0,
									value: formatBytes(memory.availableBytes),
								}),
								React.createElement(Usage, {
									key: 'swap',
									// 「2.7G / 24.0G」比「已使用 / 可用」长得多，独占一行免得挤坏。
									wide: true,
									label: t.swapPart,
									percent: memory.swapTotalBytes > 0 ? memory.swapPercent : 0,
									value:
										memory.swapTotalBytes > 0
											? `${formatBytes(memory.swapUsedBytes)} / ${formatBytes(memory.swapTotalBytes)}`
											: t.unavailable,
								}),
							],
			})

			// ── 存储 ─────────────────────────────────────────
			const diskCard = React.createElement(MetricCard, {
				key: 'storage',
				accent: ACCENT.storage,
				icon: 'storage',
				name: t.storage,
				sub: rootDisk === null ? null : `${formatBytes(rootDisk.usedBytes)} / ${formatBytes(rootDisk.totalBytes)}`,
				value: rootDisk === null ? '—' : formatPercent(rootDisk.percent),
				percent: rootDisk === null ? null : rootDisk.percent,
				series: null,
				stats:
					storage.length === 0
						? [React.createElement(Stat, { key: 'na', label: t.used, value: '—', wide: true })]
						: storage.flatMap((item, index) => {
								const total = item.totalBytes ?? 0
								return [
									React.createElement(Usage, {
										key: `${item.mount}-used-${index}`,
										label: item.mount === '/' ? t.used : `${item.mount} ${t.used}`,
										percent: item.percent,
										value: formatBytes(item.usedBytes),
									}),
									React.createElement(Usage, {
										key: `${item.mount}-avail-${index}`,
										label: t.avail,
										percent: total > 0 && item.availBytes !== null ? (item.availBytes / total) * 100 : 0,
										value: formatBytes(item.availBytes),
									}),
								]
							}),
			})

			// ── 网络 ─────────────────────────────────────────
			const netCard = React.createElement(
				'section',
				{ className: 'ddm-card ddm-net', style: { '--ddm-accent': ACCENT.net } },
				React.createElement(
					'div',
					{ className: 'ddm-card-head' },
					React.createElement(Icon, { name: 'net' }),
					React.createElement('span', { className: 'ddm-card-name' }, t.net),
					React.createElement(
						'span',
						{ className: 'ddm-card-sub', title: activeIfaces.map(i => i.name).join(' · ') || undefined },
						activeIfaces.map(i => i.name).slice(0, 2).join(' · ') || '—',
					),
				),
				React.createElement(
					'div',
					{ className: 'ddm-net-grid' },
					React.createElement(
						'div',
						{ className: 'ddm-net-col' },
						React.createElement('div', { className: 'ddm-net-label' }, `↓ ${t.down}`),
						React.createElement('div', { className: 'ddm-net-value ddm-down' }, formatRate(net.downBps)),
						React.createElement('div', { className: 'ddm-net-chart ddm-down' }, React.createElement(Spark, { values: downSeries, height: 22 })),
					),
					React.createElement(
						'div',
						{ className: 'ddm-net-col' },
						React.createElement('div', { className: 'ddm-net-label' }, `↑ ${t.up}`),
						React.createElement('div', { className: 'ddm-net-value ddm-up' }, formatRate(net.upBps)),
						React.createElement('div', { className: 'ddm-net-chart ddm-up' }, React.createElement(Spark, { values: upSeries, height: 22 })),
					),
				),
				React.createElement(
					'div',
					{ className: 'ddm-net-foot' },
					React.createElement('span', null, `${t.totalDown} `, React.createElement('b', null, formatBytes(net.rxBytesTotal))),
					React.createElement('span', null, `${t.totalUp} `, React.createElement('b', null, formatBytes(net.txBytesTotal))),
				),
			)

			// ── 进程排行 ─────────────────────────────────────
			const procCard = React.createElement(
				'section',
				{ className: 'ddm-card ddm-procs', style: { '--ddm-accent': ACCENT.procs } },
				React.createElement(
					'div',
					{ className: 'ddm-card-head' },
					React.createElement(Icon, { name: 'list' }),
					React.createElement('span', { className: 'ddm-card-name' }, t.procTitle),
					React.createElement('span', { className: 'ddm-card-sub' }, t.procTop),
				),
				React.createElement(ProcessTable, { processes: procs, totalBytes }),
			)

			return React.createElement(
				'div',
				{ className: 'ddm-panel' },
				head,
				React.createElement(
					'div',
					{ className: 'ddm-body' },
					React.createElement('div', { className: 'ddm-row1' }, cpuCard, gpuCard, memCard, diskCard),
					React.createElement('div', { className: 'ddm-row2' }, netCard, procCard),
				),
			)
		}
		//#endregion

		//#region 插件接线
		function installStyles() {
			const style = document.createElement('style')
			style.dataset.plugin = 'dsh-device-monitor'
			style.textContent = STYLES
			document.head.appendChild(style)
			return () => { style.remove() }
		}

		/** 只需要槽位服务：不注册 locale、不注册工具、不碰会话。 */
		exports.inject = ['slots']

		/** 把监控条挂到输入框下方的 composer dock 上（内置统计行 id 是 'stats'）。 */
		exports.apply = function apply(ctx) {
			ctx.effect(installStyles, 'dsh-device-monitor: styles')
			ctx.slots.inject('conversation.composer.dock', () =>
				ctx.slots.register(
					{
						name: 'conversation.composer.dock',
						id: 'device-monitor',
						order: 1,
					},
					DeviceMonitor,
				),
			)
		}
		//#endregion

		return module.exports
	},
})
