/**
 * 发酵罐 store：维护罐位占用、容量筛选条件与占用冲突校验。
 * 占用以批次段为准：一个罐可被多个批次段占用，受容量 L 约束而非「一罐一批」。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { LocationQuery } from 'vue-router'
import type { Tank, TankState } from '@/types/tank'
import type { FilterModel } from '@/types/filter'
import type { BatchRow, SegmentRow, TankRow } from '@/utils/db'
import { assertTankCapacity, putTank, removeTank, updateTank as updateTankRow, ROW_REVISION } from '@/utils/db'
import { createId } from '@/utils/uuid'
import { queryToFilters } from '@/utils/query'

export const TANK_FILTER_KEYS = ['materials', 'tempControls', 'states']

export interface TankCapacityCheck {
  capacityL: number
  occupiedL: number
  freeL: number
  shortfallL: number
}

export const useTankStore = defineStore('tank', () => {
  const filters = ref<FilterModel>({ keyword: '', materials: [], tempControls: [], states: [] })
  const selectedId = ref<string | null>(null)
  const busy = ref(false)

  function setFilters(next: FilterModel): void {
    filters.value = next
  }

  function resetFilters(): void {
    filters.value = { keyword: '', materials: [], tempControls: [], states: [] }
  }

  function applyQuery(query: LocationQuery): void {
    filters.value = queryToFilters(query, TANK_FILTER_KEYS)
  }

  function select(id: string | null): void {
    selectedId.value = id
  }

  /** 占用该罐的全部在罐段（未出罐批次、量 > 0） */
  function occupantSegmentsOf(
    tankId: string,
    segments: SegmentRow[],
    batches: BatchRow[]
  ): SegmentRow[] {
    return segments.filter((segment) => {
      if (segment.tankId !== tankId || segment.volumeL <= 0) return false
      const batch = batches.find((item) => item.id === segment.batchId)
      return Boolean(batch && batch.state !== '已出罐')
    })
  }

  /** 该罐在罐占用量（L） */
  function occupiedVolumeOf(
    tankId: string,
    segments: SegmentRow[],
    batches: BatchRow[]
  ): number {
    return occupantSegmentsOf(tankId, segments, batches).reduce((sum, segment) => sum + segment.volumeL, 0)
  }

  /** 倒罐 / 分配前的容量预检：返回剩余容量与差量 */
  async function checkCapacity(
    tankId: string,
    volumeL: number,
    sameBatchId?: string
  ): Promise<TankCapacityCheck> {
    busy.value = true
    try {
      return await assertTankCapacity(tankId, volumeL, { sameBatchId })
    } finally {
      busy.value = false
    }
  }

  async function createTank(payload: Omit<Tank, 'id'>): Promise<string> {
    const now = Date.now()
    const id = createId('tank')
    await putTank({ ...payload, id, revision: ROW_REVISION, createdAt: now, updatedAt: now })
    selectedId.value = id
    return id
  }

  async function updateTank(id: string, patch: Partial<Tank>): Promise<void> {
    await updateTankRow(id, patch)
  }

  async function deleteTank(id: string): Promise<void> {
    await removeTank(id)
    if (selectedId.value === id) selectedId.value = null
  }

  /** 罐位状态流转（空闲 ⇄ 清洗中）；置为「在用」需由批次段绑定触发 */
  async function changeState(tank: TankRow, next: TankState): Promise<void> {
    if (next === '在用') {
      throw new Error('罐位「在用」由入罐 / 倒罐的批次段绑定后自动置位')
    }
    await updateTankRow(tank.id, { state: next })
  }

  return {
    filters,
    selectedId,
    busy,
    setFilters,
    resetFilters,
    applyQuery,
    select,
    occupantSegmentsOf,
    occupiedVolumeOf,
    checkCapacity,
    createTank,
    updateTank,
    deleteTank,
    changeState
  }
})
