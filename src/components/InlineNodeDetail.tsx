import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import * as echarts from 'echarts'
import {
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Card } from './ui/card'
import { bytes, pct, relativeAge, uptime } from '../utils/format'
import { deriveUsage, distroLogo, osLabel, virtLabel } from '../utils/derive'
import { cycleProgress, hasCost, remainingDays, remainingValue } from '../utils/cost'

import { cn } from '../utils/cn'
import {
  buildLatencyChart,
  computeLatencyStats,
  latencyColorsUnified,
  lossTimestamps,
  type ChartPoint,
  type ChartSeries,
  type LatencyStats,
} from '../utils/latency'
import { useNodeLatency } from '../hooks/useNodeLatency'
import type { BackendPool } from '../api/pool'
import type { HistorySample, LatencyType, Node, NodeMeta, TaskQueryResult } from '../types'

const TOOLTIP_STYLE = {
  background: 'hsl(var(--popover))',
  border: '1px solid hsl(var(--border))',
  borderRadius: 6,
  fontSize: 11,
}

interface Props {
  node: Node
  onClose: () => void
  showSource?: boolean
  pool: BackendPool
  variant?: 'card' | 'table'
}

export function InlineNodeDetail({ node, onClose, showSource, pool, variant = 'card' }: Props) {
  const { pingData, tcpData, loading: latencyLoading } = useNodeLatency(
    pool,
    node.source,
    node.uuid,
  )
  // TCP Ping 与 Ping 共用一套配色（以 TCP Ping 为标准，1 对 1 匹配的 Ping 复制 TCP 颜色）
  const latencyColors = useMemo(() => latencyColorsUnified(pingData, tcpData), [pingData, tcpData])

  const u = deriveUsage(node)
  const d = node.dynamic
  const s = node.static?.system
  const cpu = node.static?.cpu
  const virt = virtLabel(node)
  const history = node.history || []
  const rootRef = useRef<HTMLDivElement>(null)

  return (
    <div ref={rootRef} className={cn('col-span-full animate-in fade-in slide-in-from-top-2 duration-200', !node.online && 'opacity-60')}>
      <Card className={variant === 'table' ? 'p-5 rounded-none border-0 shadow-none [background:hsl(var(--card))]' : 'p-5 ring-2 ring-primary border-primary shadow-lg shadow-[0_0_30px_-4px_hsl(var(--primary)/0.65),0_0_60px_0_hsl(var(--primary)/0.28),0_0_100px_8px_hsl(var(--primary)/0.10)] [background:hsl(var(--card))]'}>
        {variant !== 'table' && (
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-sm">
                {node.meta?.name || node.uuid} 详情
              </span>
              {node.meta?.region && (
                <span className="text-xs text-muted-foreground">{node.meta.region}</span>
              )}
            </div>
            <button
              onClick={onClose}
              className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        <div className="space-y-6">
          {/* Sparklines — 2 分钟趋势 */}
          {(() => {
            const span = history.length > 1 ? Math.round((history[history.length - 1].t - history[0].t) / 1000) : 0
            return (
            <Section title={history.length > 1 ? `近 ${span} 秒趋势` : history.length === 1 ? '实时' : '趋势'}>
              <div className="overflow-hidden"><div className="flex flex-wrap divide-x divide-y divide-dashed divide-border -m-[1px]">
                <Spark data={history} dataKey="cpu" label="CPU %" stroke="#3b82f6" domain={[0, 100]} format={pct} />
                <Spark data={history} dataKey="mem" label="内存 %" stroke="#34d399" domain={[0, 100]} format={pct} />
                <Spark data={history} dataKey="netIn" label="下行" stroke="#8b5cf6" domain={[0, 'auto']} format={v => `${bytes(v)}/s`} />
                <Spark data={history} dataKey="netOut" label="上行" stroke="#f59e0b" domain={[0, 'auto']} format={v => `${bytes(v)}/s`} />
              </div></div>
            </Section>
            )
          })()}

          {/* 延迟图表 */}
          <LatencyBlock title="TCP Ping" rows={tcpData} type="tcp_ping" loading={latencyLoading} colors={latencyColors} />
          <LatencyBlock title="Ping" rows={pingData} type="ping" loading={latencyLoading} colors={latencyColors} />

          {/* 系统信息 */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            <Section title="系统">
              <InfoTable>
                <KV k="主机名" v={s?.system_host_name} />
                <KV k="操作系统" v={osLabel(node)} />
                <KV k="内核" v={s?.system_kernel || s?.system_kernel_version} />
                <KV k="CPU 架构" v={s?.arch || s?.cpu_arch} />
                <KV k="虚拟化" v={virt} />
                <KV k="CPU 型号" v={cpu?.brand || cpu?.per_core?.[0]?.brand} />
                <KV
                  k="核心"
                  v={
                    cpu?.physical_cores != null
                      ? `${cpu.physical_cores} 物理 / ${cpu.logical_cores} 逻辑`
                      : cpu?.per_core?.length
                        ? `${cpu.per_core.length} 核`
                        : null
                  }
                />
              </InfoTable>
            </Section>

            <Section title="网络与负载">
              <InfoTable>
                <KV k="累计接收" v={d?.total_received != null ? bytes(d.total_received) : null} />
                <KV k="累计发送" v={d?.total_transmitted != null ? bytes(d.total_transmitted) : null} />
                <KV k="磁盘读" v={d?.read_speed != null ? `${bytes(d.read_speed)}/s` : null} />
                <KV k="磁盘写" v={d?.write_speed != null ? `${bytes(d.write_speed)}/s` : null} />
                <KV k="进程数" v={d?.process_count} />
                <KV
                  k="TCP / UDP"
                  v={
                    d?.tcp_connections != null || d?.udp_connections != null
                      ? `${d?.tcp_connections ?? '—'} / ${d?.udp_connections ?? '—'}`
                      : null
                  }
                />
                <KV k="运行时长" v={uptime(d?.uptime)} />
                <KV k="数据更新" v={relativeAge(d?.timestamp)} />
              </InfoTable>
            </Section>

            {hasCost(node.meta) && <CostSection meta={node.meta} />}
          </div>
        </div>
      </Card>
    </div>
  )
}

/* ─── Reusable sub-components ─── */

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground/70 mb-2 font-medium">{title}</div>
      {children}
    </div>
  )
}

function KV({ k, v }: { k: string; v: ReactNode }) {
  if (v == null || v === '') return null
  return (
    <tr className="border-b border-border/40 last:border-b-0">
      <td className="py-1.5 pr-3 text-xs text-muted-foreground whitespace-nowrap">{k}</td>
      <td className="py-1.5 text-xs font-mono text-right truncate max-w-[200px]">{v}</td>
    </tr>
  )
}

function InfoTable({ children }: { children: ReactNode }) {
  return (
    <table className="w-full">
      <tbody>{children}</tbody>
    </table>
  )
}

interface SparkProps {
  data: HistorySample[]
  dataKey: keyof HistorySample
  label: string
  stroke: string
  domain?: [number | string, number | string]
  format: (v: number) => string
}

function Spark({ data, dataKey, label, stroke, domain, format }: SparkProps) {
  const last = Number(data.at(-1)?.[dataKey] ?? 0)
  const lineProps = {
    type: 'monotone' as const,
    dataKey,
    dot: false,
    connectNulls: true,
    isAnimationActive: false,
  }
  return (
    <div className="basis-1/2 sm:basis-1/4 p-3">
      <div className="flex justify-between text-[11px] mb-1">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono">{format(last)}</span>
      </div>
      <div className="h-20">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
            <XAxis dataKey="t" hide />
            <YAxis hide domain={domain ?? ['auto', 'auto']} />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              labelFormatter={t => new Date(t).toLocaleTimeString()}
              formatter={(v: number) => [format(v), label]}
            />
            <Line
              {...lineProps}
              stroke={stroke}
              strokeWidth={5}
              strokeOpacity={0.18}
              strokeLinecap="round"
              strokeLinejoin="round"
              tooltipType="none"
            />
            <Line
              {...lineProps}
              stroke={stroke}
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

/* ─── Latency ─── */

interface LatencyBlockProps {
  title: string
  rows: TaskQueryResult[]
  type: LatencyType
  loading: boolean
  colors: Map<string, string>
}

const ms = (v: number) => `${v.toFixed(1)} ms`

/** 通过 getComputedStyle 读取的 shadcn 颜色变量，已包成 Canvas 可解析的 hsl() 字符串 */
interface ChartColors {
  border: string
  popover: string
  mutedFg: string
  foreground: string
  /** 丢包条纹不透明度：暗背景下浅灰条纹更显眼，暗模式调低以收敛视觉 */
  lossOpacity: number
}

/** 当前是否暗模式（shadcn 用 documentElement 的 .dark 类切换） */
const isDarkMode = (): boolean => document.documentElement.classList.contains('dark')

/** 读取 shadcn CSS 变量（原始 HSL 数值，如 "220 18% 88%"）并包成 hsl(r, g%, b%) */
function resolveHslVar(name: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  const parts = raw.split(/\s+/)
  if (parts.length >= 3) return `hsl(${parts[0]}, ${parts[1]}, ${parts[2]})`
  return 'hsl(0, 0%, 50%)'
}

const toLatencyPoint = (pt: ChartPoint, name: string): [number, number | null] => [
  pt.t,
  pt[name] == null ? null : pt[name],
]

/** 相邻丢包间隔阈值：≤此值视为连续丢包段，合并成区间带，避免半透明竖线在同一像素列叠加出“光影” */
const LOSS_MERGE_GAP_MS = 30_000

/** 把丢包时间戳合并为区间：连续丢包（间隔 ≤ 阈值）合成 [start,end] 段，离散单点为 [t,t] */
function mergeLossRanges(ts: number[]): Array<[number, number]> {
  if (!ts.length) return []
  const ranges: Array<[number, number]> = []
  let start = ts[0]
  let end = ts[0]
  for (let i = 1; i < ts.length; i++) {
    if (ts[i] - end <= LOSS_MERGE_GAP_MS) end = ts[i]
    else {
      ranges.push([start, end])
      start = ts[i]
      end = ts[i]
    }
  }
  ranges.push([start, end])
  return ranges
}

/** 构建 echarts 配置：复刻 recharts 的网格 / 轴 / tooltip / 丢包竖线 / 发光折线 */
function buildLatencyOption(
  data: ChartPoint[],
  series: ChartSeries[],
  lossTs: number[],
  vars: ChartColors,
): echarts.EChartsOption {
  if (!data.length) return { animation: false }

  const dataMin = data[0].t
  const dataMax = data[data.length - 1].t

  // Y 轴取数据极值（对应 recharts domain=['auto','auto']），并显式锁定区间，
  // 这样丢包竖线用 [yMin,yMax] 作端点即可贯穿整图高度（等价 recharts ReferenceLine）。
  let yMin = Infinity
  let yMax = -Infinity
  for (const pt of data) {
    for (const s of series) {
      const v = pt[s.name]
      if (v == null) continue
      if (v < yMin) yMin = v
      if (v > yMax) yMax = v
    }
  }
  if (!isFinite(yMin) || !isFinite(yMax)) {
    yMin = 0
    yMax = 1
  } else if (yMax - yMin < 1) {
    // 平直数据给一点呼吸空间，避免轴线压成一条
    yMin -= 1
    yMax += 1
  }

  // 丢包：连续段合并成 markArea 带（单次绘制、半透明均匀，不叠加），
  // 离散单点保留 markLine 竖线（孤立不叠加）。两者颜色一致，视觉统一。
  const lossRanges = lossTs.length ? mergeLossRanges(lossTs) : []
  const lossPoints = lossRanges.filter(r => r[0] === r[1]).map(r => r[0])
  const lossSegments = lossRanges.filter(r => r[0] !== r[1])

  const seriesOpts: echarts.LineSeriesOption[] = series.map((s, idx) => ({
    name: s.name,
    type: 'line',
    // 顶层 color 供 tooltip/legend 取色，保证与线条颜色一致
    color: s.color,
    itemStyle: { color: s.color },
    showSymbol: false,
    connectNulls: true,
    smooth: false,
    // 近似 recharts 的 feGaussianBlur(stdDeviation=1.5)+feMerge 发光，强度减弱
    lineStyle: { width: 1, color: s.color, shadowBlur: 2, shadowColor: s.color },
    data: data.map(pt => toLatencyPoint(pt, s.name)),
    markLine:
      idx === 0 && lossPoints.length > 0
        ? {
            symbol: 'none',
            silent: true,
            label: { show: false },
            lineStyle: { color: vars.mutedFg, opacity: vars.lossOpacity, width: 1, type: 'solid' },
            data: lossPoints.map(t => [{ coord: [t, yMin] }, { coord: [t, yMax] }]),
          }
        : undefined,
    markArea:
      idx === 0 && lossSegments.length > 0
        ? {
            silent: true,
            label: { show: false },
            itemStyle: { color: vars.mutedFg, opacity: vars.lossOpacity },
            data: lossSegments.map(r => [{ coord: [r[0], yMin] }, { coord: [r[1], yMax] }]),
          }
        : undefined,
  }))

  return {
    animation: false,
    grid: { top: 4, right: 4, bottom: 26, left: 44 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: vars.popover,
      borderColor: vars.border,
      borderWidth: 1,
      borderRadius: 6,
      padding: 10,
      textStyle: { fontSize: 11, color: vars.foreground },
      // 光标竖线，对应 recharts 默认 cursor '#ccc'
      axisPointer: { type: 'line', lineStyle: { color: '#ccc', width: 1 }, label: { show: false } },
      // 复刻 recharts DefaultTooltipContent 的 DOM 结构与样式
      formatter: params => {
        const arr = Array.isArray(params) ? params : [params]
        if (!arr.length) return ''
        const firstVal = arr[0].value
        const tRaw = Array.isArray(firstVal) ? firstVal[0] : null
        const t = typeof tRaw === 'number' ? tRaw : 0
        let html = `<p style="margin:0">${new Date(t).toLocaleTimeString()}</p>`
        html += '<ul style="padding:0;margin:0;list-style:none">'
        for (const p of arr) {
          const raw = p.value
          const v = Array.isArray(raw) ? raw[1] : null
          const valStr = typeof v === 'number' ? `${v.toFixed(1)} ms` : '—'
          html += `<li style="display:block;padding-top:4px;padding-bottom:4px;color:${p.color}">`
          html += `<span>${p.seriesName}</span><span> : </span><span>${valStr}</span>`
          html += '</li>'
        }
        html += '</ul>'
        return html
      },
    },
    xAxis: {
      type: 'time',
      min: dataMin,
      max: dataMax,
      axisLine: { lineStyle: { color: vars.border, width: 0.5 } },
      axisTick: { show: false },
      axisLabel: {
        fontSize: 10,
        color: '#888',
        hideOverlap: true,
        formatter: value => new Date(value).toLocaleTimeString(),
      },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      min: yMin,
      max: yMax,
      splitNumber: 5,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        fontSize: 10,
        color: '#888',
        formatter: value => `${Math.round(value)}ms`,
      },
      // 不画水平网格线
      splitLine: { show: false },
    },
    series: seriesOpts,
  }
}

function LatencyBlock({ title, rows, type, loading, colors }: LatencyBlockProps) {
  const { data, series } = useMemo(() => buildLatencyChart(rows, type, colors), [rows, type, colors])
  const stats = useMemo(() => computeLatencyStats(rows, type, colors), [rows, type, colors])
  const [hidden, setHidden] = useState<Set<string>>(() => new Set())
  const [themeTick, setThemeTick] = useState(0)
  const empty = data.length === 0

  const visibleSeries = useMemo(() => series.filter(s => !hidden.has(s.name)), [series, hidden])
  const lossTs = useMemo(
    () => lossTimestamps(rows, type, visibleSeries.map(s => s.name)),
    [rows, type, visibleSeries],
  )

  const hostRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)

  const toggle = (name: string) =>
    setHidden(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })

  // 数据清空（切换节点 / 重载）时复位：清掉上一节点残留的隐藏态，并允许重新套用默认隐藏
  // 丢包率 100% 的来源默认隐藏——它们 24h 全部缺失，画出来只会贡献海量丢包竖线且无有效曲线
  const defaultsApplied = useRef(false)
  useEffect(() => {
    if (!stats.length) {
      defaultsApplied.current = false
      setHidden(prev => (prev.size ? new Set() : prev))
      return
    }
    if (defaultsApplied.current) return
    defaultsApplied.current = true
    const fullLoss = stats.filter(s => s.lossRate >= 100).map(s => s.name)
    if (fullLoss.length) {
      setHidden(prev => {
        const next = new Set(prev)
        for (const name of fullLoss) next.add(name)
        return next
      })
    }
  }, [stats])

  // 初始化 echarts 实例 + 自适应 + 卸载清理
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const chart = echarts.init(host)
    chartRef.current = chart
    const ro = new ResizeObserver(() => chart.resize())
    ro.observe(host)
    return () => {
      ro.disconnect()
      chart.dispose()
      chartRef.current = null
    }
  }, [])

  // 亮/暗主题切换时重读 CSS 变量并重绘
  useEffect(() => {
    const mo = new MutationObserver(() => setThemeTick(v => v + 1))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => mo.disconnect()
  }, [])

  // 数据 / 可见序列 / 主题变化时刷新图表
  useEffect(() => {
    const chart = chartRef.current
    if (!chart || empty) return
    const vars: ChartColors = {
      border: resolveHslVar('--border'),
      popover: resolveHslVar('--popover'),
      mutedFg: resolveHslVar('--muted-foreground'),
      foreground: resolveHslVar('--foreground'),
      // 暗模式下 muted-foreground 是浅灰，半透明叠在深底上偏显眼，降低不透明度
      lossOpacity: isDarkMode() ? 0.18 : 0.35,
    }
    chart.setOption(buildLatencyOption(data, visibleSeries, lossTs, vars), true)
  }, [data, visibleSeries, lossTs, empty, themeTick])

  return (
    <Section title={`${title} · 近 24 小时`}>
      <div className="relative h-60">
        {/* 宿主常驻：echarts 实例在挂载时初始化一次，若按 empty 条件挂载会导致数据到达时仍空白 */}
        <div ref={hostRef} className={cn('h-full w-full', empty && 'opacity-0')} />
        {empty && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
            {loading ? '加载中…' : `暂无 ${type} 数据`}
          </div>
        )}
        {!empty && loading && (
          <div className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
        )}
      </div>

      {stats.length > 0 && (
        <div className="mt-3 border-t pt-3">
          <div className="flex items-center px-2 pb-1 text-[11px] text-muted-foreground">
            <span className="flex-1">来源</span>
            <span className="w-20 text-right">平均延迟</span>
            <span className="w-16 text-right">抖动</span>
            <span className="w-14 text-right">丢包率</span>
          </div>
          <div className="space-y-0.5">
            {stats.map(s => (
              <LatencyStatsRow
                key={s.name}
                stat={s}
                hidden={hidden.has(s.name)}
                onToggle={() => toggle(s.name)}
              />
            ))}
          </div>
        </div>
      )}
    </Section>
  )
}

function LatencyStatsRow({
  stat,
  hidden,
  onToggle,
}: {
  stat: LatencyStats
  hidden: boolean
  onToggle: () => void
}) {
  const { name, color, avg, jitter, lossRate } = stat

  return (
    <div
      onClick={onToggle}
      className={cn(
        'flex items-center px-2 py-1 rounded-md text-xs cursor-pointer select-none transition-opacity hover:bg-muted/60',
        hidden && 'opacity-35',
      )}
    >
      <span className="flex items-center gap-2 flex-1 min-w-0">
        <span
          className="inline-block w-4 h-0.5 rounded-full shrink-0"
          style={{ background: color }}
        />
        <span className="truncate">{name}</span>
      </span>
      <span className="w-20 text-right tabular-nums font-mono">
        {avg != null ? ms(avg) : '—'}
      </span>
      <span className="w-16 text-right tabular-nums font-mono">
        {jitter != null ? ms(jitter) : '—'}
      </span>
      <span
        className={cn(
          'w-14 text-right tabular-nums font-mono',
          lossRate >= 5 && 'text-red-500 font-medium',
        )}
      >
        {lossRate.toFixed(1)}%
      </span>
    </div>
  )
}

/* ─── Cost ─── */

function CostSection({ meta }: { meta: NodeMeta }) {
  const days = remainingDays(meta.expireTime)
  const value = remainingValue(meta)
  const progress = cycleProgress(meta)
  const unit = meta.priceUnit || '$'

  let daysLabel: string
  let daysClass = ''
  if (days == null) daysLabel = '未设置'
  else if (days < 0) {
    daysLabel = `已过期 ${Math.abs(days)} 天`
    daysClass = 'text-red-500'
  } else if (days <= 7) {
    daysLabel = `${days} 天`
    daysClass = 'text-red-500'
  } else if (days <= 30) {
    daysLabel = `${days} 天`
    daysClass = 'text-orange-500'
  } else {
    daysLabel = `${days} 天`
  }

  const barColor =
    days == null || days < 0
      ? 'bg-muted-foreground/40'
      : days <= 7
        ? 'bg-red-500'
        : days <= 30
          ? 'bg-orange-500'
          : 'bg-emerald-500'

  return (
    <Section title="费用">
      <InfoTable>
        <KV k="月费" v={meta.price > 0 ? `${unit}${meta.price} / ${meta.priceCycle} 天` : null} />
        <KV k="到期" v={meta.expireTime || null} />
      <KV k="剩余" v={<span className={daysClass}>{daysLabel}</span>} />
      <KV k="剩余价值" v={meta.price > 0 ? `${unit}${value.toFixed(2)}` : null} />
      </InfoTable>

      {meta.expireTime && days != null && (
        <div className="mt-3 h-1.5 w-full rounded-full bg-muted overflow-hidden">
          <div
            className={cn('h-full rounded-full transition-all', barColor)}
            style={{ width: `${progress}%` }}
          />
        </div>
      )}
    </Section>
  )
}
