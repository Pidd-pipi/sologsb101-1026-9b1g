<script setup lang="ts">
/** /mlf 苹果酸乳酸发酵跟踪：按批次段录入苹果酸下降并判定结束、联动批次状态 */
import { computed, onMounted, reactive, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import StageTag from '@/components/common/StageTag.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { db, ROW_REVISION, type BatchRow, type MlfRow, type ParcelRow, type ReadingRow, type SegmentRow, type TankRow } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useMlfStore } from '@/stores/mlfStore'
import { MALIC_DONE_THRESHOLD, MALIC_START_G, MLF_STATES } from '@/types/mlf'
import type { FilterSelectConfig, FilterModel } from '@/types/filter'
import { filtersToQuery } from '@/utils/query'

const route = useRoute()
const router = useRouter()
const store = useMlfStore()

const { rows: mlfs, ready } = useIdbTable<MlfRow>(() => db.mlfs)
const { rows: batches } = useIdbTable<BatchRow>(() => db.batches)
const { rows: segments } = useIdbTable<SegmentRow>(() => db.segments, { compare: (a, b) => a.seq - b.seq })
const { rows: tanks } = useIdbTable<TankRow>(() => db.tanks)
const { rows: parcels } = useIdbTable<ParcelRow>(() => db.parcels)
const { rows: readings } = useIdbTable<ReadingRow>(() => db.readings)

const selects: FilterSelectConfig[] = [
  { key: 'states', label: '苹乳状态', options: MLF_STATES.map((item) => ({ label: item, value: item })) }
]

function batchOf(batchId: string): BatchRow | undefined {
  return batches.value.find((item) => item.id === batchId)
}

function segmentOf(segmentId: string): SegmentRow | undefined {
  return segments.value.find((item) => item.id === segmentId)
}

function tankCode(tankId: string): string {
  if (!tankId) return '已出罐'
  return tanks.value.find((item) => item.id === tankId)?.code ?? '未知罐'
}

function batchLabel(batchId: string): string {
  const batch = batchOf(batchId)
  if (!batch) return '批次已删除'
  const parcel = parcels.value.find((item) => item.id === batch.parcelId)
  return `${parcel ? parcel.name : '未知地块'} · ${batch.harvestDate}`
}

/** 苹乳记录的段标签：第几段 / 罐号 / 段量 */
function segmentLabel(mlf: MlfRow): string {
  const segment = segmentOf(mlf.segmentId)
  if (!segment) return '段已删除'
  return `第${segment.seq}段 · 罐 ${tankCode(segment.tankId)} · ${segment.volumeL}L`
}

/** 该段在苹乳期间的平均温度（读数认段） */
function avgTemp(segmentId: string): string {
  const rows = readings.value.filter((row) => row.segmentId === segmentId)
  if (rows.length === 0) return '—'
  return `${(rows.reduce((sum, row) => sum + row.tempC, 0) / rows.length).toFixed(1)} ℃`
}

/** 尚无苹乳记录的在罐段 */
const candidates = computed(() =>
  segments.value
    .filter((segment) => {
      const batch = batchOf(segment.batchId)
      return batch && batch.state !== '已出罐' && !mlfs.value.some((mlf) => mlf.segmentId === segment.id)
    })
    .map((segment) => ({
      segment,
      batchId: segment.batchId,
      label: `${batchLabel(segment.batchId)} / 第${segment.seq}段 ${tankCode(segment.tankId)} ${segment.volumeL}L`
    }))
)

const filtered = computed(() => {
  const keyword = String(store.filters.keyword ?? '').trim().toLowerCase()
  const states = Array.isArray(store.filters.states) ? store.filters.states : []
  return mlfs.value.filter((mlf) => {
    const label = `${batchLabel(mlf.batchId)} ${segmentLabel(mlf)} ${mlf.state}`.toLowerCase()
    if (keyword && !label.includes(keyword)) return false
    if (states.length > 0 && !states.includes(mlf.state)) return false
    return true
  })
})

const summary = computed(() => {
  const running = mlfs.value.filter((item) => item.state === '进行中').length
  const done = mlfs.value.filter((item) => item.state === '已完成').length
  const avgMalic =
    mlfs.value.length > 0
      ? Number((mlfs.value.reduce((sum, item) => sum + item.malicG, 0) / mlfs.value.length).toFixed(2))
      : 0
  return {
    total: mlfs.value.length,
    running,
    done,
    notStarted: mlfs.value.filter((item) => item.state === '未启动').length,
    avgMalic,
    doneRatio: mlfs.value.length > 0 ? Math.round((done / mlfs.value.length) * 100) : 0
  }
})

/* ------------------------------ 录入苹果酸 ------------------------------ */
const malicInputs = reactive<Record<string, number>>({})

function malicValueOf(mlf: MlfRow): number {
  if (malicInputs[mlf.id] === undefined) malicInputs[mlf.id] = mlf.malicG
  return malicInputs[mlf.id]
}

async function submitMalic(mlf: MlfRow): Promise<void> {
  const value = malicValueOf(mlf)
  if (Number.isNaN(value) || value < 0) {
    ElMessage.warning('请填写有效的苹果酸值（g/L）')
    return
  }
  const done = await store.recordMalic(mlf, value)
  ElMessage[done ? 'success' : 'info'](
    done ? `该段苹果酸已降至 ${value} g/L，判定苹乳结束` : '苹果酸值已更新'
  )
}

async function start(mlf: MlfRow): Promise<void> {
  await store.startMlf(mlf.segmentId, mlf.batchId, mlf)
  ElMessage.success('该段苹乳发酵已启动，批次状态置为「苹乳发酵」')
}

async function startForSegment(segmentId: string, batchId: string): Promise<void> {
  await store.startMlf(segmentId, batchId)
  ElMessage.success('苹乳发酵已启动')
}

async function finish(mlf: MlfRow): Promise<void> {
  await store.finishMlf(mlf)
  ElMessage.success('该段苹乳发酵已手动结束')
}

async function remove(mlf: MlfRow): Promise<void> {
  try {
    await ElMessageBox.confirm('删除该段苹乳记录不影响其它段，是否继续？', '删除确认', { type: 'warning' })
  } catch {
    return
  }
  await store.deleteMlf(mlf)
  ElMessage.success('苹乳记录已删除')
}

/** 为在罐段建立一条未启动苹乳记录 */
async function createPlaceholder(segmentId: string, batchId: string): Promise<void> {
  const now = Date.now()
  await db.mlfs.put({
    id: `mlf-${now.toString(36)}`,
    batchId,
    segmentId,
    startDate: '',
    endDate: '',
    malicG: MALIC_START_G,
    state: '未启动',
    revision: ROW_REVISION,
    createdAt: now,
    updatedAt: now
  })
  ElMessage.success('已建立该段苹乳跟踪记录')
}

function onFilterChange(next: FilterModel): void {
  store.setFilters(next)
}

onMounted(() => {
  store.applyQuery(route.query)
})

watch(
  () => store.filters,
  (value) => {
    void router.replace({ path: route.path, query: filtersToQuery(value) })
  },
  { deep: true }
)
</script>

<template>
  <div class="page">
    <div class="page__head">
      <div>
        <h2 class="page__title">苹果酸乳酸发酵跟踪</h2>
        <p class="page__subtitle">
          苹乳按批次段跟踪；某段苹果酸低于 {{ MALIC_DONE_THRESHOLD }} g/L 自动判定结束并联动批次状态。
        </p>
      </div>
    </div>

    <div class="badge-row">
      <StatBadge label="苹乳记录" :value="summary.total" suffix="段" icon="Files" tone="primary" />
      <StatBadge label="进行中" :value="summary.running" suffix="段" icon="Histogram" tone="warning" />
      <StatBadge label="已完成" :value="summary.done" suffix="段" icon="Grid" tone="success" />
      <StatBadge label="未启动" :value="summary.notStarted" suffix="段" icon="DataLine" tone="info" />
      <StatBadge label="平均苹果酸" :value="summary.avgMalic" suffix="g/L" icon="TrendCharts" tone="danger" />
    </div>

    <FilterBar
      :model-value="store.filters"
      :selects="selects"
      keyword-placeholder="搜索地块 / 段 / 苹乳状态…"
      @update:model-value="onFilterChange"
      @reset="store.resetFilters()"
    />

    <el-card v-if="candidates.length > 0" shadow="never">
      <template #header>
        <div class="card-title">
          <span>待建苹乳跟踪的在罐段（{{ candidates.length }}）</span>
          <span class="muted">倒罐后的每个罐段可独立启动苹乳</span>
        </div>
      </template>
      <div class="candidate-row">
        <el-tag
          v-for="item in candidates"
          :key="item.segment.id"
          closable
          @close="createPlaceholder(item.segment.id, item.batchId)"
        >
          {{ item.label }}
          <el-button link type="primary" size="small" @click="startForSegment(item.segment.id, item.batchId)">
            启动苹乳
          </el-button>
        </el-tag>
      </div>
    </el-card>

    <EmptyPanel
      v-if="ready && filtered.length === 0"
      title="暂无苹乳记录"
      description="为在罐批次段启动苹果酸乳酸发酵并逐次录入苹果酸值。"
      :show-create="false"
    />

    <el-table v-else :data="filtered" stripe border>
      <el-table-column label="批次 / 段" min-width="240">
        <template #default="{ row }">
          <div>{{ batchLabel(row.batchId) }}</div>
          <div class="segment-line">{{ segmentLabel(row) }}</div>
          <div class="muted">平均温度 {{ avgTemp(row.segmentId) }}</div>
        </template>
      </el-table-column>
      <el-table-column label="批次状态" width="120">
        <template #default="{ row }">
          <StageTag :value="batchOf(row.batchId)?.state ?? '未知'" size="small" />
        </template>
      </el-table-column>
      <el-table-column label="苹乳状态" width="110">
        <template #default="{ row }">
          <StageTag :value="row.state" size="small" />
        </template>
      </el-table-column>
      <el-table-column label="进度" width="160">
        <template #default="{ row }">
          <el-progress :percentage="store.progressOf(row)" :stroke-width="8" />
        </template>
      </el-table-column>
      <el-table-column prop="startDate" label="启动日期" width="110">
        <template #default="{ row }">{{ row.startDate || '—' }}</template>
      </el-table-column>
      <el-table-column prop="endDate" label="结束日期" width="110">
        <template #default="{ row }">{{ row.endDate || '—' }}</template>
      </el-table-column>
      <el-table-column label="苹果酸录入" width="230">
        <template #default="{ row }">
          <div class="malic-cell">
            <el-input-number
              :model-value="malicValueOf(row)"
              :min="0"
              :max="10"
              :step="0.1"
              :precision="2"
              size="small"
              @update:model-value="(value: number | undefined) => (malicInputs[row.id] = value ?? 0)"
            />
            <el-button size="small" type="primary" @click="submitMalic(row)">记一笔</el-button>
          </div>
          <div class="muted">当前 {{ row.malicG }} g/L</div>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="180" fixed="right">
        <template #default="{ row }">
          <el-button v-if="row.state === '未启动'" link type="primary" size="small" @click="start(row)">启动</el-button>
          <el-button v-if="row.state === '进行中'" link type="success" size="small" @click="finish(row)">结束</el-button>
          <el-button link type="danger" size="small" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<style scoped>
.candidate-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.segment-line {
  margin-top: 2px;
  font-size: 12px;
  color: #8a3b56;
}

.muted {
  color: #8c8479;
}

.malic-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
