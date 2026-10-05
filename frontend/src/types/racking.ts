/**
 * 倒罐开工的并发草稿与冲突模型。
 * 几台平板各自编排同一段的倒罐时：先到者占住目标段与罐容，后到者保存失败，
 * 草稿保留在本地（localStorage）并列出冲突罐与差量，可改派罐位后重试。
 */
import type { OperationType } from './operation'

/** 一次倒罐移动：从指定段转出 volumeL 到目标罐 */
export interface RackingMoveDraft {
  /** 转出批次段 id */
  segmentId: string
  /** 目标发酵罐 id */
  targetTankId: string
  /** 转出量 L（每次只转指定段的指定量） */
  volumeL: number
}

/** 倒罐作业草稿（对应一条「倒罐」作业计划） */
export interface RackingDraft {
  /** 关联作业 id（已排程时存在）；临时草稿可为空 */
  operationId: string | null
  batchId: string
  type: OperationType
  date: string
  durationMin: number
  operator: string
  moves: RackingMoveDraft[]
  /** 打开草稿时的快照时间戳，用于乐观锁（CAS） */
  baseVersion: number
  /** 草稿更新时间 */
  savedAt: number
}

/** 单条移动的冲突明细：先到者占住目标段，或目标罐容量不足 */
export interface RackingConflict {
  /** 转出段 id */
  segmentId: string
  /** 目标罐 id */
  tankId: string
  /** 目标罐号 */
  tankCode: string
  /** 申请转入量 L */
  requestedL: number
  /** 目标罐当前剩余可用容量 L（可能为负，表示已被超额抢占） */
  availableL: number
  /** 容量差量 L：申请量超出剩余容量的部分（>0 表示放不下） */
  shortfallL: number
  /** 段在打开草稿后是否已被先到者改动（CAS 失效） */
  segmentTaken: boolean
  /** 先占用目标段 / 目标罐容的作业或批次描述 */
  occupiedBy: string
}

/** 容量不足 / 并发冲突：拒绝开工并携带全部冲突明细 */
export class RackingConflictError extends Error {
  conflicts: RackingConflict[]

  constructor(conflicts: RackingConflict[]) {
    super(
      conflicts.length > 0
        ? `目标罐容量不足或段已被占用：${conflicts
            .map((item) => `${item.tankCode} 差 ${item.shortfallL}L`)
            .join('；')}`
        : '倒罐开工被拒绝'
    )
    this.name = 'RackingConflictError'
    this.conflicts = conflicts
  }
}

export function isRackingConflictError(error: unknown): error is RackingConflictError {
  return error instanceof RackingConflictError
}
