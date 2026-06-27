// traffic-manager worker.js
//
// init: lastBefore 走 boot 链 → first_of_boot_in_range 查每条 boot 的第一条 → 累加 adjust
// runtime: counter 回退 OR uptime 回退 → reboot → 累加 adjust

const LOCK_TTL_MS = 120_000
const V = 11
const FIELDS = ['total_received', 'total_transmitted', 'boot_time', 'uptime']

function errMsg(e) { return e == null ? 'null error' : typeof e === 'string' ? e : (e.message || String(e)) }

async function tryLock() {
  const n = Date.now(), t = globalThis.__traffic_lock_ts || 0
  if (t && n - t < LOCK_TTL_MS) return false
  return globalThis.__traffic_lock_ts = n, true
}
async function unlock() { globalThis.__traffic_lock_ts = 0 }

function log(lv, m) { try { const L = globalThis.nodegetLog; if (L && typeof L[lv] === 'function') L[lv]('traffic', m) } catch {} }
const info = m => log('info', m), warn = m => log('warn', m), errLog = m => log('error', m)

async function kvSet(tok, ns, key, val) { await globalThis.nodeget('kv_set_value', { token: tok, namespace: ns, key, value: val }) }

function addMonths(d, n) { const b = d.getDate(); d.setMonth(d.getMonth() + n); if (d.getDate() !== b) d.setDate(0); return d }
function addPeriod(ds, p) {
  const d = new Date(ds + 'T00:00:00Z'), n = parseInt(p) || 1
  return p.endsWith('y') ? addMonths(d, n * 12) : p.endsWith('m') ? addMonths(d, n) : (d.setDate(d.getDate() + n), d)
}
function periodStart(ds, p) {
  if (!ds) ds = '1970-01-01'
  const now = new Date(); let c = new Date(ds + 'T00:00:00Z')
  if (Number.isNaN(c.getTime())) c = new Date('1970-01-01T00:00:00Z')
  for (let i = 0; i < 10000; i++) { const n = addPeriod(c.toISOString().slice(0, 10), p); if (n > now) return c.toISOString().slice(0, 10); c = n }
  return c.toISOString().slice(0, 10)
}

async function lastBefore(token, uuid, tsMs) {
  try {
    const resp = await globalThis.nodeget('agent_query_dynamic_summary', {
      token, query: { fields: FIELDS, condition: [{ uuid }, { timestamp_to: tsMs }, { last: null }] }
    })
    const r = (resp?.result || [])[0]
    if (!r || typeof r.total_received !== 'number') return null
    return { rx: r.total_received, tx: r.total_transmitted, boot: r.boot_time || 0, ts: r.timestamp || 0 }
  } catch (e) { return null }
}

async function firstOfBootInRange(token, uuid, fromMs, toMs, targetBoot) {
  try {
    const resp = await globalThis.nodeget('agent_query_dynamic_summary', {
      token, query: { fields: FIELDS, condition: [{ uuid }, { timestamp_from_to: [fromMs, toMs] }] }
    })
    for (const r of (resp?.result || [])) {
      if (r.boot_time === targetBoot && typeof r.total_received === 'number') {
        return { rx: r.total_received, tx: r.total_transmitted, ts: r.timestamp || 0 }
      }
    }
    return null
  } catch (e) { return null }
}

async function initState(token, uuid, periodMs, currentBoot, liveRx, liveTx) {
  const chain = [{ boot: currentBoot, endRx: liveRx, endTx: liveTx, endTs: Date.now() }]
  let ts = currentBoot * 1000 - 1
  const visited = new Set([currentBoot])

  for (let i = 0; i < 50; i++) {
    if (ts <= periodMs) break
    const rec = await lastBefore(token, uuid, ts)
    if (!rec || rec.boot === 0) break
    if (visited.has(rec.boot)) { warn(`uuid=${uuid}: cycle at boot ${rec.boot}`); break }
    visited.add(rec.boot)
    chain.push({ boot: rec.boot, endRx: rec.rx, endTx: rec.tx, endTs: rec.ts })
    ts = rec.boot * 1000 - 1
  }

  chain.reverse()
  info(`uuid=${uuid}: chain has ${chain.length} boots`)

  let adjustRx = 0, adjustTx = 0
  let bootStartRx = 0, bootStartTx = 0

  for (let i = 0; i < chain.length; i++) {
    const c = chain[i]
    const isCurrent = c.boot === currentBoot
    const tag = isCurrent ? 'current' : 'closed'

    const searchFrom = i === 0 ? periodMs : chain[i - 1].endTs + 1
    // 先查目标窗口，找不到则往前放宽 1 天（但不越过 periodMs）
    let first = await firstOfBootInRange(token, uuid, searchFrom, c.endTs, c.boot)
    if (!first && searchFrom > periodMs) {
      const fallbackFrom = Math.max(periodMs, searchFrom - 86400000)
      if (fallbackFrom < searchFrom) first = await firstOfBootInRange(token, uuid, fallbackFrom, c.endTs, c.boot)
    }

    // 当前 boot：如果 period 窗口内确实没有数据（监控延迟等），用 live 值兜底，
    // 宁可少算也不要 fallback 到 0 导致显示全部历史流量。
    // 已关闭的 boot：找不到 first 时用 0 兜底，该 boot 的 deltaRx 全计入 adjust。
    const frx = first ? first.rx : (isCurrent ? c.endRx : 0)
    const ftx = first ? first.tx : (isCurrent ? c.endTx : 0)
    const deltaRx = Math.max(0, c.endRx - frx)
    const deltaTx = Math.max(0, c.endTx - ftx)

    info(`uuid=${uuid}: boot=${c.boot} ${tag} end=${c.endRx}/${c.endTx} first=${frx}/${ftx} delta=${deltaRx}/${deltaTx}`)

    if (isCurrent) {
      bootStartRx = frx; bootStartTx = ftx
    } else {
      adjustRx += deltaRx; adjustTx += deltaTx
    }
  }

  return { adjustRx, adjustTx, bootStartRx, bootStartTx, chainLen: chain.length }
}

async function run(params, env) {
  const token = env?.token
  if (!token) return { error: 'missing token in env' }

  info('traffic worker start')
  if (!(await tryLock())) { info('traffic worker skipped: locked'); return { skipped: 'locked' } }

  try {
    const uuids = (await globalThis.nodeget('nodeget-server_list_all_agent_uuid', { token }))?.result?.uuids || []
    if (!uuids.length) return { ok: true, nodes: 0 }

    const mk = ['metadata_traffic_limit_gb', 'metadata_traffic_period', 'metadata_traffic_start_date']
    const mi = uuids.flatMap(u => mk.map(k => ({ namespace: u, key: k })))
    const mrows = (await globalThis.nodeget('kv_get_multi_value', { token, namespace_key: mi }))?.result || []
    const meta = {}; for (const r of mrows) { if (!meta[r.namespace]) meta[r.namespace] = {}; meta[r.namespace][r.key] = r.value }

    const dr = await globalThis.nodeget('agent_dynamic_summary_multi_last_query', {
      token, uuids, fields: ['total_received', 'total_transmitted', 'uptime', 'boot_time']
    })
    const dyn = {}; for (const d of (dr?.result || [])) { if (d.uuid) dyn[d.uuid] = d }

    const sk = ['traffic_state_v10', 'traffic_period_start']
    const si = uuids.flatMap(u => sk.map(k => ({ namespace: u, key: k })))
    const srows = (await globalThis.nodeget('kv_get_multi_value', { token, namespace_key: si }))?.result || []
    const kv = {}; for (const r of srows) { if (!kv[r.namespace]) kv[r.namespace] = {}; try { kv[r.namespace][r.key] = JSON.parse(r.value) } catch { kv[r.namespace][r.key] = r.value } }

    for (const uuid of uuids) {
      try {
        const d = dyn[uuid]; if (!d) continue
        const m = meta[uuid] || {}, s = kv[uuid] || {}
        const liveRx = d.total_received || 0, liveTx = d.total_transmitted || 0
        const uptime = d.uptime || 0, bootTime = d.boot_time || 0

        const period = m['metadata_traffic_period'] || '1m'
        const startDate = m['metadata_traffic_start_date'] || ''
        const newStart = periodStart(startDate || '1970-01-01', period)
        const newStartMs = new Date(newStart + 'T00:00:00Z').getTime()

        let state = s['traffic_state_v10']
        const oldPeriodStart = s['traffic_period_start']
        const periodChanged = oldPeriodStart !== newStart
        let reboot = false

        if (!state || state.v !== V || periodChanged) {
          const ia = await initState(token, uuid, newStartMs, bootTime, liveRx, liveTx)
          state = {
            v: V, adjust_rx: ia.adjustRx, adjust_tx: ia.adjustTx,
            boot_start_rx: ia.bootStartRx, boot_start_tx: ia.bootStartTx,
            last_rx: liveRx, last_tx: liveTx, last_uptime: uptime,
          }
          info(`uuid=${uuid}: INIT adjust=${ia.adjustRx}/${ia.adjustTx} boot_start=${ia.bootStartRx}/${ia.bootStartTx} (${ia.chainLen} boots)`)
        }

        if (liveRx < state.last_rx || liveTx < state.last_tx) {
          reboot = true
          const crx = Math.max(0, state.last_rx - state.boot_start_rx)
          const ctx = Math.max(0, state.last_tx - state.boot_start_tx)
          state.adjust_rx += crx; state.adjust_tx += ctx
          state.boot_start_rx = liveRx; state.boot_start_tx = liveTx
          info(`uuid=${uuid}: REBOOT counter_drop closed=${crx}/${ctx} adjust=${state.adjust_rx}/${state.adjust_tx}`)
        } else if (uptime < state.last_uptime) {
          reboot = true
          const crx = Math.max(0, state.last_rx - state.boot_start_rx)
          const ctx = Math.max(0, state.last_tx - state.boot_start_tx)
          state.adjust_rx += crx; state.adjust_tx += ctx
          state.boot_start_rx = liveRx; state.boot_start_tx = liveTx
          info(`uuid=${uuid}: REBOOT uptime_drop closed=${crx}/${ctx} adjust=${state.adjust_rx}/${state.adjust_tx}`)
        }

        state.last_rx = liveRx; state.last_tx = liveTx; state.last_uptime = uptime

        const usedRx = state.adjust_rx + Math.max(0, liveRx - state.boot_start_rx)
        const usedTx = state.adjust_tx + Math.max(0, liveTx - state.boot_start_tx)

        await kvSet(token, uuid, 'traffic_state_v10', state)
        await kvSet(token, uuid, 'traffic_period_start', newStart)
        await kvSet(token, uuid, 'traffic_period_usage', { rx: usedRx, tx: usedTx })
        await kvSet(token, uuid, 'traffic_baseline', {
          rx: state.boot_start_rx, tx: state.boot_start_tx,
          adjust_rx: state.adjust_rx, adjust_tx: state.adjust_tx, v: V,
        })

        info(`uuid=${uuid}: ${reboot ? 'REBOOT' : 'ok'} used=${((usedRx+usedTx)/1e9).toFixed(2)}GB adj=${state.adjust_rx}/${state.adjust_tx} bs=${state.boot_start_rx}/${state.boot_start_tx}`)
      } catch (e) { errLog(`uuid=${uuid}: ${errMsg(e)}`) }
    }

    return { ok: true, nodes: uuids.length }
  } catch (e) { errLog(`worker error: ${errMsg(e)}`); return { error: errMsg(e) } }
  finally { await unlock() }
}

export default { onCall: run, onCron: run }
