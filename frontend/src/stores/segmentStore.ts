/**
 * 批次段 store：维护在罐段列表、段量守恒与倒罐动作。
 * 倒罐保存冲突时保留草稿（draft）与冲突信息（conflicts：冲突罐 + 差量），供页面重试。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { liveQuery } from 'dexie'
import type { SegmentRow } from '@/utils/db'
import { db, rackSegments, SegmentConflictError } from '@/utils/db'
import type { RackingDraft } from '@/types/segment'

export const useSegmentStore = defineStore('segment', () => {
  const segments = ref<SegmentRow[]>([])
  const ready = ref(false)
  /** 最近一次倒罐冲突（先到者占住目标段 / 目标罐容量不足） */
  const conflict = ref<SegmentConflictError | null>(null)
  /** 冲突时保留的草稿，原样用于重试 */
  const draft = ref<RackingDraft | null>(null)

  // 响应式订阅段表
  const subscription = liveQuery(async () => db.segments.toArray()).subscribe({
    next: (rows) => {
      segments.value = rows
      ready.value = true
    },
    error: (err: unknown) => {
      console.error('订阅批次段失败', err)
    }
  })

  /** 某批次的全部段（按段号排序） */
  function segmentsOfBatch(batchId: string): SegmentRow[] {
    return segments.value
      .filter((seg) => seg.batchId === batchId)
      .sort((a, b) => a.seq - b.seq)
  }

  /** 某批次各段量合计（应恒等于批次入罐量） */
  function volumeOfBatch(batchId: string): number {
    return segmentsOfBatch(batchId).reduce((sum, seg) => sum + seg.volumeL, 0)
  }

  /** 某批次当前占用的罐位数 */
  function tankCountOfBatch(batchId: string): number {
    return new Set(segmentsOfBatch(batchId).map((seg) => seg.tankId).filter(Boolean)).size
  }

  /** 某罐当前的在罐段（跨批次） */
  function segmentsInTank(tankId: string): SegmentRow[] {
    return segments.value.filter((seg) => seg.tankId === tankId && seg.volumeL > 0)
  }

  /** 某罐当前占用量（L） */
  function occupiedVolumeInTank(tankId: string): number {
    return segmentsInTank(tankId).reduce((sum, seg) => sum + seg.volumeL, 0)
  }

  function clearConflict(): void {
    conflict.value = null
    draft.value = null
  }

  /**
   * 倒罐保存。成功返回 true；冲突时保留草稿与冲突信息并返回 false（不抛错）。
   * 页面据此展示冲突面板，用户可直接重试。
   */
  async function rack(draftToSave: RackingDraft): Promise<boolean> {
    try {
      await rackSegments(draftToSave)
      clearConflict()
      return true
    } catch (err) {
      if (err instanceof SegmentConflictError) {
        conflict.value = err
        draft.value = err.draft
        return false
      }
      throw err
    }
  }

  /** 重试最近一次失败的倒罐（用保留的草稿；重试前刷新来源段修订号与段量） */
  async function retry(): Promise<boolean> {
    if (!draft.value) return false
    const source = await db.segments.get(draft.value.sourceSegmentId)
    if (!source) throw new Error('来源段已被删除，请刷新后重试')
    const total = draft.value.targets.reduce((sum, t) => sum + (t.volumeL || 0), 0)
    if (total > source.volumeL) {
      throw new Error(`来源段量已变为 ${source.volumeL}L，不足 ${total}L，请调整倒罐量`)
    }
    draft.value = { ...draft.value, sourceRevision: source.revision }
    return await rack(draft.value)
  }

  const hasConflict = computed(() => conflict.value !== null)

  return {
    segments,
    ready,
    conflict,
    draft,
    hasConflict,
    segmentsOfBatch,
    volumeOfBatch,
    tankCountOfBatch,
    segmentsInTank,
    occupiedVolumeInTank,
    clearConflict,
    rack,
    retry,
    subscription
  }
})
