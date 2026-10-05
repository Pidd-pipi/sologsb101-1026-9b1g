/**
 * 批次段 store：倒罐后的批次-罐绑定、段量守恒与罐容占用的响应式视图。
 * 段是罐绑定的唯一事实源；读数 / 苹乳 / 作业都按段归属。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { BatchRow, SegmentRow, TankRow } from '@/utils/db'
import { sumSegmentVolume, wholeSegmentId } from '@/types/segment'
import { tankOccupiedVolume } from '@/utils/db'

export const useSegmentStore = defineStore('segment', () => {
  /** 当前选中的批次段（读数 / 苹乳 / 作业共用上下文） */
  const currentSegmentId = ref<string | null>(null)
  const busy = ref(false)

  function selectSegment(id: string | null): void {
    currentSegmentId.value = id
  }

  /** 某批次的全部段（按 seq 升序） */
  function segmentsOfBatch(segments: SegmentRow[], batchId: string): SegmentRow[] {
    return segments
      .filter((segment) => segment.batchId === batchId)
      .sort((a, b) => a.seq - b.seq)
  }

  /** 段量合计是否与批次入罐量守恒（应始终为 0） */
  function volumeConsistent(batch: Pick<BatchRow, 'id' | 'volumeL'>, segments: SegmentRow[]): boolean {
    return sumSegmentVolume(segmentsOfBatch(segments, batch.id)) === batch.volumeL
  }

  /** 段当前所在罐号 */
  function tankCodeOf(segment: SegmentRow, tanks: TankRow[]): string {
    if (!segment.tankId) return '已出罐'
    return tanks.find((tank) => tank.id === segment.tankId)?.code ?? '未知罐'
  }

  /** 某罐的在罐段（未出罐批次、量 > 0） */
  function activeSegmentsInTank(
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

  /** 同步刷新某罐占用量（容量看板 / 倒罐校验用） */
  async function occupiedVolume(tankId: string): Promise<number> {
    busy.value = true
    try {
      return await tankOccupiedVolume(tankId)
    } finally {
      busy.value = false
    }
  }

  /** 整段 id（旧批次展示用） */
  function wholeId(batchId: string): string {
    return wholeSegmentId(batchId)
  }

  return {
    currentSegmentId,
    busy,
    selectSegment,
    segmentsOfBatch,
    volumeConsistent,
    tankCodeOf,
    activeSegmentsInTank,
    occupiedVolume,
    wholeId,
    /** 段量合计的响应式便捷计算 */
    totalVolume: computed(() => (list: SegmentRow[]) => sumSegmentVolume(list))
  }
})
