/**
 * 作业 store：维护作业顺序、完成态与作业类型筛选。
 * 作业认批次段（segmentId）；倒罐作业可排程后再「开工」，开工时执行段拆分并做
 * 罐容不足拒绝与并发 CAS 冲突检测。失败草稿保留在 localStorage 可改派重试。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { LocationQuery } from 'vue-router'
import type { Operation } from '@/types/operation'
import type { FilterModel } from '@/types/filter'
import type { RackingConflict, RackingDraft } from '@/types/racking'
import {
  completeOperation,
  executeRacking,
  nextOperationSeq,
  putOperation,
  removeOperation,
  reorderOperations,
  updateOperation as updateOperationRow,
  ROW_REVISION
} from '@/utils/db'
import { createId } from '@/utils/uuid'
import { queryToFilters } from '@/utils/query'

export const OPERATION_FILTER_KEYS = ['types', 'states']

/** 倒罐草稿在 localStorage 的键 */
export const RACKING_DRAFT_KEY = 'gbwinetank-racking-drafts'

function loadDrafts(): RackingDraft[] {
  try {
    const raw = localStorage.getItem(RACKING_DRAFT_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as RackingDraft[]) : []
  } catch {
    return []
  }
}

function persistDrafts(drafts: RackingDraft[]): void {
  localStorage.setItem(RACKING_DRAFT_KEY, JSON.stringify(drafts))
}

export const useOperationStore = defineStore('operation', () => {
  const filters = ref<FilterModel>({ keyword: '', types: [], states: [] })
  const currentBatchId = ref<string | null>(null)
  const currentSegmentId = ref<string | null>(null)
  /** 最近一次开工冲突（对话框展示冲突罐与差量） */
  const lastConflicts = ref<RackingConflict[]>([])
  /** 未开工成功而保留下来的草稿 */
  const drafts = ref<RackingDraft[]>(loadDrafts())

  function setFilters(next: FilterModel): void {
    filters.value = next
  }

  function resetFilters(): void {
    filters.value = { keyword: '', types: [], states: [] }
  }

  function applyQuery(query: LocationQuery): void {
    filters.value = queryToFilters(query, OPERATION_FILTER_KEYS)
    if (typeof query.batchId === 'string' && query.batchId.length > 0) {
      currentBatchId.value = query.batchId
    }
    if (typeof query.segmentId === 'string' && query.segmentId.length > 0) {
      currentSegmentId.value = query.segmentId
    }
  }

  function select(id: string | null): void {
    currentBatchId.value = id
  }

  function selectSegment(id: string | null): void {
    currentSegmentId.value = id
  }

  async function createOperation(payload: Omit<Operation, 'id' | 'seq'>): Promise<string> {
    if (!payload.batchId) throw new Error('请选择批次')
    if (!payload.segmentId) throw new Error('请选择批次段')
    if (!payload.operator.trim()) throw new Error('请填写操作人')
    const seq = await nextOperationSeq(payload.batchId)
    const now = Date.now()
    const id = createId('operation')
    await putOperation({ ...payload, id, seq, revision: ROW_REVISION, createdAt: now, updatedAt: now })
    return id
  }

  async function updateOperation(id: string, patch: Partial<Operation>): Promise<void> {
    await updateOperationRow(id, patch)
  }

  async function deleteOperation(id: string): Promise<void> {
    await removeOperation(id)
    drafts.value = drafts.value.filter((draft) => draft.operationId !== id)
    persistDrafts(drafts.value)
  }

  /** 普通作业（压帽 / 淋皮）标记完成：回写批次最近作业时间 */
  async function finish(id: string): Promise<void> {
    await completeOperation(id)
  }

  /** 拖拽调序后按新顺序批量写回 seq */
  async function move(list: Operation[], from: number, to: number): Promise<void> {
    if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return
    const next = [...list]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    await reorderOperations(next.map((item) => item.id))
  }

  /* ------------------------------ 倒罐草稿 ------------------------------ */

  /** 保存 / 更新一条草稿（先到先占在开工时判定；保存本身只落本地草稿） */
  function saveDraft(draft: RackingDraft): void {
    const rest = drafts.value.filter((item) => item.operationId !== draft.operationId)
    const next = [{ ...draft, savedAt: Date.now() }, ...rest]
    drafts.value = next
    persistDrafts(next)
  }

  function discardDraft(operationId: string | null): void {
    const next = drafts.value.filter((draft) => draft.operationId !== operationId)
    drafts.value = next
    persistDrafts(next)
    if (lastConflicts.value.length > 0 && operationId) lastConflicts.value = []
  }

  function draftOf(operationId: string | null): RackingDraft | null {
    if (!operationId) return null
    return drafts.value.find((draft) => draft.operationId === operationId) ?? null
  }

  /**
   * 开工：执行倒罐段拆分。
   * - 目标罐容量不足 / 段已被先到者改动 → 抛出 RackingConflictError，草稿保留
   * - 成功 → 删除该草稿
   * 返回 true 表示开工成功。
   */
  async function startRacking(draft: RackingDraft): Promise<boolean> {
    try {
      await executeRacking({
        operationId: draft.operationId,
        batchId: draft.batchId,
        date: draft.date,
        durationMin: draft.durationMin,
        operator: draft.operator,
        moves: draft.moves,
        baseVersion: draft.baseVersion
      })
      lastConflicts.value = []
      discardDraft(draft.operationId)
      return true
    } catch (error) {
      if (error && typeof error === 'object' && 'conflicts' in error) {
        lastConflicts.value = (error as { conflicts: RackingConflict[] }).conflicts
        saveDraft(draft)
      }
      throw error
    }
  }

  return {
    filters,
    currentBatchId,
    currentSegmentId,
    lastConflicts,
    drafts,
    setFilters,
    resetFilters,
    applyQuery,
    select,
    selectSegment,
    createOperation,
    updateOperation,
    deleteOperation,
    finish,
    move,
    saveDraft,
    discardDraft,
    draftOf,
    startRacking
  }
})
