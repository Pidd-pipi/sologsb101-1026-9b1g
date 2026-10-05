/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名 gbwinetank-db，数据结构版本号 version(1) 与 upgrade() 迁移逻辑
 * - 地块 / 发酵罐 / 入罐批次 / 发酵读数 / 作业 / 苹乳 / 品评 七张表分表存储
 * - 首次打开自动播种互相引用的演示数据，保证每个页面打开都有内容
 * - 纯前端应用：不依赖任何后端或数据库服务
 */
import Dexie, { type Table } from 'dexie'
import type { Parcel } from '../types/parcel'
import type { Tank } from '../types/tank'
import type { Batch } from '../types/batch'
import type { Segment, RackingDraft, ConflictTank } from '../types/segment'
import type { Reading } from '../types/reading'
import type { Operation } from '../types/operation'
import type { Mlf } from '../types/mlf'
import type { Tasting } from '../types/tasting'
import { nowIso } from './uuid'
import { createId } from './uuid'
import { seedDatabase } from './seed'

/** 数据库名 */
export const DB_NAME = 'gbwinetank-db'

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 2

/** 行结构修订号，便于后续按行迁移 */
export const ROW_REVISION = 1

/** 带时间戳与修订号的持久化实体 */
export interface Revisioned {
  revision: number
  createdAt: number
  updatedAt: number
}

export type ParcelRow = Parcel & Revisioned
export type TankRow = Tank & Revisioned
export type BatchRow = Batch & Revisioned
export type SegmentRow = Segment & Revisioned
export type ReadingRow = Reading & Revisioned
export type OperationRow = Operation & Revisioned
export type MlfRow = Mlf & Revisioned
export type TastingRow = Tasting & Revisioned

/**
 * 并发保存冲突：先到者已占住目标段（修订号变化），或目标罐容量不足。
 * 调用方保留草稿（draft），列出冲突罐（conflicts）与差量，供重试。
 */
export class SegmentConflictError extends Error {
  conflicts: ConflictTank[]
  changedSegmentIds: string[]
  draft: RackingDraft
  constructor(
    message: string,
    opts: { conflicts: ConflictTank[]; changedSegmentIds: string[]; draft: RackingDraft }
  ) {
    super(message)
    this.name = 'SegmentConflictError'
    this.conflicts = opts.conflicts
    this.changedSegmentIds = opts.changedSegmentIds
    this.draft = opts.draft
  }
}

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

    // v1：七张表 + 为历史行补齐行修订号与时间戳
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
        // 结构迁移：为历史行补齐行修订号与时间戳；新建库时各表为空，迁移天然幂等
        const tableNames = ['parcels', 'tanks', 'batches', 'readings', 'operations', 'mlfs', 'tastings']
        for (const name of tableNames) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              row.revision = ROW_REVISION
              if (typeof row.createdAt !== 'number') row.createdAt = Date.now()
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt
            })
        }
      })

    // v2：新增批次段表；读数 / 作业 / 苹乳增加 segmentId 索引。
    // 升级时为每个批次补出唯一的整段（整段量 = 批次入罐量），并把历史记录认到该段。
    this.version(2)
      .stores({
        segments: 'id, batchId, tankId, seq, updatedAt',
        readings: 'id, batchId, segmentId, date, updatedAt',
        operations: 'id, batchId, segmentId, type, state, date, seq, updatedAt',
        mlfs: 'id, batchId, segmentId, state, updatedAt'
      })
      .upgrade(async (tx) => {
        const batches = await tx.table('batches').toArray()
        const now = Date.now()
        const batchSegment = new Map<string, string>()
        for (const batch of batches) {
          const segId = `seg-legacy-${batch.id as string}`
          await tx.table('segments').put({
            id: segId,
            batchId: batch.id as string,
            tankId: (batch.tankId as string) ?? '',
            volumeL: batch.volumeL as number,
            seq: 1,
            fromSegmentId: null,
            revision: ROW_REVISION,
            createdAt: now,
            updatedAt: now
          })
          batchSegment.set(batch.id as string, segId)
        }
        for (const name of ['readings', 'operations', 'mlfs']) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              const segId = batchSegment.get(row.batchId as string)
              if (segId) row.segmentId = segId
            })
        }
      })
  }
}

export const db = new GbWineTankDatabase()

/** 打开数据库：首次使用时灌入演示数据（幂等：表非空不播） */
export async function initDatabase(): Promise<void> {
  await db.open()
  if ((await db.parcels.count()) === 0) {
    await seedDatabase()
  }
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

/** 删除地块：级联删除其下批次及批次的读数/作业/苹乳/品评，并释放占用的罐位 */
export async function removeParcel(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.parcels, db.batches, db.readings, db.operations, db.mlfs, db.tastings, db.tanks],
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
  const active = await db.segments
    .where('tankId')
    .equals(id)
    .filter((s) => s.volumeL > 0)
    .count()
  if (active > 0) {
    throw new Error('该罐仍有在罐段，请先倒罐转出或出罐后再删除')
  }
  await db.transaction('rw', db.tanks, db.segments, async () => {
    await db.segments.where('tankId').equals(id).modify({ tankId: '', updatedAt: Date.now() })
    await db.tanks.delete(id)
  })
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

/** 内部级联删除：清掉批次下属全部子表数据（含批次段） */
async function cascadeRemoveBatch(batchId: string): Promise<void> {
  await db.segments.where('batchId').equals(batchId).delete()
  await db.readings.where('batchId').equals(batchId).delete()
  await db.operations.where('batchId').equals(batchId).delete()
  await db.mlfs.where('batchId').equals(batchId).delete()
  await db.tastings.where('batchId').equals(batchId).delete()
  const batch = await db.batches.get(batchId)
  if (batch && batch.tankId) {
    await db.tanks.update(batch.tankId, { state: '空闲', updatedAt: Date.now() } as never)
  }
  await db.batches.delete(batchId)
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

/** 出罐：批次置为已出罐，释放全部段占用的罐位并清空段的罐位绑定 */
export async function shipBatch(id: string): Promise<void> {
  await db.transaction('rw', [db.batches, db.segments, db.tanks], async () => {
    const batch = await db.batches.get(id)
    if (!batch) throw new Error('批次不存在')
    const segs = await db.segments.where('batchId').equals(id).toArray()
    for (const seg of segs) {
      if (seg.tankId) {
        await db.tanks.update(seg.tankId, { state: '空闲', updatedAt: Date.now() } as never)
      }
      await db.segments.update(seg.id, { tankId: '', updatedAt: Date.now() } as never)
    }
    if (batch.tankId) {
      await db.tanks.update(batch.tankId, { state: '空闲', updatedAt: Date.now() } as never)
    }
    await db.batches.update(id, { state: '已出罐', updatedAt: Date.now() } as never)
  })
}

/** 校验罐位是否可分配给指定批次：罐内不得有其它在罐段占用 */
export async function assertTankAssignable(tankId: string, batchId: string | null): Promise<void> {
  const tank = await db.tanks.get(tankId)
  if (!tank) throw new Error('发酵罐不存在')
  if (tank.state === '清洗中') throw new Error(`罐 ${tank.code} 正在清洗中，暂不可分配`)
  const occupants = await db.segments
    .where('tankId')
    .equals(tankId)
    .filter((s) => s.batchId !== batchId && s.volumeL > 0)
    .toArray()
  if (occupants.length > 0) {
    const codes = await Promise.all(
      occupants.map(async (s) => (await db.batches.get(s.batchId))?.id ?? s.batchId)
    )
    throw new Error(`罐 ${tank.code} 已被在罐段（批次 ${codes.join('、')}）占用，禁止重复分配`)
  }
}

/* ------------------------------ 批次段 ------------------------------ */

export async function listSegments(): Promise<SegmentRow[]> {
  return db.segments.toArray()
}

export async function listSegmentsByBatch(batchId: string): Promise<SegmentRow[]> {
  const rows = await db.segments.where('batchId').equals(batchId).toArray()
  return rows.sort((a, b) => a.seq - b.seq)
}

export async function putSegment(row: SegmentRow): Promise<void> {
  await db.segments.put(row)
}

export async function updateSegment(id: string, patch: Partial<Segment>): Promise<void> {
  await db.segments.update(id, { ...patch, updatedAt: Date.now() } as never)
}

/** 某批次现有段的最大序号 +1 */
export async function nextSegmentSeq(batchId: string): Promise<number> {
  const rows = await db.segments.where('batchId').equals(batchId).toArray()
  return rows.reduce((max, row) => Math.max(max, row.seq), 0) + 1
}

/** 批次各段量合计（应恒等于批次入罐量） */
export async function sumSegmentVolume(batchId: string): Promise<number> {
  const rows = await db.segments.where('batchId').equals(batchId).toArray()
  return rows.reduce((sum, row) => sum + row.volumeL, 0)
}

/**
 * 倒罐：把来源段的指定量转到一个或多个目标罐。
 * - 容量校验：目标罐现有占用 + 转入量 > 容量时拒绝开工，抛出含差量的冲突；
 * - 乐观锁：来源段修订号与草稿不一致（先到者已改动）时抛出冲突；
 * - 冲突时不写入任何段，调用方保留草稿并重试。
 */
export async function rackSegments(draft: RackingDraft): Promise<{ segmentIds: string[] }> {
  return await db.transaction('rw', [db.segments, db.tanks, db.batches], async () => {
    const source = await db.segments.get(draft.sourceSegmentId)
    if (!source) throw new Error('来源段不存在或已被删除')
    if (source.batchId !== draft.batchId) throw new Error('来源段不属于该批次')

    const changedSegmentIds: string[] = []
    if (source.revision !== draft.sourceRevision) {
      changedSegmentIds.push(source.id)
    }

    const totalTransfer = draft.targets.reduce((sum, t) => sum + (t.volumeL || 0), 0)
    if (totalTransfer <= 0) throw new Error('倒罐量必须大于 0')
    if (totalTransfer > source.volumeL) {
      throw new Error(`倒罐量 ${totalTransfer}L 超过来源段量 ${source.volumeL}L`)
    }

    const conflicts: ConflictTank[] = []
    for (const target of draft.targets) {
      if (target.tankId === source.tankId) {
        throw new Error('目标罐不能与来源罐相同')
      }
      const tank = await db.tanks.get(target.tankId)
      if (!tank) throw new Error('目标发酵罐不存在')
      if (tank.state === '清洗中') throw new Error(`罐 ${tank.code} 正在清洗中，暂不可倒罐`)
      const segsInTank = await db.segments.where('tankId').equals(target.tankId).toArray()
      const occupiedL = segsInTank.reduce((sum, s) => sum + s.volumeL, 0)
      const deficitL = Number((occupiedL + target.volumeL - tank.capacityL).toFixed(1))
      if (deficitL > 0) {
        conflicts.push({
          tankId: tank.id,
          tankCode: tank.code,
          capacityL: tank.capacityL,
          occupiedL,
          transferL: target.volumeL,
          deficitL
        })
      }
    }

    if (changedSegmentIds.length > 0 || conflicts.length > 0) {
      throw new SegmentConflictError('倒罐保存冲突：目标段已被其它平板改动，或目标罐容量不足', {
        conflicts,
        changedSegmentIds,
        draft
      })
    }

    const now = Date.now()
    const newSegmentIds: string[] = []
    const remaining = Number((source.volumeL - totalTransfer).toFixed(1))

    if (remaining <= 0) {
      await db.segments.delete(source.id)
    } else {
      await db.segments.update(source.id, { volumeL: remaining, updatedAt: now } as never)
    }

    for (const target of draft.targets) {
      const existing = await db.segments
        .where('tankId')
        .equals(target.tankId)
        .filter((s) => s.batchId === draft.batchId)
        .first()
      if (existing) {
        await db.segments.update(
          existing.id,
          { volumeL: Number((existing.volumeL + target.volumeL).toFixed(1)), updatedAt: now } as never
        )
        newSegmentIds.push(existing.id)
      } else {
        const seg: SegmentRow = {
          id: createId('seg'),
          batchId: draft.batchId,
          tankId: target.tankId,
          volumeL: target.volumeL,
          seq: await nextSegmentSeq(draft.batchId),
          fromSegmentId: source.id,
          revision: ROW_REVISION,
          createdAt: now,
          updatedAt: now
        }
        await db.segments.put(seg)
        newSegmentIds.push(seg.id)
      }
      await db.tanks.update(target.tankId, { state: '在用', updatedAt: now } as never)
    }

    return { segmentIds: newSegmentIds }
  })
}

/** 入罐登记时创建批次的首个整段（段量 = 入罐量） */
export async function createInitialSegment(
  batchId: string,
  tankId: string,
  volumeL: number
): Promise<SegmentRow> {
  const now = Date.now()
  const seg: SegmentRow = {
    id: createId('seg'),
    batchId,
    tankId,
    volumeL,
    seq: 1,
    fromSegmentId: null,
    revision: ROW_REVISION,
    createdAt: now,
    updatedAt: now
  }
  await db.segments.put(seg)
  return seg
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
  segments: Segment[]
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
      // 兼容旧备份：无 segments 时按批次补唯一整段
      const segments = snapshot.segments?.length
        ? snapshot.segments
        : snapshot.batches.map((batch) => ({
            id: `seg-legacy-${batch.id}`,
            batchId: batch.id,
            tankId: batch.tankId,
            volumeL: batch.volumeL,
            seq: 1,
            fromSegmentId: null
          }))
      await db.segments.bulkPut(segments.map(stamp))
      await db.readings.bulkPut(
        snapshot.readings.map((row) =>
          stamp({
            ...row,
            segmentId: row.segmentId ?? `seg-legacy-${row.batchId}`
          })
        )
      )
      await db.operations.bulkPut(
        snapshot.operations.map((row) =>
          stamp({
            ...row,
            segmentId: row.segmentId ?? `seg-legacy-${row.batchId}`
          })
        )
      )
      await db.mlfs.bulkPut(
        snapshot.mlfs.map((row) =>
          stamp({
            ...row,
            segmentId: row.segmentId ?? `seg-legacy-${row.batchId}`
          })
        )
      )
      await db.tastings.bulkPut(snapshot.tastings.map(stamp))
    }
  )
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
