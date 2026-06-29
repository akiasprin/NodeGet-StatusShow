import { useMemo, useRef, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
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
  lossTimestamps,
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
          <LatencyBlock title="TCP Ping" rows={tcpData} type="tcp_ping" loading={latencyLoading} />
          <LatencyBlock title="Ping" rows={pingData} type="ping" loading={latencyLoading} />

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
}

const ms = (v: number) => `${v.toFixed(1)} ms`

function LatencyBlock({ title, rows, type, loading }: LatencyBlockProps) {
  const { data, series } = useMemo(() => buildLatencyChart(rows, type), [rows, type])
  const stats = useMemo(() => computeLatencyStats(rows, type), [rows, type])
  const [hidden, setHidden] = useState<Set<string>>(() => new Set())
  const empty = data.length === 0

  const visibleSeries = useMemo(() => series.filter(s => !hidden.has(s.name)), [series, hidden])
  const lossTs = useMemo(
    () => lossTimestamps(rows, type, visibleSeries.map(s => s.name)),
    [rows, type, visibleSeries],
  )

  const toggle = (name: string) =>
    setHidden(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })

  return (
    <Section title={`${title} · 近 24 小时`}>
      <div className="relative h-60">
        {empty && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
            {loading ? '加载中…' : `暂无 ${type} 数据`}
          </div>
        )}
        {!empty && (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 4, right: 4, left: -8, bottom: -4 }}>
              <defs>
                <filter id="latency-glow" x="-10%" y="-10%" width="120%" height="120%">
                  <feGaussianBlur in="SourceGraphic" stdDeviation="1.5" result="blur" />
                  <feMerge>
                    <feMergeNode in="blur" />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>
              </defs>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="hsl(var(--border))"
                strokeWidth={0.5}
                vertical={false}
              />
              <XAxis
                dataKey="t"
                type="number"
                domain={['dataMin', 'dataMax']}
                scale="time"
                tickFormatter={t => new Date(t).toLocaleTimeString()}
                tick={{ fontSize: 10, fill: '#888' }}
                axisLine={{ stroke: 'hsl(var(--border))', strokeWidth: 0.5 }}
                tickLine={false}
              />
              <YAxis
                tickFormatter={v => `${Math.round(v)}ms`}
                tick={{ fontSize: 10, fill: '#888' }}
                axisLine={false}
                tickLine={false}
                width={52}
                domain={['auto', 'auto']}
              />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                labelFormatter={t => new Date(Number(t)).toLocaleTimeString()}
                formatter={(v: number) => ms(Number(v))}
              />
              {lossTs.map(t => (
                <ReferenceLine
                  key={`loss-${t}`}
                  x={t}
                  stroke="hsl(var(--muted-foreground))"
                  strokeOpacity={0.35}
                  strokeWidth={1}
                />
              ))}
              {visibleSeries.map(s => (
                <Line
                  key={s.name}
                  type="monotone"
                  dataKey={s.name}
                  stroke={s.color}
                  strokeWidth={1}
                  dot={false}
                  connectNulls
                  isAnimationActive={false}
                  filter="url(#latency-glow)"
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
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
