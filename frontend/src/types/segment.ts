/**
 * 批次段：倒罐后一个批次被分到多个发酵罐，每段绑定一个罐位。
 * 同批次各段量（volumeL）之和恒等于批次入罐量（Batch.volumeL）。
 */
export interface Segment {
  id: string
  /** 所属批次 */
  batchId: string
  /** 绑定的发酵罐 id（已出罐后为空串，表示罐位已释放） */
  tankId: string
  /** 段量（L）；同批次各段之和恒等于批次入罐量 */
  volumeL: number
  /** 段号（同批次内从 1 开始） */
  seq: number
  /** 来源段 id（倒罐生成时记录；入罐整段为空） */
  fromSegmentId?: string | null
}

/** 倒罐目标行：把一段酒转到指定罐 */
export interface RackTarget {
  /** 目标发酵罐 id */
  tankId: string
  /** 转入量（L） */
  volumeL: number
}

/** 倒罐草稿：从来源段转出若干到目标罐；并发冲突时原样保留以便重试 */
export interface RackingDraft {
  batchId: string
  /** 来源段 id */
  sourceSegmentId: string
  /** 读到的来源段修订号（乐观锁依据） */
  sourceRevision: number
  /** 目标行 */
  targets: RackTarget[]
}

/** 冲突罐信息：目标罐容量不足时给出占用量与差量 */
export interface ConflictTank {
  tankId: string
  tankCode: string
  /** 罐容量（L） */
  capacityL: number
  /** 该罐当前已占用量（L，含本批次其它段） */
  occupiedL: number
  /** 本次计划转入量（L） */
  transferL: number
  /** 差量（L）：occupied + transfer - capacity；>0 表示容量不足 */
  deficitL: number
}

export function createEmptySegment(): Omit<Segment, 'id'> {
  return { batchId: '', tankId: '', volumeL: 0, seq: 1, fromSegmentId: null }
}
