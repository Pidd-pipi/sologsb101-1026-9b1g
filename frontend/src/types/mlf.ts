/** 苹乳发酵状态 */
export type MlfState = '未启动' | '进行中' | '已完成'

/** 苹果酸乳酸发酵跟踪；苹乳认批次段 */
export interface Mlf {
  id: string
  /** 所属批次（冗余，便于按批次聚合） */
  batchId: string
  /** 所属批次段：苹乳在倒罐后的具体罐段里进行 */
  segmentId: string
  /** 启动日期 */
  startDate: string
  /** 结束日期（未结束为空串） */
  endDate: string
  /** 当前苹果酸（g/L） */
  malicG: number
  /** 苹乳状态 */
  state: MlfState
}

/** 苹果酸低于该值即判定苹乳结束（g/L） */
export const MALIC_DONE_THRESHOLD = 0.3
/** 启动苹乳时的初始苹果酸参考值（g/L） */
export const MALIC_START_G = 2.4

export const MLF_STATES: MlfState[] = ['未启动', '进行中', '已完成']

export function createEmptyMlf(segmentId = '', batchId = ''): Omit<Mlf, 'id'> {
  return {
    batchId,
    segmentId,
    startDate: new Date().toISOString().slice(0, 10),
    endDate: '',
    malicG: MALIC_START_G,
    state: '未启动'
  }
}
