export interface TrafficState {
  usedRx: number
  usedTx: number
}

/**
 * 根据 live data 和 KV baseline 计算周期已用流量。
 * 前端直接做减法，Worker 负责维护 baseline 的正确性。
 */
export function computePeriodUsage(
  liveTotalRx: number,
  liveTotalTx: number,
  baselineRx: number,
  baselineTx: number,
  adjustmentRx: number,
  adjustmentTx: number,
): TrafficState {
  const deltaRx = Math.max(0, liveTotalRx - baselineRx)
  const deltaTx = Math.max(0, liveTotalTx - baselineTx)
  return {
    usedRx: adjustmentRx + deltaRx,
    usedTx: adjustmentTx + deltaTx,
  }
}

/** 字节转 GB */
export function bytesToGB(bytes: number): number {
  return bytes / (1024 * 1024 * 1024)
}

/** GB 转字节 */
export function gbToBytes(gb: number): number {
  return gb * 1024 * 1024 * 1024
}

/** 总流量（上下行合计）GB */
export function totalGB(used: TrafficState): number {
  return bytesToGB(used.usedRx + used.usedTx)
}

/** 解析计费周期字符串，返回 {数量, 单位}，默认月周期 */
function parsePeriod(period?: string): { n: number; unit: 'd' | 'm' | 'y' } {
  if (!period) return { n: 1, unit: 'm' }
  const m = period.match(/^(\d+)([dmy])$/i)
  if (!m) return { n: 1, unit: 'm' }
  const n = parseInt(m[1], 10)
  if (!Number.isFinite(n) || n <= 0) return { n: 1, unit: 'm' }
  return { n, unit: m[2].toLowerCase() as 'd' | 'm' | 'y' }
}

/**
 * 安全地给日期加上 N 个月（UTC），防止月末溢出。
 * 与 Worker 端 addMonths 逻辑一致：如果月份加法导致日期溢出（如 1月31日 +1月），回退到当月最后一天。
 */
function addMonths(d: Date, n: number): Date {
  const before = d.getUTCDate()
  d.setUTCMonth(d.getUTCMonth() + n)
  if (d.getUTCDate() !== before) d.setUTCDate(0)
  return d
}

/** 距流量重置的天数 */
export function daysUntilReset(trafficStartDate: string, trafficPeriod?: string): number | null {
  if (!trafficStartDate) return null

  // new Date("YYYY-MM-DD") 按 ES 规范解析为 UTC 午夜，无需拼接 "T00:00:00Z"
  const start = new Date(trafficStartDate)
  if (isNaN(start.getTime())) return null

  const nowMs = Date.now()
  const { n, unit } = parsePeriod(trafficPeriod)

  // 找下一个重置时刻：从起始日期出发，每隔 n * unit 推进，直到超过 now
  // 全程使用 UTC 方法，避免本地时区干扰月份/日期边界
  const next = new Date(start)
  let i = 0
  while (next.getTime() <= nowMs && i < 1200) {
    if (unit === 'd') {
      next.setUTCDate(next.getUTCDate() + n)
    } else if (unit === 'm') {
      addMonths(next, n)
    } else {
      addMonths(next, n * 12) // 年 = 月 × 12，复用月加法保护闰年溢出
    }
    i++
  }

  const diffMs = next.getTime() - nowMs
  const days = diffMs / (1000 * 60 * 60 * 24)
  if (days < 1) return 0
  return Math.ceil(days)
}

/** 超额流量 GB */
export function overLimitGB(usedGB: number, limitGB: number): number {
  return Math.max(0, usedGB - limitGB)
}

/** 超额费用 */
export function trafficCost(overGB: number, pricePerGB: number): number {
  return overGB * pricePerGB
}
