/**
 * 批次段：倒罐后一个批次可能被分到几个发酵罐，每一段绑定一个罐。
 * 不变量：同一批次所有段的 volumeL 合计始终等于批次入罐量 Batch.volumeL。
 * 读数 / 苹乳 / 作业都认段（segmentId），批次只作为聚合根。
 */
export interface BatchSegment {
  id: string
  /** 所属批次 */
  batchId: string
  /** 当前所在发酵罐 id（整批出罐后清空） */
  tankId: string
  /** 本段在罐量（L） */
  volumeL: number
  /** 拆分序号（从 1 开始，整段恒为 1） */
  seq: number
}

/** 整段的固定序号：未倒罐批次自动补出的唯一整段都用它 */
export const WHOLE_SEGMENT_SEQ = 1

/** 整段 id 规则：旧数据升级 / 备份导入时按批次确定性补出唯一整段 */
export function wholeSegmentId(batchId: string): string {
  return `seg-${batchId}`
}

/** 倒罐拆分新段 id（带随机后缀，避免同批次多次拆分碰撞） */
export function createSegmentId(batchId: string): string {
  const random = Math.random().toString(36).slice(2, 8)
  return `seg-${batchId}-${Date.now().toString(36)}-${random}`
}

/** 批次是否只有唯一整段（即从未倒罐拆分） */
export function isWholeBatch(segments: Pick<BatchSegment, 'seq'>[]): boolean {
  return segments.length === 1 && segments[0].seq === WHOLE_SEGMENT_SEQ
}

/** 段量合计（L） */
export function sumSegmentVolume(segments: Pick<BatchSegment, 'volumeL'>[]): number {
  return segments.reduce((sum, segment) => sum + segment.volumeL, 0)
}

/**
 * 校验段量合计是否等于批次入罐量。
 * 返回差额：0 表示守恒；正数表示段量比入罐量少；负数表示多。
 */
export function segmentVolumeGap(
  batch: { volumeL: number },
  segments: Pick<BatchSegment, 'volumeL'>[]
): number {
  return batch.volumeL - sumSegmentVolume(segments)
}

/** 入罐时创建唯一整段 */
export function createWholeSegment(batchId: string, tankId: string, volumeL: number): BatchSegment {
  return { id: wholeSegmentId(batchId), batchId, tankId, volumeL, seq: WHOLE_SEGMENT_SEQ }
}
