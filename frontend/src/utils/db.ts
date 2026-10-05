/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名 gbwinetank-db，数据结构版本号 version(2) 与 upgrade() 迁移逻辑
 * - 地块 / 发酵罐 / 入罐批次 / 批次段 / 发酵读数 / 作业 / 苹乳 / 品评 八张表分表存储
 * - 倒罐后一个批次拆成多个批次段（BatchSegment），段量合计恒等于批次入罐量；
 *   读数 / 苹乳 / 作业都挂 segmentId
 * - version(2) 升级：为历史批次自动补出唯一整段，并回填子表 segmentId
 * - 首次打开自动播种互相引用的演示数据，保证每个页面打开都有内容
 * - 纯前端应用：不依赖任何后端或数据库服务
 */
import Dexie, { type Table } from 'dexie'
import type { Parcel } from '../types/parcel'
import type { Tank } from '../types/tank'
import type { Batch } from '../types/batch'
import type { BatchSegment } from '../types/segment'
import { createSegmentId, wholeSegmentId, WHOLE_SEGMENT_SEQ } from '../types/segment'
import type { Reading } from '../types/reading'
import type { Operation } from '../types/operation'
import type { Mlf } from '../types/mlf'
import type { Tasting } from '../types/tasting'
import type { RackingConflict } from '../types/racking'
import { RackingConflictError } from '../types/racking'
import { nowIso } from './uuid'
import { seedDatabase } from './seed'

/** 数据库名 */
export const DB_NAME = 'gbwinetank-db'

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 2

/** 行结构修订号，便于后续按行迁移 */
export const ROW_REVISION = 2

/** 带时间戳与修订号的持久化实体 */
export interface Revisioned {
  revision: number
  createdAt: number
  updatedAt: number
}

export type ParcelRow = Parcel & Revisioned
export type TankRow = Tank & Revisioned
export type BatchRow = Batch & Revisioned
export type SegmentRow = BatchSegment & Revisioned
export type ReadingRow = Reading & Revisioned
export type OperationRow = Operation & Revisioned
export type MlfRow = Mlf & Revisioned
export type TastingRow = Tasting & Revisioned

class GbWineTankDatabase extends Dexie {
  parcels!: Table<ParcelRow, string>
  tanks!: Table<TankRow, string>
  batches!: Table<BatchRow, string>
  segments!: Table<SegmentRow, string>
  readings!: Table<ReadingRow, string>
  operations!: Table<OperationRow, string>
  mlfs!: Table<MlfRow, string>
  tastings!: Table<TastingRow, string>

  constructor() {
    super(DB_NAME)

    // v1：历史结构（7 张表，无批次段）
    this.version(1)
      .stores({
        parcels: 'id, name, variety, aspect, updatedAt',
        tanks: 'id, code, material, tempControl, state, updatedAt',
        batches: 'id, parcelId, tankId, state, harvestDate, updatedAt',
        readings: 'id, batchId, date, updatedAt',
        operations: 'id, batchId, type, state, date, seq, updatedAt',
        mlfs: 'id, batchId, state, updatedAt',
        tastings: 'id, batchId, date, verdict, updatedAt'
      })
      .upgrade(async (tx) => {
        // v1 结构迁移：为历史行补齐行修订号与时间戳
        const tableNames = ['parcels', 'tanks', 'batches', 'readings', 'operations', 'mlfs', 'tastings']
        for (const name of tableNames) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              row.revision = 1
              if (typeof row.createdAt !== 'number') row.createdAt = Date.now()
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt
            })
        }
      })

    // v2：新增批次段表，子表加 segmentId 索引；旧批次自动补出唯一整段
    this.version(2)
      .stores({
        parcels: 'id, name, variety, aspect, updatedAt',
        tanks: 'id, code, material, tempControl, state, updatedAt',
        batches: 'id, parcelId, tankId, state, harvestDate, updatedAt',
        segments: 'id, batchId, tankId, seq, updatedAt',
        readings: 'id, batchId, segmentId, date, updatedAt',
        operations: 'id, batchId, segmentId, type, state, date, seq, updatedAt',
        mlfs: 'id, batchId, segmentId, state, updatedAt',
        tastings: 'id, batchId, date, verdict, updatedAt'
      })
      .upgrade(async (tx) => {
        const stamp = Date.now()
        const batchRows = await tx.table<BatchRow, string>('batches').toArray()

        // 1) 每个旧批次补出唯一整段，量等于批次入罐量，绑定批次原罐
        const wholeSegments: SegmentRow[] = batchRows.map((batch) => ({
          id: wholeSegmentId(batch.id),
          batchId: batch.id,
          tankId: batch.tankId ?? '',
          volumeL: batch.volumeL,
          seq: WHOLE_SEGMENT_SEQ,
          revision: ROW_REVISION,
          createdAt: batch.createdAt ?? stamp,
          updatedAt: stamp
        }))
        await tx.table<SegmentRow, string>('segments').bulkPut(wholeSegments)

        // 2) 子表回填 segmentId 到整段（旧读数 / 苹乳 / 作业全挂在唯一整段上）
        const wholeByBatch = new Map(batchRows.map((batch) => [batch.id, wholeSegmentId(batch.id)]))
        const backfill = async (tableName: string): Promise<void> => {
          await tx
            .table(tableName)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              if (typeof row.segmentId !== 'string' || row.segmentId === '') {
                const fallback = wholeByBatch.get(String(row.batchId))
                if (fallback) row.segmentId = fallback
              }
              row.revision = ROW_REVISION
              if (typeof row.updatedAt !== 'number') row.updatedAt = stamp
            })
        }
        await backfill('readings')
        await backfill('operations')
        await backfill('mlfs')

        // 3) 作业补倒罐去向字段
        await tx
          .table('operations')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.targetTankId !== 'string') row.targetTankId = ''
            if (typeof row.transferVolumeL !== 'number') row.transferVolumeL = 0
          })
      })
  }
}

export const db = new GbWineTankDatabase()

/**
 * 修复缺失的批次段与子表 segmentId（升级后 / 导入旧备份后兜底）。
 * - 缺段的批次补出唯一整段，量等于入罐量
 * - 子表缺 segmentId 的回填到该批次唯一段；多段批次无法判定时挂第一段
 * - 段量合计不等于入罐量时，差额并入首段（保证守恒不变量）
 */
export async function repairSegments(): Promise<void> {
  await db.transaction(
    'rw',
    [db.batches, db.segments, db.readings, db.operations, db.mlfs],
    async () => {
      const now = Date.now()
      const batches = await db.batches.toArray()
      const segments = await db.segments.toArray()
      const segmentsByBatch = new Map<string, SegmentRow[]>()
      for (const segment of segments) {
        const list = segmentsByBatch.get(segment.batchId) ?? []
        list.push(segment)
        segmentsByBatch.set(segment.batchId, list)
      }

      for (const batch of batches) {
        let list = segmentsByBatch.get(batch.id) ?? []
        if (list.length === 0) {
          const whole: SegmentRow = {
            id: wholeSegmentId(batch.id),
            batchId: batch.id,
            tankId: batch.tankId ?? '',
            volumeL: batch.volumeL,
            seq: WHOLE_SEGMENT_SEQ,
            revision: ROW_REVISION,
            createdAt: batch.createdAt ?? now,
            updatedAt: now
          }
          await db.segments.put(whole)
          list = [whole]
          segmentsByBatch.set(batch.id, list)
        }

        // 守恒修复：段量合计必须等于入罐量，差额并入首段
        const total = list.reduce((sum, segment) => sum + segment.volumeL, 0)
        if (total !== batch.volumeL && list[0]) {
          const ordered = [...list].sort((a, b) => a.seq - b.seq)
          await db.segments.update(ordered[0].id, {
            volumeL: ordered[0].volumeL + (batch.volumeL - total),
            updatedAt: now
          } as never)
        }

        const firstId = [...list].sort((a, b) => a.seq - b.seq)[0]?.id ?? list[0]!.id
        const backfillRow = (row: { batchId?: unknown; segmentId?: unknown }): string | null => {
          if (typeof row.segmentId === 'string' && list.some((segment) => segment.id === row.segmentId)) {
            return null
          }
          return typeof row.batchId === 'string' ? firstId : null
        }
        const children = await Promise.all([
          db.readings.where('batchId').equals(batch.id).toArray(),
          db.operations.where('batchId').equals(batch.id).toArray(),
          db.mlfs.where('batchId').equals(batch.id).toArray()
        ])
        for (const row of children[0]) {
          const next = backfillRow(row)
          if (next) await db.readings.update(row.id, { segmentId: next, updatedAt: now } as never)
        }
        for (const row of children[1]) {
          const patch: Record<string, unknown> = { updatedAt: now }
          const next = backfillRow(row)
          if (next) patch.segmentId = next
          if (typeof row.targetTankId !== 'string') patch.targetTankId = ''
          if (typeof row.transferVolumeL !== 'number') patch.transferVolumeL = 0
          await db.operations.update(row.id, patch as never)
        }
        for (const row of children[2]) {
          const next = backfillRow(row)
          if (next) await db.mlfs.update(row.id, { segmentId: next, updatedAt: now } as never)
        }
      }
    }
  )
}

/** 打开数据库：首次使用时灌入演示数据（幂等：表非空不播）；导入旧备份后修复段 */
export async function initDatabase(): Promise<void> {
  await db.open()
  if ((await db.parcels.count()) === 0) {
    await seedDatabase()
  }
  await repairSegments()
}

/* ------------------------------ 地块 ------------------------------ */

export async function listParcels(): Promise<ParcelRow[]> {
  const rows = await db.parcels.toArray()
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
}

export async function putParcel(row: ParcelRow): Promise<void> {
  await db.parcels.put(row)
}

export async function updateParcel(id: string, patch: Partial<Parcel>): Promise<void> {
  await db.parcels.update(id, { ...patch, updatedAt: Date.now() } as never)
}

/** 删除地块：级联删除其下批次、批次段及批次的读数/作业/苹乳/品评，并释放占用的罐位 */
export async function removeParcel(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.parcels, db.batches, db.segments, db.readings, db.operations, db.mlfs, db.tastings, db.tanks],
    async () => {
      const batches = await db.batches.where('parcelId').equals(id).toArray()
      for (const batch of batches) {
        await cascadeRemoveBatch(batch.id)
      }
      await db.parcels.delete(id)
    }
  )
}

/* ------------------------------ 发酵罐 ------------------------------ */

export async function listTanks(): Promise<TankRow[]> {
  const rows = await db.tanks.toArray()
  return rows.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
}

export async function putTank(row: TankRow): Promise<void> {
  await db.tanks.put(row)
}

export async function updateTank(id: string, patch: Partial<Tank>): Promise<void> {
  await db.tanks.update(id, { ...patch, updatedAt: Date.now() } as never)
}

export async function removeTank(id: string): Promise<void> {
  const activeSegments = await db.segments
    .where('tankId')
    .equals(id)
    .filter((segment) => segment.volumeL > 0)
    .count()
  if (activeSegments > 0) {
    throw new Error('该罐仍有在罐批次段，请先出罐或倒罐改绑其它罐位')
  }
  await db.transaction('rw', db.tanks, db.segments, async () => {
    await db.segments.where('tankId').equals(id).modify({ tankId: '', updatedAt: Date.now() })
    await db.tanks.delete(id)
  })
}

/* ------------------------------ 批次段 ------------------------------ */

export async function listSegments(): Promise<SegmentRow[]> {
  const rows = await db.segments.toArray()
  return rows.sort((a, b) => a.seq - b.seq)
}

export async function putSegment(row: SegmentRow): Promise<void> {
  await db.segments.put(row)
}

export async function listSegmentsOfBatch(batchId: string): Promise<SegmentRow[]> {
  const rows = await db.segments.where('batchId').equals(batchId).toArray()
  return rows.sort((a, b) => a.seq - b.seq)
}

/**
 * 某个罐当前的在罐占用量（L）：只统计未出罐批次、且量大于 0 的段。
 * 同批次的多段若在同一罐内合并计容，但倒罐拆分时同批酒不会回到同一罐。
 */
export async function tankOccupiedVolume(
  tankId: string,
  tx?: { segments: Table<SegmentRow, string>; batches: Table<BatchRow, string> }
): Promise<number> {
  const segTable = tx?.segments ?? db.segments
  const batchTable = tx?.batches ?? db.batches
  const segments = await segTable.where('tankId').equals(tankId).toArray()
  let occupied = 0
  for (const segment of segments) {
    if (segment.volumeL <= 0) continue
    const batch = await batchTable.get(segment.batchId)
    if (batch && batch.state !== '已出罐') occupied += segment.volumeL
  }
  return occupied
}

/** 某罐剩余可用容量（L） */
export async function tankFreeVolume(tankId: string): Promise<{ capacityL: number; occupiedL: number; freeL: number }> {
  const tank = await db.tanks.get(tankId)
  if (!tank) throw new Error('发酵罐不存在')
  const occupiedL = await tankOccupiedVolume(tankId)
  return { capacityL: tank.capacityL, occupiedL, freeL: tank.capacityL - occupiedL }
}

/* ------------------------------ 倒罐（批次段拆分） ------------------------------ */

export interface RackingExecution {
  /** 关联的倒罐作业 id（成功后置为已完成）；为空则只执行段拆分 */
  operationId: string | null
  batchId: string
  date: string
  durationMin: number
  operator: string
  moves: Array<{ segmentId: string; targetTankId: string; volumeL: number }>
  /** 打开草稿时的快照时间戳：段已被先到者改动则 CAS 失效 */
  baseVersion: number
}

/**
 * 倒罐开工：每次只转指定段的指定量；段量合计始终等于批次入罐量。
 * - 目标罐容量不足 → 拒绝开工，抛出 RackingConflictError 并列出每个冲突罐的差量
 * - baseVersion 之后段已被其它平板改动 → 段冲突（segmentTaken）
 * - 全部通过才在单事务内提交：整段转走则改绑，部分转走则拆出新段
 * IndexedDB 事务串行化保证：几台平板同时开工时先到者占住目标罐容，后到者失败。
 */
export async function executeRacking(execution: RackingExecution): Promise<void> {
  const { moves } = execution
  if (moves.length === 0) throw new Error('请至少指定一段要转的酒')

  await db.transaction(
    'rw',
    [db.segments, db.batches, db.tanks, db.operations],
    async () => {
      const conflicts: RackingConflict[] = []
      const now = Date.now()

      // 预取并校验每个移动的转出段
      interface Planned {
        move: RackingExecution['moves'][number]
        source: SegmentRow
        sourceTaken: boolean
      }
      const planned: Planned[] = []
      for (const move of moves) {
        if (!(move.volumeL > 0)) throw new Error('倒罐量必须大于 0')
        if (!move.targetTankId) throw new Error('请选择目标发酵罐')
        const source = await db.segments.get(move.segmentId)
        if (!source) {
          conflicts.push({
            segmentId: move.segmentId,
            tankId: move.targetTankId,
            tankCode: (await db.tanks.get(move.targetTankId))?.code ?? move.targetTankId,
            requestedL: move.volumeL,
            availableL: 0,
            shortfallL: move.volumeL,
            segmentTaken: true,
            occupiedBy: '转出段不存在（可能已被其它平板倒走）'
          })
          continue
        }
        if (source.batchId !== execution.batchId) throw new Error('不能跨批次倒罐')
        if (move.volumeL > source.volumeL) {
          throw new Error(`段 ${source.id} 只有 ${source.volumeL}L，不能转出 ${move.volumeL}L`)
        }
        const sourceTaken = source.updatedAt > execution.baseVersion
        planned.push({ move, source, sourceTaken })
      }

      // 目标罐容量校验：同一草稿内先占先算，同批次合罐不重复计
      const tentative = new Map<string, number>()
      for (const item of planned) {
        const { move, sourceTaken } = item
        if (move.targetTankId === item.source.tankId) {
          throw new Error('目标罐与转出罐相同，无需倒罐')
        }
        const tank = await db.tanks.get(move.targetTankId)
        if (!tank) throw new Error('目标发酵罐不存在')

        const segmentsThere = await db.segments.where('tankId').equals(move.targetTankId).toArray()
        let occupiedL = 0
        for (const segment of segmentsThere) {
          if (segment.volumeL <= 0) continue
          const batch = await db.batches.get(segment.batchId)
          if (!batch || batch.state === '已出罐') continue
          if (segment.batchId === execution.batchId) continue
          occupiedL += segment.volumeL
        }
        occupiedL += tentative.get(move.targetTankId) ?? 0

        const freeL = tank.capacityL - occupiedL
        const shortfallL = Math.max(0, move.volumeL - freeL)
        const targetBusy = tank.state === '清洗中'
        if (shortfallL > 0 || targetBusy || sourceTaken) {
          const otherBatches = segmentsThere
            .filter((segment) => segment.batchId !== execution.batchId && segment.volumeL > 0)
            .map((segment) => segment.batchId)
          conflicts.push({
            segmentId: move.segmentId,
            tankId: move.targetTankId,
            tankCode: tank.code,
            requestedL: move.volumeL,
            availableL: targetBusy ? 0 : freeL,
            shortfallL: targetBusy ? move.volumeL : shortfallL,
            segmentTaken: sourceTaken,
            occupiedBy:
              otherBatches.length > 0
                ? `已被先到的批次 ${otherBatches.join('、')} 占用 ${occupiedL - (tentative.get(move.targetTankId) ?? 0)}L`
                : sourceTaken
                  ? '本段已被其它平板先倒走或改动'
                  : '罐正在清洗中'
          })
        }
        tentative.set(move.targetTankId, (tentative.get(move.targetTankId) ?? 0) + move.volumeL)
      }

      if (conflicts.length > 0) {
        // 抛出后整个事务回滚：先到者已占住的罐容不受影响，后到者保留草稿重试
        throw new RackingConflictError(conflicts)
      }

      // 提交：逐个执行段拆分 / 改绑
      const affectedTanks = new Set<string>()
      for (const { move, source } of planned) {
        if (move.volumeL === source.volumeL) {
          // 整段转走：直接改绑目标罐，保留读数 / 苹乳 / 作业挂在本段
          await db.segments.update(source.id, { tankId: move.targetTankId, updatedAt: now } as never)
        } else {
          // 部分转出：原段缩量保留，新建一段绑定目标罐（段量合计不变）
          await db.segments.update(source.id, {
            volumeL: source.volumeL - move.volumeL,
            updatedAt: now
          } as never)
          const existing = await db.segments.where('batchId').equals(source.batchId).toArray()
          const nextSeq = existing.reduce((max, segment) => Math.max(max, segment.seq), 0) + 1
          const newSegment: SegmentRow = {
            id: createSegmentId(source.batchId),
            batchId: source.batchId,
            tankId: move.targetTankId,
            volumeL: move.volumeL,
            seq: nextSeq,
            revision: ROW_REVISION,
            createdAt: now,
            updatedAt: now
          }
          await db.segments.put(newSegment)
        }
        affectedTanks.add(source.tankId)
        affectedTanks.add(move.targetTankId)
      }

      // 批次 tankId 同步到首段所在罐（兼容旧展示）；段才是罐绑定的唯一事实源
      if (planned.length > 0) {
        const batchId = planned[0]!.source.batchId
        const batchSegments = (await db.segments.where('batchId').equals(batchId).toArray()).sort(
          (a, b) => a.seq - b.seq
        )
        await db.batches.update(batchId, { tankId: batchSegments[0]?.tankId ?? '', updatedAt: now } as never)
      }

      // 关联作业置为已完成并回写最近作业时间 + 实际倒罐去向
      if (execution.operationId) {
        const first = planned[0]
        await db.operations.update(execution.operationId, {
          state: '已完成',
          segmentId: first?.source.id,
          targetTankId: first?.move.targetTankId ?? '',
          transferVolumeL: planned.reduce((sum, item) => sum + item.move.volumeL, 0),
          updatedAt: now
        } as never)
        if (first) {
          await db.batches.update(first.source.batchId, { lastOperationAt: nowIso(), updatedAt: now } as never)
        }
      }

      for (const tankId of affectedTanks) {
        await syncTankState(tankId)
      }
    }
  )
}

/* ------------------------------ 入罐批次 ------------------------------ */

export async function listBatches(): Promise<BatchRow[]> {
  const rows = await db.batches.toArray()
  return rows.sort((a, b) => b.harvestDate.localeCompare(a.harvestDate))
}

export async function putBatch(row: BatchRow): Promise<void> {
  await db.batches.put(row)
}

export async function updateBatch(id: string, patch: Partial<Batch>): Promise<void> {
  await db.batches.update(id, { ...patch, updatedAt: Date.now() } as never)
}

/** 内部级联删除：清掉批次的全部段与子表数据，并同步罐位状态 */
async function cascadeRemoveBatch(batchId: string): Promise<void> {
  const segments = await db.segments.where('batchId').equals(batchId).toArray()
  const tankIds = new Set(segments.map((segment) => segment.tankId).filter(Boolean))
  await db.readings.where('batchId').equals(batchId).delete()
  await db.operations.where('batchId').equals(batchId).delete()
  await db.mlfs.where('batchId').equals(batchId).delete()
  await db.tastings.where('batchId').equals(batchId).delete()
  await db.segments.where('batchId').equals(batchId).delete()
  await db.batches.delete(batchId)
  for (const tankId of tankIds) {
    await syncTankState(tankId)
  }
}

export async function removeBatch(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.batches, db.segments, db.readings, db.operations, db.mlfs, db.tastings, db.tanks],
    async () => {
      await cascadeRemoveBatch(id)
    }
  )
}

/**
 * 按段占用同步罐位状态：仍有在罐段 → 在用；否则按原状态回到空闲。
 * 清洗中状态不会被批次动作覆盖（清洗中的罐本来就不允许进酒）。
 */
export async function syncTankState(tankId: string): Promise<void> {
  if (!tankId) return
  const occupied = await tankOccupiedVolume(tankId)
  if (occupied > 0) {
    await db.tanks.update(tankId, { state: '在用', updatedAt: Date.now() } as never)
    return
  }
  const tank = await db.tanks.get(tankId)
  if (tank && tank.state === '在用') {
    await db.tanks.update(tankId, { state: '空闲', updatedAt: Date.now() } as never)
  }
}

/** 出罐：批次置为已出罐、段释放罐位并归档 */
export async function shipBatch(id: string): Promise<void> {
  await db.transaction(
    'rw',
    db.batches,
    db.segments,
    db.tanks,
    async () => {
      const batch = await db.batches.get(id)
      if (!batch) throw new Error('批次不存在')
      const segments = await db.segments.where('batchId').equals(id).toArray()
      const tankIds = new Set(segments.map((segment) => segment.tankId).filter(Boolean))
      for (const segment of segments) {
        if (segment.tankId) {
          await db.segments.update(segment.id, { tankId: '', updatedAt: Date.now() } as never)
        }
      }
      await db.batches.update(id, { tankId: '', state: '已出罐', updatedAt: Date.now() } as never)
      for (const tankId of tankIds) {
        await syncTankState(tankId)
      }
    }
  )
}

/**
 * 校验罐位是否可以接收指定体积的酒。
 * - 清洗中的罐不可用
 * - 容量不足时拒绝并返回差量（shortfallL > 0）
 * 返回 { freeL, shortfallL }，由调用方决定是否放行。
 */
export async function assertTankCapacity(
  tankId: string,
  volumeL: number,
  opts: { sameBatchId?: string | null } = {}
): Promise<{ capacityL: number; occupiedL: number; freeL: number; shortfallL: number }> {
  const tank = await db.tanks.get(tankId)
  if (!tank) throw new Error('发酵罐不存在')
  if (tank.state === '清洗中') throw new Error(`罐 ${tank.code} 正在清洗中，暂不可分配`)
  const segments = await db.segments.where('tankId').equals(tankId).toArray()
  let occupiedL = 0
  for (const segment of segments) {
    if (segment.volumeL <= 0) continue
    const batch = await db.batches.get(segment.batchId)
    if (!batch || batch.state === '已出罐') continue
    // 同批次的酒合罐时，该批次已在此罐的量不计入冲突占用
    if (opts.sameBatchId && segment.batchId === opts.sameBatchId) continue
    occupiedL += segment.volumeL
  }
  const freeL = tank.capacityL - occupiedL
  const shortfallL = Math.max(0, volumeL - freeL)
  return { capacityL: tank.capacityL, occupiedL, freeL, shortfallL }
}

/** 校验罐位是否可以整段分配给指定批次（入罐登记用：容量必须放得下整批） */
export async function assertTankAssignable(
  tankId: string,
  batchId: string | null,
  volumeL?: number
): Promise<void> {
  const needL = volumeL ?? 0
  const result = await assertTankCapacity(tankId, needL, { sameBatchId: batchId ?? undefined })
  const tank = await db.tanks.get(tankId)
  if (needL > 0 && result.shortfallL > 0) {
    throw new Error(`罐 ${tank?.code ?? tankId} 容量不足：需 ${needL}L，仅剩 ${result.freeL}L，差 ${result.shortfallL}L`)
  }
}

/* ------------------------------ 发酵读数 ------------------------------ */

export async function listReadings(): Promise<ReadingRow[]> {
  const rows = await db.readings.toArray()
  return rows.sort((a, b) => a.date.localeCompare(b.date))
}

export async function putReading(row: ReadingRow): Promise<void> {
  await db.readings.put(row)
}

export async function updateReading(id: string, patch: Partial<Reading>): Promise<void> {
  await db.readings.update(id, { ...patch, updatedAt: Date.now() } as never)
}

export async function removeReading(id: string): Promise<void> {
  await db.readings.delete(id)
}

/* -------------------------------- 作业 -------------------------------- */

export async function listOperations(): Promise<OperationRow[]> {
  const rows = await db.operations.toArray()
  return rows.sort((a, b) => a.seq - b.seq || a.date.localeCompare(b.date))
}

export async function putOperation(row: OperationRow): Promise<void> {
  await db.operations.put(row)
}

export async function updateOperation(id: string, patch: Partial<Operation>): Promise<void> {
  await db.operations.update(id, { ...patch, updatedAt: Date.now() } as never)
}

export async function removeOperation(id: string): Promise<void> {
  await db.operations.delete(id)
}

/** 批量写回拖拽后的作业顺序 */
export async function reorderOperations(orderedIds: string[]): Promise<void> {
  await db.transaction('rw', db.operations, async () => {
    for (let index = 0; index < orderedIds.length; index += 1) {
      await db.operations.update(orderedIds[index], { seq: index + 1, updatedAt: Date.now() } as never)
    }
  })
}

/** 作业完成：置为已完成并回写批次的最近作业时间 */
export async function completeOperation(id: string): Promise<void> {
  await db.transaction('rw', db.operations, db.batches, async () => {
    const operation = await db.operations.get(id)
    if (!operation) throw new Error('作业不存在')
    await db.operations.update(id, { state: '已完成', updatedAt: Date.now() } as never)
    await db.batches.update(operation.batchId, { lastOperationAt: nowIso(), updatedAt: Date.now() } as never)
  })
}

/** 某个批次现有作业的最大序号 */
export async function nextOperationSeq(batchId: string): Promise<number> {
  const rows = await db.operations.where('batchId').equals(batchId).toArray()
  return rows.reduce((max, row) => Math.max(max, row.seq), 0) + 1
}

/* ------------------------------ 苹乳发酵 ------------------------------ */

export async function listMlfs(): Promise<MlfRow[]> {
  return db.mlfs.toArray()
}

export async function putMlf(row: MlfRow): Promise<void> {
  await db.mlfs.put(row)
}

export async function updateMlf(id: string, patch: Partial<Mlf>): Promise<void> {
  await db.mlfs.update(id, { ...patch, updatedAt: Date.now() } as never)
}

export async function removeMlf(id: string): Promise<void> {
  await db.mlfs.delete(id)
}

/* ------------------------------ 品评调配 ------------------------------ */

export async function listTastings(): Promise<TastingRow[]> {
  const rows = await db.tastings.toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function putTasting(row: TastingRow): Promise<void> {
  await db.tastings.put(row)
}

export async function updateTasting(id: string, patch: Partial<Tasting>): Promise<void> {
  await db.tastings.update(id, { ...patch, updatedAt: Date.now() } as never)
}

export async function removeTasting(id: string): Promise<void> {
  await db.tastings.delete(id)
}

/* --------------------------- 整库导入导出 --------------------------- */

export interface DatabaseSnapshot {
  name: string
  schemaVersion: number
  exportedAt: string
  parcels: Parcel[]
  tanks: Tank[]
  batches: Batch[]
  /** 旧备份可能没有段表，导入时自动补出唯一整段 */
  segments?: BatchSegment[]
  readings: Reading[]
  operations: Operation[]
  mlfs: Mlf[]
  tastings: Tasting[]
}

function stripRow<T extends Revisioned>(row: T): Omit<T, keyof Revisioned> {
  const copy = { ...row } as Record<string, unknown>
  delete copy.revision
  delete copy.createdAt
  delete copy.updatedAt
  return copy as Omit<T, keyof Revisioned>
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [parcels, tanks, batches, segments, readings, operations, mlfs, tastings] = await Promise.all([
    db.parcels.toArray(),
    db.tanks.toArray(),
    db.batches.toArray(),
    db.segments.toArray(),
    db.readings.toArray(),
    db.operations.toArray(),
    db.mlfs.toArray(),
    db.tastings.toArray()
  ])
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    parcels: parcels.map(stripRow),
    tanks: tanks.map(stripRow),
    batches: batches.map(stripRow),
    segments: segments.map(stripRow),
    readings: readings.map(stripRow),
    operations: operations.map(stripRow),
    mlfs: mlfs.map(stripRow),
    tastings: tastings.map(stripRow)
  }
}

function stamp<T>(row: T): T & Revisioned {
  return { ...row, revision: ROW_REVISION, createdAt: Date.now(), updatedAt: Date.now() }
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [db.parcels, db.tanks, db.batches, db.segments, db.readings, db.operations, db.mlfs, db.tastings],
    async () => {
      await Promise.all([
        db.parcels.clear(),
        db.tanks.clear(),
        db.batches.clear(),
        db.segments.clear(),
        db.readings.clear(),
        db.operations.clear(),
        db.mlfs.clear(),
        db.tastings.clear()
      ])
      await db.parcels.bulkPut(snapshot.parcels.map(stamp))
      await db.tanks.bulkPut(snapshot.tanks.map(stamp))
      await db.batches.bulkPut(snapshot.batches.map(stamp))
      if (snapshot.segments && snapshot.segments.length > 0) {
        await db.segments.bulkPut(snapshot.segments.map(stamp))
      }
      await db.readings.bulkPut(snapshot.readings.map(stamp))
      await db.operations.bulkPut(snapshot.operations.map(stamp))
      await db.mlfs.bulkPut(snapshot.mlfs.map(stamp))
      await db.tastings.bulkPut(snapshot.tastings.map(stamp))
    }
  )
  // 旧备份（无段表 / 子表无 segmentId）导入后自动补出唯一整段并回填
  await repairSegments()
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.parcels, db.tanks, db.batches, db.segments, db.readings, db.operations, db.mlfs, db.tastings],
    async () => {
      await Promise.all([
        db.parcels.clear(),
        db.tanks.clear(),
        db.batches.clear(),
        db.segments.clear(),
        db.readings.clear(),
        db.operations.clear(),
        db.mlfs.clear(),
        db.tastings.clear()
      ])
    }
  )
  await seedDatabase()
  await repairSegments()
}

/** 各表行数统计，供页脚与概览展示 */
export async function countAll(): Promise<Record<string, number>> {
  const [parcels, tanks, batches, segments, readings, operations, mlfs, tastings] = await Promise.all([
    db.parcels.count(),
    db.tanks.count(),
    db.batches.count(),
    db.segments.count(),
    db.readings.count(),
    db.operations.count(),
    db.mlfs.count(),
    db.tastings.count()
  ])
  return { parcels, tanks, batches, segments, readings, operations, mlfs, tastings }
}
