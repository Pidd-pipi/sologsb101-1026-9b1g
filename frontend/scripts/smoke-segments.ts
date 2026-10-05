/**
 * 冒烟测试：用 fake-indexeddb 在 Node 中验证段绑定 / 守恒 / 容量差量 / 并发 CAS / 旧数据升级。
 * 运行：npx tsx scripts/smoke-segments.ts
 */
import 'fake-indexeddb/auto'
import { db, initDatabase, resetDatabase } from '../src/utils/db'
import {
  executeRacking,
  listSegments,
  listBatches,
  listTanks,
  tankFreeVolume,
  assertTankCapacity,
  ROW_REVISION
} from '../src/utils/db'
import { RackingConflictError } from '../src/types/racking'
import { wholeSegmentId } from '../src/types/segment'

let passed = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`断言失败：${msg}`)
  passed += 1
  console.log(`  ✓ ${msg}`)
}

async function main(): Promise<void> {
  console.log('— 场景1：首屏播种后，每个批次都有整段且段量守恒')
  await initDatabase()
  let batches = await listBatches()
  let segments = await listSegments()
  for (const batch of batches) {
    const own = segments.filter((s) => s.batchId === batch.id)
    const total = own.reduce((sum, s) => sum + s.volumeL, 0)
    assert(total === batch.volumeL, `批次 ${batch.id} 段量合计 ${total}=入罐量 ${batch.volumeL}`)
  }
  assert(segments.find((s) => s.id === 'seg-b-001-2')?.tankId === 'tk-003', 'b-001 第2段绑定 F-03')

  console.log('— 场景2：目标罐容量不足时拒绝开工并给出差量')
  // seg-b-001 当前 1800L 在 tk-001；tk-002 被别的批次 b-002 占 2000/2250，仅剩 250L。转 1000L → 差 750L
  let conflicted = false
  try {
    await executeRacking({
      operationId: null,
      batchId: 'b-001',
      date: '2024-10-01',
      durationMin: 40,
      operator: '测试',
      moves: [{ segmentId: 'seg-b-001', targetTankId: 'tk-002', volumeL: 1000 }],
      baseVersion: 0
    })
  } catch (error) {
    conflicted = true
    assert(error instanceof RackingConflictError, '抛出 RackingConflictError')
    const c = (error as RackingConflictError).conflicts[0]!
    assert(c.tankId === 'tk-002', `冲突罐是 tk-002（实际 ${c.tankId}）`)
    assert(c.shortfallL === 750, `差量 750L（实际 ${c.shortfallL}）：申请1000 - 剩余250`)
  }
  assert(conflicted, '容量不足确实被拒绝')
  // 段未被改动（事务回滚）
  const seg1 = await db.segments.get('seg-b-001')
  assert(seg1?.volumeL === 1800 && seg1.tankId === 'tk-001', '失败事务回滚，原段仍为 1800L@tk-01')

  console.log('— 场景3：容量足够时整段转走直接改绑；部分转走拆出新段且守恒')
  const before = await db.segments.get('seg-b-001')
  await executeRacking({
    operationId: null,
    batchId: 'b-001',
    date: '2024-10-02',
    durationMin: 40,
    operator: '测试',
    moves: [{ segmentId: 'seg-b-001', targetTankId: 'tk-005', volumeL: 500 }],
    baseVersion: before!.updatedAt
  })
  segments = await listSegments()
  const b1 = segments.filter((s) => s.batchId === 'b-001')
  assert(b1.reduce((sum, s) => sum + s.volumeL, 0) === 2600, '拆分后段量合计仍为 2600L')
  const segA = b1.find((s) => s.id === 'seg-b-001')!
  assert(segA.volumeL === 1300 && segA.tankId === 'tk-001', '原段缩量为 1300L 留在 tk-01')
  assert(b1.some((s) => s.tankId === 'tk-005' && s.volumeL === 500), '新段 500L 绑定 tk-05')
  const tank5 = await listTanks().then((ts) => ts.find((t) => t.id === 'tk-005'))
  assert(tank5?.state === '在用', '目标罐 tk-05 置为在用')

  console.log('— 场景4：并发 CAS —— 两台平板基于同一快照，先到者占住，后到者冲突')
  // 重置到干净演示状态
  await resetDatabase()
  const segWhole = await db.segments.get('seg-b-001') // 1800L @tk-01
  const base = segWhole!.updatedAt
  // 平板 A：整段 1800L 转到 tk-05（容量2000，可容纳）→ 成功，段改绑 tk-05
  const planA = executeRacking({
    operationId: null,
    batchId: 'b-001',
    date: '2024-10-03',
    durationMin: 40,
    operator: '平板A',
    moves: [{ segmentId: 'seg-b-001', targetTankId: 'tk-005', volumeL: 1800 }],
    baseVersion: base
  })
  // 平板 B 基于同一旧快照，想从段转 300L 到 tk-002（该罐被 b-002 占 2000/2250 只剩 250L；且段已被 A 改动）
  const planB = planA.then(() =>
    executeRacking({
      operationId: null,
      batchId: 'b-001',
      date: '2024-10-03',
      durationMin: 40,
      operator: '平板B',
      moves: [{ segmentId: 'seg-b-001', targetTankId: 'tk-002', volumeL: 300 }],
      baseVersion: base
    })
  )
  await planA
  let bFailed = false
  try {
    await planB
  } catch (error) {
    bFailed = true
    const conflicts = (error as RackingConflictError).conflicts
    // tk-002 剩 250L；B 申请 300L 差 50L，且段已被 A 改绑（segmentTaken）
    assert(conflicts[0]!.shortfallL === 50, `后到者差量 50L（实际 ${conflicts[0]!.shortfallL}）`)
    assert(conflicts[0]!.segmentTaken === true, '段已被先到者改动（segmentTaken）')
  }
  assert(bFailed, '后到者开工失败，先到者占住目标段与罐容')
  const total = (await listSegments()).filter((s) => s.batchId === 'b-001').reduce((s, x) => s + x.volumeL, 0)
  assert(total === 2600, '并发后段量合计依旧守恒 2600L')

  console.log('— 场景5：后到者保留草稿，改派到有空间的罐并刷新基准版本后重试成功')
  const segAfterA = await db.segments.get('seg-b-001') // 1800L 已在 tk-05
  await executeRacking({
    operationId: null,
    batchId: 'b-001',
    date: '2024-10-03',
    durationMin: 40,
    operator: '平板B',
    moves: [{ segmentId: 'seg-b-001', targetTankId: 'tk-003', volumeL: 300 }],
    baseVersion: segAfterA!.updatedAt
  })
  const finalSeg = await db.segments.get('seg-b-001')
  assert(finalSeg?.volumeL === 1500 && finalSeg.tankId === 'tk-005', '重试：原段 1500L 留 tk-005')
  assert(
    (await listSegments()).some((s) => s.batchId === 'b-001' && s.tankId === 'tk-003' && s.volumeL === 300),
    '新段 300L 转入 tk-03，重试成功'
  )

  console.log('— 场景6：旧数据升级（v1 → v2）自动补唯一整段并回填子表')
  await resetDatabase()
  await db.close()
  // 删除数据库后，用全新 Dexie 实例模拟 v1 老库
  indexedDB.deleteDatabase('gbwinetank-db')
  const { Dexie } = await import('dexie')
  const old = new Dexie('gbwinetank-db')
  old.version(1).stores({
    parcels: 'id',
    tanks: 'id',
    batches: 'id, parcelId, tankId, state',
    readings: 'id, batchId',
    operations: 'id, batchId',
    mlfs: 'id, batchId',
    tastings: 'id, batchId'
  })
  await old.open()
  await Promise.all([
    (old.table('parcels') as unknown as { put: (r: unknown) => Promise<unknown> }).put({
      id: 'px', name: '老地块', variety: '赤霞珠', areaMu: 3, vineAge: 5, aspect: '南'
    }),
    (old.table('tanks') as unknown as { put: (r: unknown) => Promise<unknown> }).put({
      id: 'tx', code: 'F-X', material: '不锈钢', capacityL: 1000, tempControl: '夹套', state: '在用'
    }),
    (old.table('batches') as unknown as { put: (r: unknown) => Promise<unknown> }).put({
      id: 'bx', parcelId: 'px', tankId: 'tx', harvestDate: '2024-08-01', volumeL: 900, brix: 22,
      state: '酒精发酵', lastOperationAt: null
    }),
    (old.table('readings') as unknown as { put: (r: unknown) => Promise<unknown> }).put({
      id: 'rx', batchId: 'bx', date: '2024-08-02', gravity: 1.08, tempC: 24, brix: 20
    }),
    (old.table('operations') as unknown as { put: (r: unknown) => Promise<unknown> }).put({
      id: 'ox', batchId: 'bx', type: '压帽', date: '2024-08-03', durationMin: 30, operator: '老周',
      state: '已完成', seq: 1
    }),
    (old.table('mlfs') as unknown as { put: (r: unknown) => Promise<unknown> }).put({
      id: 'mx', batchId: 'bx', startDate: '', endDate: '', malicG: 2.4, state: '未启动'
    })
  ])
  await old.close()

  // 重新打开当前版本（db 单例需要重新实例化）
  const mod = await import('../src/utils/db')
  await mod.initDatabase()
  const upgradedWhole = await mod.db.segments.get(wholeSegmentId('bx'))
  assert(Boolean(upgradedWhole), '旧批次 bx 自动补出唯一整段')
  assert(upgradedWhole?.volumeL === 900 && upgradedWhole.tankId === 'tx', '整段量=入罐量900 且绑定原罐 tx')
  const upgradedReading = await mod.db.readings.get('rx')
  assert(upgradedReading?.segmentId === wholeSegmentId('bx'), '旧读数回填 segmentId 到整段')
  const upgradedOp = await mod.db.operations.get('ox')
  assert(upgradedOp?.segmentId === wholeSegmentId('bx') && upgradedOp.targetTankId === '', '旧作业回填 segmentId 与倒罐字段')
  assert(upgradedWhole?.revision === ROW_REVISION, '整段行修订号为当前版本')

  console.log(`\n全部 ${passed} 条断言通过 ✅`)
  await mod.db.close()
  process.exit(0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
