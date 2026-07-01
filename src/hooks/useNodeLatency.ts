import { useEffect, useState } from 'react'
import { taskQuery, taskQueryHttp } from '../api/methods'
import type { BackendPool } from '../api/pool'
import type { TaskQueryResult } from '../types'

const WINDOW_MS = 24 * 60 * 60 * 1000
const REFRESH_MS = 10_000
const QUERY_TIMEOUT_MS = 20_000
const QUERY_LIMIT = 10_000

function clean(rows: TaskQueryResult[] | undefined): TaskQueryResult[] {
  return (rows ?? [])
    .filter(r => r.cron_source && r.cron_source !== '未知')
    .sort((a, b) => a.timestamp - b.timestamp)
}

const rowKey = (r: TaskQueryResult) => `${r.timestamp}|${r.cron_source}`

/** 按 (timestamp, cron_source) 去重合并增量，并裁掉超过 24h 窗口的旧点 */
function mergeRows(prev: TaskQueryResult[], incoming: TaskQueryResult[], now: number): TaskQueryResult[] {
  const cutoff = now - WINDOW_MS
  const map = new Map<string, TaskQueryResult>()
  for (const r of prev) {
    if (r.timestamp < cutoff) continue
    map.set(rowKey(r), r)
  }
  for (const r of incoming) map.set(rowKey(r), r)
  return [...map.values()].sort((a, b) => a.timestamp - b.timestamp)
}

export function useNodeLatency(
  pool: BackendPool | null,
  source: string | null,
  uuid: string | null,
) {
  const [pingData, setPingData] = useState<TaskQueryResult[]>([])
  const [tcpData, setTcpData] = useState<TaskQueryResult[]>([])
  // 初始即按是否有节点置位，避免首帧 loading=false 且数据为空时误显“暂无数据”
  const [loading, setLoading] = useState(() => !!(pool && source && uuid))

  // 切换节点时同步复位：渲染期间即清空旧数据并进入加载态，
  // 否则 effect 在渲染后才执行，切换瞬间会闪现上一节点的延迟曲线或“暂无数据”
  const [prev, setPrev] = useState<{
    pool: BackendPool | null
    source: string | null
    uuid: string | null
  }>({ pool: null, source: null, uuid: null })
  if (prev.pool !== pool || prev.source !== source || prev.uuid !== uuid) {
    setPrev({ pool, source, uuid })
    setPingData([])
    setTcpData([])
    setLoading(!!(pool && source && uuid))
  }

  useEffect(() => {
    if (!pool || !source || !uuid) return
    const entry = pool.entries.find(e => e.name === source)
    if (!entry) return

    let cancelled = false
    const lastSeen = { ping: null as number | null, tcp: null as number | null }

    /** HTTP 全量拉取 24h — 浏览器自动 gzip，重新对齐 lastSeen */
    const fullFetch = async () => {
      const now = Date.now()
      const window: [number, number] = [now - WINDOW_MS, now]
      setLoading(true)

      const [ping, tcp] = await Promise.allSettled([
        taskQueryHttp(
          entry.client.url,
          entry.client.token,
          [{ uuid }, { timestamp_from_to: window }, { type: 'ping' }, { limit: QUERY_LIMIT }],
          QUERY_TIMEOUT_MS,
        ),
        taskQueryHttp(
          entry.client.url,
          entry.client.token,
          [{ uuid }, { timestamp_from_to: window }, { type: 'tcp_ping' }, { limit: QUERY_LIMIT }],
          QUERY_TIMEOUT_MS,
        ),
      ])

      if (cancelled) return
      const t = Date.now()
      if (ping.status === 'fulfilled') {
        const rows = clean(ping.value)
        setPingData(rows)
        lastSeen.ping = rows.length ? rows[rows.length - 1].timestamp : t
      }
      if (tcp.status === 'fulfilled') {
        const rows = clean(tcp.value)
        setTcpData(rows)
        lastSeen.tcp = rows.length ? rows[rows.length - 1].timestamp : t
      }
      setLoading(false)
    }

    /** WS 增量拉取 [lastSeen, now] — 几 KB，merge 进已有数据 */
    const incrFetch = async () => {
      const now = Date.now()
      if (lastSeen.ping == null && lastSeen.tcp == null) {
        await fullFetch()
        return
      }

      const pingFrom = lastSeen.ping ?? now - WINDOW_MS
      const tcpFrom = lastSeen.tcp ?? now - WINDOW_MS

      const [ping, tcp] = await Promise.allSettled([
        taskQuery(
          entry.client,
          [{ uuid }, { timestamp_from_to: [pingFrom, now] }, { type: 'ping' }],
          QUERY_TIMEOUT_MS,
        ),
        taskQuery(
          entry.client,
          [{ uuid }, { timestamp_from_to: [tcpFrom, now] }, { type: 'tcp_ping' }],
          QUERY_TIMEOUT_MS,
        ),
      ])

      if (cancelled) return
      // 任一增量失败（断连/超时）→ 回退一次全量重新对齐
      if (ping.status === 'rejected' || tcp.status === 'rejected') {
        await fullFetch()
        return
      }

      const incPing = clean(ping.value)
      const incTcp = clean(tcp.value)
      setPingData(prev => mergeRows(prev, incPing, now))
      setTcpData(prev => mergeRows(prev, incTcp, now))

      const maxPing = incPing.length ? Math.max(...incPing.map(r => r.timestamp)) : pingFrom
      const maxTcp = incTcp.length ? Math.max(...incTcp.map(r => r.timestamp)) : tcpFrom
      if (maxPing > (lastSeen.ping ?? 0)) lastSeen.ping = maxPing
      if (maxTcp > (lastSeen.tcp ?? 0)) lastSeen.tcp = maxTcp
    }

    fullFetch()
    const timer = setInterval(incrFetch, REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [pool, source, uuid])

  return { pingData, tcpData, loading }
}
