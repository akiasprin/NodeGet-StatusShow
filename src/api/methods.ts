import { httpRpcCall, type RpcClient } from './client'
import type { DynamicSummary, StaticData, TaskQueryCondition, TaskQueryResult } from '../types'

export const listAgentUuids = (c: RpcClient) =>
  c.call<{ uuids?: string[] }>('nodeget-server_list_all_agent_uuid', {}).then(r => r?.uuids || [])

export const staticDataMulti = (c: RpcClient, uuids: string[], fields: string[]) =>
  c.call<StaticData[]>('agent_static_data_multi_last_query', { uuids, fields })

export const dynamicSummaryMulti = (c: RpcClient, uuids: string[], fields: string[]) =>
  c.call<DynamicSummary[]>('agent_dynamic_summary_multi_last_query', { uuids, fields })

export const queryDynamicSummary = (
  c: RpcClient,
  uuid: string,
  fields: string[],
  from: number,
  to: number,
) =>
  c.call<DynamicSummary[]>('agent_query_dynamic_summary', {
    fields,
    condition: [{ uuid }, { timestamp_from_to: [from, to] }],
  })

export const kvGetMulti = (
  c: RpcClient,
  items: { namespace: string; key: string }[],
) => c.call<{ namespace: string; key: string; value: unknown }[]>('kv_get_multi_value', { namespace_key: items })

export const taskQuery = (
  c: RpcClient,
  conditions: TaskQueryCondition[],
  timeoutMs?: number,
) => c.call<TaskQueryResult[]>('task_query', { task_data_query: { condition: conditions } }, timeoutMs)

/** HTTP 全量查询 — 浏览器自动 gzip，适合大窗口（如 24h 首次拉取） */
export const taskQueryHttp = (
  wsUrl: string,
  token: string,
  conditions: TaskQueryCondition[],
  timeoutMs?: number,
) => httpRpcCall<TaskQueryResult[]>(
  wsUrl,
  token,
  'task_query',
  { task_data_query: { condition: conditions } },
  timeoutMs,
)

