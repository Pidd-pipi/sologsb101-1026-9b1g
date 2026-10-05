/** 作业类型 */
export type OperationType = '倒罐' | '压帽' | '淋皮'
/** 作业状态 */
export type OperationState = '计划' | '已完成'

/** 车间作业：倒罐 / 压帽 / 淋皮；作业认批次段 */
export interface Operation {
  id: string
  /** 所属批次（冗余，便于按批次聚合） */
  batchId: string
  /** 作业作用的批次段（压帽 / 淋皮针对具体罐段；倒罐为转出段） */
  segmentId: string
  /** 作业类型 */
  type: OperationType
  /** 计划日期 YYYY-MM-DD */
  date: string
  /** 时长（分钟） */
  durationMin: number
  /** 操作人 */
  operator: string
  /** 作业状态 */
  state: OperationState
  /** 拖拽调序后的先后次序（从 1 开始） */
  seq: number
  /** 倒罐开工时转出的目标罐（仅倒罐作业用；开工成功后记录实际去向） */
  targetTankId: string
  /** 倒罐转出量 L（仅倒罐作业用） */
  transferVolumeL: number
}

export const OPERATION_TYPES: OperationType[] = ['倒罐', '压帽', '淋皮']
export const OPERATION_STATES: OperationState[] = ['计划', '已完成']

export function createEmptyOperation(segmentId = '', batchId = ''): Omit<Operation, 'id' | 'seq'> {
  return {
    batchId,
    segmentId,
    type: '倒罐',
    date: new Date().toISOString().slice(0, 10),
    durationMin: 45,
    operator: '',
    state: '计划',
    targetTankId: '',
    transferVolumeL: 0
  }
}
