/**
 * 首次打开应用时灌入的演示数据
 * 只在 parcels 表为空时执行，地块 → 发酵罐 → 批次 → 批次段 → 读数/作业/苹乳/品评 三层互相引用，
 * 保证 6 个页面第一次进入都有可点通的内容。函数本身幂等：由调用方判定表是否为空。
 */
import type {
  ParcelRow,
  TankRow,
  BatchRow,
  SegmentRow,
  ReadingRow,
  OperationRow,
  MlfRow,
  TastingRow
} from './db'
import { db, ROW_REVISION } from './db'
import { wholeSegmentId } from '../types/segment'

function rev<T>(row: T): T & { revision: number; createdAt: number; updatedAt: number } {
  return { ...row, revision: ROW_REVISION, createdAt: Date.now(), updatedAt: Date.now() }
}

const PARCELS: Array<Omit<ParcelRow, 'revision' | 'createdAt' | 'updatedAt'>> = [
  { id: 'p-001', name: '东坡三号地', variety: '赤霞珠', areaMu: 12.5, vineAge: 8, aspect: '南' },
  { id: 'p-002', name: '南坡老藤地', variety: '梅洛', areaMu: 8, vineAge: 15, aspect: '东南' },
  { id: 'p-003', name: '西坡白葡萄地', variety: '霞多丽', areaMu: 5.5, vineAge: 6, aspect: '西' }
]

const TANKS: Array<Omit<TankRow, 'revision' | 'createdAt' | 'updatedAt'>> = [
  { id: 'tk-001', code: 'F-01', material: '不锈钢', capacityL: 3000, tempControl: '夹套', state: '在用' },
  { id: 'tk-002', code: 'F-02', material: '橡木', capacityL: 2250, tempControl: '无', state: '在用' },
  { id: 'tk-003', code: 'F-03', material: '不锈钢', capacityL: 1500, tempControl: '盘管', state: '在用' },
  { id: 'tk-004', code: 'F-04', material: '混凝土', capacityL: 5000, tempControl: '夹套', state: '清洗中' },
  { id: 'tk-005', code: 'F-05', material: '不锈钢', capacityL: 2000, tempControl: '夹套', state: '空闲' }
]

const BATCHES: Array<Omit<BatchRow, 'revision' | 'createdAt' | 'updatedAt'>> = [
  {
    id: 'b-001',
    parcelId: 'p-001',
    tankId: 'tk-001',
    harvestDate: '2024-09-12',
    volumeL: 2600,
    brix: 24.5,
    state: '酒精发酵',
    lastOperationAt: '2024-09-20T10:00:00.000Z'
  },
  {
    id: 'b-002',
    parcelId: 'p-002',
    tankId: 'tk-002',
    harvestDate: '2024-09-15',
    volumeL: 2000,
    brix: 23,
    state: '苹乳发酵',
    lastOperationAt: '2024-09-27T14:05:00.000Z'
  },
  {
    id: 'b-003',
    parcelId: 'p-003',
    tankId: '',
    harvestDate: '2024-09-20',
    volumeL: 1400,
    brix: 21.5,
    state: '已出罐',
    lastOperationAt: '2024-10-08T08:40:00.000Z'
  }
]

/**
 * 批次段：b-001 已倒罐拆分 —— 1800L 留在 F-01，800L 在 F-03（合计 2600L = 入罐量）；
 * b-002 / b-003 为唯一整段。
 */
const SEGMENTS: Array<Omit<SegmentRow, 'revision' | 'createdAt' | 'updatedAt'>> = [
  { id: 'seg-b-001', batchId: 'b-001', tankId: 'tk-001', volumeL: 1800, seq: 1 },
  { id: 'seg-b-001-2', batchId: 'b-001', tankId: 'tk-003', volumeL: 800, seq: 2 },
  { id: wholeSegmentId('b-002'), batchId: 'b-002', tankId: 'tk-002', volumeL: 2000, seq: 1 },
  { id: wholeSegmentId('b-003'), batchId: 'b-003', tankId: '', volumeL: 1400, seq: 1 }
]

const READINGS: Array<Omit<ReadingRow, 'revision' | 'createdAt' | 'updatedAt'>> = [
  { id: 'r-001', batchId: 'b-001', segmentId: 'seg-b-001', date: '2024-09-12', gravity: 1.102, tempC: 24.5, brix: 24.5 },
  { id: 'r-002', batchId: 'b-001', segmentId: 'seg-b-001', date: '2024-09-14', gravity: 1.078, tempC: 27.2, brix: 19.4 },
  { id: 'r-003', batchId: 'b-001', segmentId: 'seg-b-001', date: '2024-09-16', gravity: 1.052, tempC: 31.4, brix: 13.1 },
  { id: 'r-004', batchId: 'b-001', segmentId: 'seg-b-001', date: '2024-09-18', gravity: 1.03, tempC: 28.6, brix: 7.6 },
  // 9-20 倒罐 800L 到 F-03：F-01 留段继续读
  { id: 'r-005', batchId: 'b-001', segmentId: 'seg-b-001', date: '2024-09-22', gravity: 1.014, tempC: 27.1, brix: 3.6 },
  // F-03 新段独立读数
  { id: 'r-006', batchId: 'b-001', segmentId: 'seg-b-001-2', date: '2024-09-21', gravity: 1.02, tempC: 26.4, brix: 5.2 },
  { id: 'r-007', batchId: 'b-001', segmentId: 'seg-b-001-2', date: '2024-09-23', gravity: 1.008, tempC: 25.9, brix: 2.1 },
  { id: 'r-008', batchId: 'b-002', segmentId: wholeSegmentId('b-002'), date: '2024-09-15', gravity: 1.096, tempC: 23.1, brix: 23 },
  { id: 'r-009', batchId: 'b-002', segmentId: wholeSegmentId('b-002'), date: '2024-09-19', gravity: 1.04, tempC: 25.8, brix: 10.1 },
  { id: 'r-010', batchId: 'b-002', segmentId: wholeSegmentId('b-002'), date: '2024-09-24', gravity: 1.006, tempC: 22.4, brix: 1.6 },
  { id: 'r-011', batchId: 'b-002', segmentId: wholeSegmentId('b-002'), date: '2024-09-27', gravity: 1.002, tempC: 21.7, brix: 0.6 },
  { id: 'r-012', batchId: 'b-003', segmentId: wholeSegmentId('b-003'), date: '2024-09-20', gravity: 1.09, tempC: 19.8, brix: 21.5 },
  { id: 'r-013', batchId: 'b-003', segmentId: wholeSegmentId('b-003'), date: '2024-09-26', gravity: 1.02, tempC: 18.2, brix: 5.1 },
  { id: 'r-014', batchId: 'b-003', segmentId: wholeSegmentId('b-003'), date: '2024-10-05', gravity: 0.994, tempC: 16.5, brix: -1.5 }
]

const OPERATIONS: Array<Omit<OperationRow, 'revision' | 'createdAt' | 'updatedAt'>> = [
  { id: 'op-001', batchId: 'b-001', segmentId: 'seg-b-001', type: '压帽', date: '2024-09-13', durationMin: 30, operator: '陈岩', state: '已完成', seq: 1, targetTankId: '', transferVolumeL: 0 },
  { id: 'op-002', batchId: 'b-001', segmentId: 'seg-b-001', type: '淋皮', date: '2024-09-14', durationMin: 25, operator: '陈岩', state: '已完成', seq: 2, targetTankId: '', transferVolumeL: 0 },
  // 已开工的倒罐：800L 从整段转到 F-03，整段缩量并拆出 seg-b-001-2
  { id: 'op-003', batchId: 'b-001', segmentId: 'seg-b-001', type: '倒罐', date: '2024-09-20', durationMin: 55, operator: '林沐', state: '已完成', seq: 3, targetTankId: 'tk-003', transferVolumeL: 800 },
  // 待开工的倒罐：计划把 F-01 留段再转 600L 到空闲罐 F-05
  { id: 'op-004', batchId: 'b-001', segmentId: 'seg-b-001', type: '倒罐', date: '2024-09-26', durationMin: 50, operator: '林沐', state: '计划', seq: 4, targetTankId: 'tk-005', transferVolumeL: 600 },
  // F-03 新段上的压帽
  { id: 'op-005', batchId: 'b-001', segmentId: 'seg-b-001-2', type: '压帽', date: '2024-09-22', durationMin: 35, operator: '周亦', state: '计划', seq: 5, targetTankId: '', transferVolumeL: 0 },
  { id: 'op-006', batchId: 'b-002', segmentId: wholeSegmentId('b-002'), type: '压帽', date: '2024-09-16', durationMin: 30, operator: '周亦', state: '已完成', seq: 1, targetTankId: '', transferVolumeL: 0 },
  { id: 'op-007', batchId: 'b-002', segmentId: wholeSegmentId('b-002'), type: '倒罐', date: '2024-09-21', durationMin: 60, operator: '周亦', state: '已完成', seq: 2, targetTankId: '', transferVolumeL: 0 },
  { id: 'op-008', batchId: 'b-002', segmentId: wholeSegmentId('b-002'), type: '淋皮', date: '2024-09-24', durationMin: 20, operator: '许澜', state: '计划', seq: 3, targetTankId: '', transferVolumeL: 0 },
  { id: 'op-009', batchId: 'b-003', segmentId: wholeSegmentId('b-003'), type: '倒罐', date: '2024-09-28', durationMin: 45, operator: '许澜', state: '已完成', seq: 1, targetTankId: '', transferVolumeL: 0 }
]

const MLFS: Array<Omit<MlfRow, 'revision' | 'createdAt' | 'updatedAt'>> = [
  { id: 'mlf-001', batchId: 'b-001', segmentId: 'seg-b-001', startDate: '', endDate: '', malicG: 2.4, state: '未启动' },
  { id: 'mlf-002', batchId: 'b-001', segmentId: 'seg-b-001-2', startDate: '', endDate: '', malicG: 2.2, state: '未启动' },
  { id: 'mlf-003', batchId: 'b-002', segmentId: wholeSegmentId('b-002'), startDate: '2024-09-26', endDate: '', malicG: 0.9, state: '进行中' },
  { id: 'mlf-004', batchId: 'b-003', segmentId: wholeSegmentId('b-003'), startDate: '2024-09-29', endDate: '2024-10-06', malicG: 0.2, state: '已完成' }
]

const TASTINGS: Array<Omit<TastingRow, 'revision' | 'createdAt' | 'updatedAt'>> = [
  {
    id: 'ts-001',
    batchId: 'b-001',
    date: '2024-09-19',
    aroma: '黑醋栗与青椒，果香集中',
    tannin: '单宁紧实，收口略涩',
    acidity: '酸度中高，骨架清晰',
    verdict: '待定'
  },
  {
    id: 'ts-002',
    batchId: 'b-002',
    date: '2024-09-28',
    aroma: '李子与雪松，带轻微还原味',
    tannin: '单宁柔顺',
    acidity: '酸度偏低，需补酸',
    verdict: '需调配'
  },
  {
    id: 'ts-003',
    batchId: 'b-003',
    date: '2024-10-08',
    aroma: '白桃与柠檬皮，香气干净',
    tannin: '几乎无单宁',
    acidity: '酸度明亮，平衡良好',
    verdict: '可直接装瓶'
  }
]

/** 灌入演示数据（地块 → 罐 → 批次 → 段 → 读数/作业/苹乳/品评） */
export async function seedDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.parcels, db.tanks, db.batches, db.segments, db.readings, db.operations, db.mlfs, db.tastings],
    async () => {
      await db.parcels.bulkPut(PARCELS.map(rev))
      await db.tanks.bulkPut(TANKS.map(rev))
      await db.batches.bulkPut(BATCHES.map(rev))
      await db.segments.bulkPut(SEGMENTS.map(rev))
      await db.readings.bulkPut(READINGS.map(rev))
      await db.operations.bulkPut(OPERATIONS.map(rev))
      await db.mlfs.bulkPut(MLFS.map(rev))
      await db.tastings.bulkPut(TASTINGS.map(rev))
    }
  )
}
