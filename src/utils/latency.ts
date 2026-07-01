import type { LatencyType, TaskQueryResult } from '../types'

function normalizeTs(ts: number) {
  return ts < 1_000_000_000_000 ? ts * 1000 : ts
}

function pickValue(row: TaskQueryResult, type: LatencyType): number | null {
  const v = row.task_event_result?.[type]
  return row.success && typeof v === 'number' ? v : null
}

function seriesNames(rows: TaskQueryResult[]) {
  const set = new Set<string>()
  for (const r of rows) set.add(r.cron_source || '未知')
  return [...set].sort((a, b) => a.localeCompare(b))
}

export interface ChartPoint {
  t: number
  [series: string]: number | null
}

export interface ChartSeries {
  name: string
  color: string
}

function forwardFill(data: ChartPoint[], names: string[]) {
  const last: Record<string, number | null> = {}
  for (const n of names) last[n] = null
  for (const pt of data) {
    for (const n of names) {
      const v = pt[n]
      if (v == null) pt[n] = last[n]
      else last[n] = v
    }
  }
}

/* ─── 聚类配色（跨类型统一） ───
 * 按来源间延迟时序的相关性聚类：延迟涨跌高度同步（皮尔逊 ≥ SIM_THRESHOLD）的来源归同簇。
 * 这是不依赖名字（如 CT/CM/CU 运营商标签）判断"同类"的数据 ground truth ——
 * 真正同路由/同性质的来源延迟曲线会同步；不同步则视为不同类，即使延迟量级接近也分开。
 * 用并查集传递合并：A~B、B~C 同类 → A/B/C 同簇。簇按平均延迟排序映射红→紫→蓝。
 *
 * 跨类型统一：TCP Ping 与 Ping 共用一套配色，以 TCP Ping 为标准。
 *   - TCP Ping 来源先聚类（含强制拆分），得到簇与色相；
 *   - Ping 来源按"去前缀后缀"与 TCP Ping 做 1 对 1 匹配（命名策略保证同后缀=同目标，
 *     名字本身不作内容相关性的 ground truth，仅作 1 对 1 配对的标识），
 *     匹配上的 Ping 来源直接复制其 TCP Ping 配对的完整颜色（色相/饱和/明度完全一致）；
 *   - 未匹配的 Ping 来源独立聚类，接在 TCP 簇之后取色。
 *
 * 强制拆分：若某次聚类只得到 1 个簇（且来源数 >1），强制每个来源自成独立簇 ——
 * 避免"所有来源同色"导致无法区分。簇按平均延迟升序取色，低延迟暖、高延迟冷。
 * 确定性、纯 JS、来源数小所以很快；增量刷新下相关性稳定 → 颜色不抖。
 * 不同簇（即便都低延迟）色相浮点插值拉开，互不撞色；明度全统一，仅靠色相区分簇与成员。
 */

/** 两来源延迟皮尔逊相关性 ≥ 此值才视为"涨跌同步"（相对相似度判据） */
const SIM_THRESHOLD = 0.8

/** 两来源中位延迟绝对差 ≥ 此值（ms）则分簇，即使高度相关也分开（绝对量级判据） */
const ABS_LATENCY_GAP_MS = 50

/**
 * 色相轴分两段，跳过发土暗淡的橄榄/黄绿缝(~90°-170°)：
 *   暖段 [350°→50°]（红→金，跨 0°，跨度 60°）：低延迟簇在此取色
 *   冷段 [180°→280°]（青→紫，跨度 100°）：高延迟簇在此取色
 * 虚拟轴 [0,1] 前 WARM_FRACTION 走暖段、其余走冷段，按段长配比（暖窄故占 1/3）。
 * 相比固定锚点线性插值更均匀：原方案暖端 4 锚点挤在 56°，k=4/5 时低延迟簇全挤红橙、
 * 且 50°→272° 跨 222° 出现"几个红 + 突兀紫"。两段均匀后相邻簇色相间距稳定 ~25°-50°。
 * 跨缝落在段边界而非缝内，自然不插值出橄榄色，无需吸附特判。
 */
const WARM_HUE_START = 350
const WARM_HUE_END = 50
const WARM_SPAN = 60
const COOL_HUE_START = 180
const COOL_HUE_END = 280
const COOL_SPAN = COOL_HUE_END - COOL_HUE_START
const WARM_FRACTION = 1 / 3

// Grafana 暗色仪表盘风：中饱和、偏亮但不刺眼，在深底上清晰且不荧光
const PALETTE_SAT = 55
const PALETTE_LIGHT = 52

/** 簇内成员色相浮动幅度（度）：同簇色相相近但可分辨。明度全统一，仅靠色相区分成员 */
const CLUSTER_HUE_SPREAD = 8

function median(values: number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** 两序列在公共非空点上的皮尔逊相关性，衡量延迟涨跌是否同步 */
function correlation(a: (number | null)[], b: (number | null)[], len: number): number {
  const pairs: Array<[number, number]> = []
  for (let i = 0; i < len; i++) {
    const x = a[i], y = b[i]
    if (x != null && y != null) pairs.push([x, y])
  }
  if (pairs.length < 5) return 0
  const ma = pairs.reduce((s, p) => s + p[0], 0) / pairs.length
  const mb = pairs.reduce((s, p) => s + p[1], 0) / pairs.length
  let cov = 0, va = 0, vb = 0
  for (const [x, y] of pairs) {
    cov += (x - ma) * (y - mb)
    va += (x - ma) ** 2
    vb += (y - mb) ** 2
  }
  if (va === 0 || vb === 0) return 0
  return cov / Math.sqrt(va * vb)
}

/**
 * 为 k 个簇各取一个色相：在两段色相轴上均匀取点，暖(低延迟/红)→冷(高延迟/紫)单调排布。
 * k=2~8 相邻簇色相间距稳定，不会出现"前几个全红、突然一个紫"的断层。
 */
function clusterHues(k: number): number[] {
  if (k <= 0) return []
  if (k === 1) return [WARM_HUE_START]
  const out: number[] = []
  for (let i = 0; i < k; i++) {
    const t = i / (k - 1)
    out.push(
      t < WARM_FRACTION
        ? (WARM_HUE_START + WARM_SPAN * (t / WARM_FRACTION)) % 360
        : COOL_HUE_START + COOL_SPAN * ((t - WARM_FRACTION) / (1 - WARM_FRACTION)),
    )
  }
  return out
}

/** 并查集：用于按相关性传递合并来源到同簇 */
class UnionFind {
  private parent: Map<string, string>
  constructor(names: string[]) {
    this.parent = new Map(names.map(n => [n, n]))
  }
  find(x: string): string {
    let root = x
    while (this.parent.get(root) !== root) root = this.parent.get(root)!
    // 路径压缩
    let cur = x
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur)!
      this.parent.set(cur, root)
      cur = next
    }
    return root
  }
  union(a: string, b: string): void {
    const ra = this.find(a), rb = this.find(b)
    if (ra !== rb) this.parent.set(ra, rb)
  }
}

/**
 * 按来源间延迟聚类，返回 簇编号（0 起，按簇平均延迟升序）。
 * 两来源归同簇需同时满足：时序相关性 ≥ SIM_THRESHOLD（涨跌同步）
 * 且中位延迟绝对差 < ABS_LATENCY_GAP_MS（量级相近）。用并查集传递合并。
 */
function clusterByCorrelation(
  names: string[],
  series: Map<string, (number | null)[]>,
  tsCount: number,
  nameToMedian: Map<string, number>,
): Map<string, number> {
  const out = new Map<string, number>()
  if (names.length === 0) return out
  const uf = new UnionFind(names)
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = series.get(names[i])!
      const b = series.get(names[j])!
      const medA = nameToMedian.get(names[i]) ?? Infinity
      const medB = nameToMedian.get(names[j]) ?? Infinity
      // 同簇需同时满足：延迟涨跌高度同步 且 绝对延迟差 < ABS_LATENCY_GAP_MS。
      // 既看相对相似度（相关性），也看绝对量级（延迟差），避免把同步但延迟差悬殊的来源合并。
      if (
        correlation(a, b, tsCount) >= SIM_THRESHOLD &&
        Math.abs(medA - medB) < ABS_LATENCY_GAP_MS
      ) {
        uf.union(names[i], names[j])
      }
    }
  }
  // 收集每个簇的根 → 成员
  const rootToMembers = new Map<string, string[]>()
  for (const name of names) {
    const root = uf.find(name)
    const arr = rootToMembers.get(root) ?? []
    arr.push(name)
    rootToMembers.set(root, arr)
  }
  // 簇按平均中位延迟升序编号（低延迟=红端、高延迟=蓝端）
  const clusters = [...rootToMembers.values()].map(members => {
    const avg = members.reduce((s, n) => s + (nameToMedian.get(n) ?? Infinity), 0) / members.length
    return { members, avg }
  }).sort((a, b) => a.avg - b.avg)
  clusters.forEach((cl, idx) => {
    for (const name of cl.members) out.set(name, idx)
  })
  return out
}

/** 某个 (rows, type) 下对齐好的延迟上下文：来源序列、中位、抖动集合等 */
interface LatencyContext {
  names: string[]
  series: Map<string, (number | null)[]>
  tsCount: number
  median: Map<string, number>
}

/** 从行数据构建延迟上下文：按时间戳对齐各来源序列，算中位延迟 */
function buildLatencyContext(rows: TaskQueryResult[], type: LatencyType): LatencyContext {
  const names = seriesNames(rows)
  const byTs = new Map<number, Map<string, number | null>>()
  const valsByName = new Map<string, number[]>()
  for (const r of rows) {
    const src = r.cron_source || '未知'
    const v = pickValue(r, type)
    const t = normalizeTs(r.timestamp)
    let row = byTs.get(t)
    if (!row) {
      row = new Map()
      byTs.set(t, row)
    }
    row.set(src, v)
    if (v != null) {
      let vals = valsByName.get(src)
      if (!vals) {
        vals = []
        valsByName.set(src, vals)
      }
      vals.push(v)
    }
  }
  const ts = [...byTs.keys()].sort((a, b) => a - b)
  const series = new Map<string, (number | null)[]>()
  const medianMap = new Map<string, number>()
  for (const name of names) {
    const seq = ts.map(t => byTs.get(t)?.get(name) ?? null)
    series.set(name, seq)
    const vals = valsByName.get(name) ?? []
    medianMap.set(name, vals.length ? median(vals) : Infinity)
  }
  return { names, series, tsCount: ts.length, median: medianMap }
}

/**
 * 聚类 + 强制拆分：先按相关性聚类，若只得到 1 个簇且来源数 >1，
 * 强制每个来源自成独立簇（按中位延迟升序编号），避免"全部同色"无法区分。
 */
function clusterWithForceSplit(ctx: LatencyContext): Map<string, number> {
  if (ctx.names.length === 0) return new Map()
  const clusters = clusterByCorrelation(ctx.names, ctx.series, ctx.tsCount, ctx.median)
  const clusterCount = new Set(clusters.values()).size
  if (clusterCount > 1 || ctx.names.length <= 1) return clusters
  // 仅 1 簇 → 强制全部拆分，每来源自成一簇，按中位延迟升序编号
  const order = [...ctx.names].sort(
    (a, b) => (ctx.median.get(a) ?? Infinity) - (ctx.median.get(b) ?? Infinity),
  )
  const out = new Map<string, number>()
  order.forEach((n, i) => out.set(n, i))
  return out
}

/** 去掉来源名前缀（PING / TCPING），取目标后缀用于跨类型 1 对 1 配对 */
function stripSourcePrefix(name: string): string {
  return name.replace(/^(?:PING|TCPING)\s+/, '').trim()
}

/** 颜色组（簇）：TCP 驱动组含 TCP anchors + 匹配 Ping；未匹配 Ping 组含 Ping anchors */
interface ColorGroup {
  tcpAnchors: string[]
  pingAnchors: string[]
  pingCopies: Map<string, string>
  avg: number
}

/**
 * 计算 Ping 与 TCP Ping 共用的 来源→颜色 映射（key 为完整来源名，含前缀，跨类型唯一）。
 * 以 TCP Ping 为标准：TCP 先聚类（含强制拆分）取色；Ping 按 1 对 1 后缀匹配复制 TCP 颜色，
 * 未匹配的 Ping 独立聚类接在 TCP 簇之后取色。所有簇按平均延迟升序 → 暖(红)到冷(蓝)。
 */
export function latencyColorsUnified(
  pingRows: TaskQueryResult[],
  tcpRows: TaskQueryResult[],
): Map<string, string> {
  const tcpCtx = buildLatencyContext(tcpRows, 'tcp_ping')
  const pingCtx = buildLatencyContext(pingRows, 'ping')
  const colors = new Map<string, string>()

  // 1. TCP 聚类（标准）→ 按簇分组
  const tcpClusters = clusterWithForceSplit(tcpCtx)
  const tcpByCluster = new Map<number, string[]>()
  for (const n of tcpCtx.names) {
    const c = tcpClusters.get(n) ?? 0
    let arr = tcpByCluster.get(c)
    if (!arr) {
      arr = []
      tcpByCluster.set(c, arr)
    }
    arr.push(n)
  }

  // 2. 跨类型 1 对 1 匹配：去前缀后缀在两侧都唯一才算配对
  const countSuffix = (ctx: LatencyContext) => {
    const counts = new Map<string, number>()
    for (const n of ctx.names) {
      const s = stripSourcePrefix(n)
      counts.set(s, (counts.get(s) ?? 0) + 1)
    }
    return counts
  }
  const tcpSuffixCount = countSuffix(tcpCtx)
  const pingSuffixCount = countSuffix(pingCtx)
  const tcpBySuffix = new Map<string, string>()
  for (const n of tcpCtx.names) {
    const s = stripSourcePrefix(n)
    if (tcpSuffixCount.get(s) === 1) tcpBySuffix.set(s, n)
  }
  const matchedPing = new Map<string, string>()
  const unmatchedPing: string[] = []
  for (const n of pingCtx.names) {
    const s = stripSourcePrefix(n)
    const tcp = pingSuffixCount.get(s) === 1 ? tcpBySuffix.get(s) : undefined
    if (tcp) matchedPing.set(n, tcp)
    else unmatchedPing.push(n)
  }

  // 3. 组装颜色组：TCP 驱动组 + 未匹配 Ping 组
  const groups: ColorGroup[] = []
  for (const members of tcpByCluster.values()) {
    const pingCopies = new Map<string, string>()
    const memberSet = new Set(members)
    for (const [ping, tcp] of matchedPing) {
      if (memberSet.has(tcp)) pingCopies.set(ping, tcp)
    }
    const avg = members.reduce((s, n) => s + (tcpCtx.median.get(n) ?? Infinity), 0) / Math.max(1, members.length)
    groups.push({ tcpAnchors: members, pingAnchors: [], pingCopies, avg })
  }
  if (unmatchedPing.length > 0) {
    const umSeries = new Map<string, (number | null)[]>()
    for (const n of unmatchedPing) {
      const s = pingCtx.series.get(n)
      if (s) umSeries.set(n, s)
    }
    const umCtx: LatencyContext = {
      names: unmatchedPing,
      series: umSeries,
      tsCount: pingCtx.tsCount,
      median: pingCtx.median,
    }
    const umClusters = clusterWithForceSplit(umCtx)
    const umByCluster = new Map<number, string[]>()
    for (const n of unmatchedPing) {
      const c = umClusters.get(n) ?? 0
      let arr = umByCluster.get(c)
      if (!arr) {
        arr = []
        umByCluster.set(c, arr)
      }
      arr.push(n)
    }
    for (const members of umByCluster.values()) {
      const avg = members.reduce((s, n) => s + (pingCtx.median.get(n) ?? Infinity), 0) / members.length
      groups.push({ tcpAnchors: [], pingAnchors: members, pingCopies: new Map(), avg })
    }
  }

  if (groups.length === 0) return colors

  // 4. 组按平均延迟升序 → 色相暖→冷
  groups.sort((a, b) => a.avg - b.avg)
  const baseHues = clusterHues(groups.length)

  // 5. 每组内：anchors 按中位排序分配色相浮动；匹配 Ping 复制其 TCP anchor 的完整颜色
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi]
    const isTcp = g.tcpAnchors.length > 0
    const ctx = isTcp ? tcpCtx : pingCtx
    const anchors = isTcp ? g.tcpAnchors : g.pingAnchors
    const baseHue = baseHues[Math.min(gi, baseHues.length - 1)] ?? WARM_HUE_START
    const sorted = [...anchors].sort(
      (a, b) => (ctx.median.get(a) ?? Infinity) - (ctx.median.get(b) ?? Infinity),
    )
    const anchorColor = new Map<string, string>()
    sorted.forEach((name, i) => {
      const spread = sorted.length > 1 ? (i / (sorted.length - 1) - 0.5) * 2 * CLUSTER_HUE_SPREAD : 0
      const hue = (baseHue + spread + 360) % 360
      // 所有色相统一基准饱和度（无特殊抬高），高抖动靠线条本身和统计行区分
      anchorColor.set(name, `hsl(${Math.round(hue)}, ${PALETTE_SAT}%, ${PALETTE_LIGHT}%)`)
    })
    for (const [name, color] of anchorColor) colors.set(name, color)
    // 匹配 Ping 直接复制 TCP anchor 颜色（色相/饱和/明度完全一致）
    for (const [ping, tcp] of g.pingCopies) {
      const c = anchorColor.get(tcp)
      if (c) colors.set(ping, c)
    }
  }

  return colors
}

export function buildLatencyChart(
  rows: TaskQueryResult[],
  type: LatencyType,
  colors: Map<string, string>,
) {
  const names = seriesNames(rows)
  const series: ChartSeries[] = names.map(name => ({ name, color: colors.get(name) ?? '#888' }))
  const byTs = new Map<number, ChartPoint>()

  for (const r of rows) {
    const t = normalizeTs(r.timestamp)
    let pt = byTs.get(t)
    if (!pt) {
      pt = { t }
      for (const n of names) pt[n] = null
      byTs.set(t, pt)
    }
    pt[r.cron_source || '未知'] = pickValue(r, type)
  }

  const data = [...byTs.values()].sort((a, b) => a.t - b.t)
  forwardFill(data, names)
  return { data, series }
}

/** 可见来源中发生丢包（success=false 或值缺失）的唯一时间戳，按时间升序 */
export function lossTimestamps(rows: TaskQueryResult[], type: LatencyType, sources: string[]): number[] {
  if (!sources.length) return []
  const visible = new Set(sources)
  const out = new Set<number>()
  for (const r of rows) {
    const src = r.cron_source || '未知'
    if (!visible.has(src)) continue
    if (pickValue(r, type) == null) out.add(normalizeTs(r.timestamp))
  }
  return [...out].sort((a, b) => a - b)
}

export interface LatencyStats {
  name: string
  color: string
  avg: number | null
  jitter: number | null
  lossRate: number
}

export function computeLatencyStats(
  rows: TaskQueryResult[],
  type: LatencyType,
  colors: Map<string, string>,
): LatencyStats[] {
  const stats = seriesNames(rows).map<LatencyStats>(name => {
    const list = rows.filter(r => (r.cron_source || '未知') === name)
    const vals: number[] = []
    for (const r of list) {
      const v = pickValue(r, type)
      if (v != null) vals.push(v)
    }

    const color = colors.get(name) ?? '#888'
    const lossRate = list.length ? ((list.length - vals.length) / list.length) * 100 : 0
    if (!vals.length) return { name, color, avg: null, jitter: null, lossRate }

    const avg = vals.reduce((s, v) => s + v, 0) / vals.length
    const jitter =
      vals.length >= 2
        ? vals.slice(1).reduce((s, v, i) => s + Math.abs(v - vals[i]), 0) / (vals.length - 1)
        : null

    return { name, color, avg, jitter, lossRate }
  })

  return stats.sort((a, b) => {
    const av = a.avg ?? Infinity
    const bv = b.avg ?? Infinity
    if (av !== bv) return av - bv
    const aj = a.jitter ?? Infinity
    const bj = b.jitter ?? Infinity
    if (aj !== bj) return aj - bj
    return a.lossRate - b.lossRate
  })
}
