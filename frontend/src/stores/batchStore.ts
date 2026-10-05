/**
 * 入罐批次 store：维护在罐批次、当前选中批次与地块/罐绑定校验。
 * 建批次时同时落唯一整段（BatchSegment），段量 = 入罐量；段是罐绑定事实源。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { LocationQuery } from 'vue-router'
import type { Batch } from '@/types/batch'
import type { FilterModel } from '@/types/filter'
import type { BatchRow, SegmentRow } from '@/utils/db'
import {
  assertTankAssignable,
  putBatch,
  putSegment,
  removeBatch,
  shipBatch as shipBatchRow,
  updateBatch as updateBatchRow,
  updateTank,
  listSegmentsOfBatch,
  db,
  ROW_REVISION
} from '@/utils/db'
import { createWholeSegment } from '@/types/segment'
import { createId } from '@/utils/uuid'
import { queryToFilters } from '@/utils/query'

export const BATCH_FILTER_KEYS = ['states', 'parcelIds']

export const useBatchStore = defineStore('batch', () => {
  const filters = ref<FilterModel>({ keyword: '', states: [], parcelIds: [] })
  /** 当前选中的批次 id（读数页、作业页共用上下文） */
  const currentBatchId = ref<string | null>(null)
  const error = ref<string | null>(null)

  function setFilters(next: FilterModel): void {
    filters.value = next
  }

  function resetFilters(): void {
    filters.value = { keyword: '', states: [], parcelIds: [] }
  }

  function applyQuery(query: LocationQuery): void {
    filters.value = queryToFilters(query, BATCH_FILTER_KEYS)
    if (typeof query.batchId === 'string' && query.batchId.length > 0) {
      currentBatchId.value = query.batchId
    }
  }

  function select(id: string | null): void {
    currentBatchId.value = id
  }

  /** 入罐登记：先校验罐容放得下整批，再建批次 + 唯一整段，罐置为「在用」 */
  async function createBatch(payload: Omit<Batch, 'id' | 'lastOperationAt'>): Promise<string> {
    error.value = null
    if (!payload.parcelId) throw new Error('请选择地块')
    if (!payload.tankId) throw new Error('请选择发酵罐')
    await assertTankAssignable(payload.tankId, null, payload.volumeL)
    const now = Date.now()
    const id = createId('batch')
    await db.transaction('rw', db.batches, db.segments, db.tanks, async () => {
      await putBatch({
        ...payload,
        id,
        lastOperationAt: null,
        revision: ROW_REVISION,
        createdAt: now,
        updatedAt: now
      })
      const whole: SegmentRow = {
        ...createWholeSegment(id, payload.tankId, payload.volumeL),
        revision: ROW_REVISION,
        createdAt: now,
        updatedAt: now
      }
      await putSegment(whole)
      await updateTank(payload.tankId, { state: '在用' })
    })
    currentBatchId.value = id
    return id
  }

  /**
   * 改绑罐位（仅整段批次支持直接改绑；已倒罐拆分的批次请到作业页倒罐）。
   * 同步移动唯一整段并更新新旧罐状态。
   */
  async function updateBatch(id: string, patch: Partial<Batch>, current: BatchRow): Promise<void> {
    error.value = null
    if (patch.volumeL !== undefined && patch.volumeL !== current.volumeL) {
      const segments = await listSegmentsOfBatch(id)
      if (segments.length !== 1) {
        throw new Error('批次已倒罐拆分，不能直接改入罐量；段量合计须等于原入罐量')
      }
    }
    if (patch.tankId && patch.tankId !== current.tankId) {
      const segments = await listSegmentsOfBatch(id)
      if (segments.length !== 1) {
        throw new Error('批次已分到多个罐，请用「倒罐」移动指定段，不能整体改绑')
      }
      const volumeL = patch.volumeL ?? current.volumeL
      const targetTankId = patch.tankId
      await assertTankAssignable(targetTankId, id, volumeL)
      await db.transaction('rw', db.segments, db.tanks, async () => {
        const segment = segments[0]!
        await db.segments.update(segment.id, { tankId: targetTankId, updatedAt: Date.now() } as never)
        await updateTank(targetTankId, { state: '在用' })
        if (current.tankId) {
          const stillThere = await db.segments
            .where('tankId')
            .equals(current.tankId)
            .filter((item) => item.volumeL > 0)
            .count()
          if (stillThere === 0) await updateTank(current.tankId, { state: '空闲' })
        }
      })
    }
    if (patch.volumeL !== undefined) {
      const segments = await listSegmentsOfBatch(id)
      if (segments.length === 1) {
        await db.segments.update(segments[0]!.id, { volumeL: patch.volumeL, updatedAt: Date.now() } as never)
      }
    }
    await updateBatchRow(id, patch)
  }

  async function deleteBatch(id: string): Promise<void> {
    await removeBatch(id)
    if (currentBatchId.value === id) currentBatchId.value = null
  }

  /** 出罐：释放全部段的罐位并归档批次 */
  async function ship(id: string): Promise<void> {
    await shipBatchRow(id)
  }

  return {
    filters,
    currentBatchId,
    error,
    setFilters,
    resetFilters,
    applyQuery,
    select,
    createBatch,
    updateBatch,
    deleteBatch,
    ship
  }
})
