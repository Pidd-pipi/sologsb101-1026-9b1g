<script setup lang="ts">
/** /batches 入罐登记与发酵读数录入：倒罐后按段绑罐，读数认段，段量守恒 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { Plus, Warning } from '@element-plus/icons-vue'
import StageTag from '@/components/common/StageTag.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import { db, type BatchRow, type ParcelRow, type ReadingRow, type TankRow } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useFermentTrend } from '@/hooks/useFermentTrend'
import { useBatchStore } from '@/stores/batchStore'
import { useSegmentStore } from '@/stores/segmentStore'
import { BATCH_STATES, createEmptyBatch, type Batch } from '@/types/batch'
import { OVER_TEMP_C, createEmptyReading, type Reading } from '@/types/reading'
import type { RackingDraft } from '@/types/segment'
import type { FilterSelectConfig, FilterModel } from '@/types/filter'
import { filtersToQuery } from '@/utils/query'

const route = useRoute()
const router = useRouter()
const store = useBatchStore()
const segmentStore = useSegmentStore()

const { rows: batches, ready } = useIdbTable<BatchRow>(() => db.batches, {
  compare: (a, b) => b.harvestDate.localeCompare(a.harvestDate)
})
const { rows: readings } = useIdbTable<ReadingRow>(() => db.readings, {
  compare: (a, b) => a.date.localeCompare(b.date)
})
const { rows: parcels } = useIdbTable<ParcelRow>(() => db.parcels)
const { rows: tanks } = useIdbTable<TankRow>(() => db.tanks)

const selects = computed<FilterSelectConfig[]>(() => [
  { key: 'states', label: '批次状态', options: BATCH_STATES.map((item) => ({ label: item, value: item })) },
  { key: 'parcelIds', label: '地块', options: parcels.value.map((item) => ({ label: item.name, value: item.id })) }
])

const filteredBatches = computed(() => {
  const keyword = String(store.filters.keyword ?? '').trim().toLowerCase()
  const states = Array.isArray(store.filters.states) ? store.filters.states : []
  const parcelIds = Array.isArray(store.filters.parcelIds) ? store.filters.parcelIds : []
  return batches.value.filter((batch) => {
    const parcel = parcels.value.find((item) => item.id === batch.parcelId)
    const label = `${parcel ? parcel.name : ''} ${batch.id} ${batch.state}`.toLowerCase()
    if (keyword && !label.includes(keyword)) return false
    if (states.length > 0 && !states.includes(batch.state)) return false
    if (parcelIds.length > 0 && !parcelIds.includes(batch.parcelId)) return false
    return true
  })
})

const currentBatch = computed<BatchRow | null>(
  () => batches.value.find((batch) => batch.id === store.currentBatchId) ?? null
)

/** 当前批次的全部段 */
const currentSegments = computed(() =>
  currentBatch.value ? segmentStore.segmentsOfBatch(currentBatch.value.id) : []
)

/** 段量合计（应恒等于批次入罐量） */
const currentSegmentVolume = computed(() =>
  currentBatch.value ? segmentStore.volumeOfBatch(currentBatch.value.id) : 0
)

/** 段量是否守恒（与入罐量一致，容差 0.1L） */
const volumeConsistent = computed(() => {
  if (!currentBatch.value) return true
  return Math.abs(currentSegmentVolume.value - currentBatch.value.volumeL) < 0.1
})

/** 读数的段筛选：'' 表示全部段 */
const segmentFilter = ref<string>('')

const segmentFilterOptions = computed(() => [
  { label: '全部段', value: '' },
  ...currentSegments.value.map((seg) => ({
    label: `段${seg.seq} · ${tankCode(seg.tankId)} · ${seg.volumeL}L`,
    value: seg.id
  }))
])

const batchReadings = computed<ReadingRow[]>(() => {
  if (!currentBatch.value) return []
  return readings.value
    .filter((row) => row.batchId === currentBatch.value!.id)
    .filter((row) => (segmentFilter.value ? row.segmentId === segmentFilter.value : true))
    .sort((a, b) => a.date.localeCompare(b.date))
})

const trend = useFermentTrend(batchReadings)

const batchTotals = computed(() => {
  const active = batches.value.filter((batch) => batch.state !== '已出罐')
  return {
    batchCount: batches.value.length,
    activeCount: active.length,
    activeVolume: active.reduce((sum, batch) => sum + batch.volumeL, 0),
    avgBrix:
      active.length > 0 ? Number((active.reduce((sum, batch) => sum + batch.brix, 0) / active.length).toFixed(1)) : 0,
    readingCount: readings.value.length
  }
})

function parcelName(parcelId: string): string {
  return parcels.value.find((item) => item.id === parcelId)?.name ?? '未绑定地块'
}

function tankCode(tankId: string): string {
  if (!tankId) return '已释放'
  return tanks.value.find((item) => item.id === tankId)?.code ?? '未知罐'
}

/** 趋势条高度百分比（比重越大条越高） */
function barHeight(gravity: number): number {
  const { min, max } = trend.range.value
  const ratio = (gravity - min) / Math.max(0.001, max - min)
  return Math.max(6, Math.min(100, Math.round(ratio * 100)))
}

/* ------------------------------ 入罐登记 ------------------------------ */
const batchDialog = ref(false)
const batchFormRef = ref<FormInstance>()
const batchForm = reactive<Omit<Batch, 'id' | 'lastOperationAt'>>(createEmptyBatch())

const batchRules: FormRules = {
  parcelId: [{ required: true, message: '请选择地块', trigger: 'change' }],
  tankId: [{ required: true, message: '请选择发酵罐', trigger: 'change' }],
  volumeL: [{ required: true, message: '请填写入罐量', trigger: 'blur' }]
}

/** 可选罐位：状态非「清洗中」，且无其它在罐段占用 */
const assignableTanks = computed(() =>
  tanks.value.filter((tank) => {
    if (tank.state === '清洗中') return false
    const occupied = segmentStore.segmentsInTank(tank.id).some(
      (seg) => seg.batchId !== store.currentBatchId
    )
    return !occupied
  })
)

function openCreateBatch(): void {
  Object.assign(batchForm, createEmptyBatch())
  const parcelFromQuery = typeof route.query.parcelId === 'string' ? route.query.parcelId : ''
  if (parcelFromQuery) batchForm.parcelId = parcelFromQuery
  batchDialog.value = true
}

async function submitBatch(): Promise<void> {
  const valid = await batchFormRef.value?.validate().catch(() => false)
  if (!valid) return
  try {
    await store.createBatch({ ...batchForm })
    ElMessage.success('批次已入罐，罐位置为「在用」')
    batchDialog.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '入罐失败')
  }
}

async function shipBatch(batch: BatchRow): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认批次 ${batch.id} 出罐？出罐后将释放全部段占用的罐位并归档读数。`, '出罐确认', {
      type: 'warning',
      confirmButtonText: '确认出罐'
    })
  } catch {
    return
  }
  await store.ship(batch.id)
  ElMessage.success('批次已出罐，罐位已释放')
}

async function removeBatch(batch: BatchRow): Promise<void> {
  try {
    await ElMessageBox.confirm(`删除批次 ${batch.id} 会同时删除其段、读数 / 作业 / 苹乳 / 品评记录，是否继续？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '确认删除'
    })
  } catch {
    return
  }
  await store.deleteBatch(batch.id)
  ElMessage.success('批次及其下级记录已删除')
}

/* ------------------------------ 倒罐（绑段到罐） ------------------------------ */
const rackDialog = ref(false)
const rackForm = reactive<{ sourceSegmentId: string; targets: Array<{ tankId: string; volumeL: number }> }>({
  sourceSegmentId: '',
  targets: []
})

const sourceSegment = computed(() =>
  currentSegments.value.find((seg) => seg.id === rackForm.sourceSegmentId) ?? null
)

/** 倒罐目标罐可选范围：非清洗中、非来源罐 */
function rackTargetTankOptions(excludeTankId: string) {
  return tanks.value.filter((tank) => tank.state !== '清洗中' && tank.id !== excludeTankId)
}

/** 每个目标行的实时容量预览（占用量 / 差量） */
function previewOf(tankId: string, volumeL: number) {
  const tank = tanks.value.find((item) => item.id === tankId)
  if (!tank) return null
  const occupiedL = segmentStore.occupiedVolumeInTank(tank.id)
  const deficitL = Number((occupiedL + volumeL - tank.capacityL).toFixed(1))
  return { tank, occupiedL, deficitL, sufficient: deficitL <= 0 }
}

function openRack(): void {
  if (!currentBatch.value || currentSegments.value.length === 0) {
    ElMessage.warning('该批次还没有段，无法倒罐')
    return
  }
  rackForm.sourceSegmentId = currentSegments.value[0].id
  rackForm.targets = [{ tankId: '', volumeL: 0 }]
  rackDialog.value = true
}

function addTarget(): void {
  rackForm.targets.push({ tankId: '', volumeL: 0 })
}

function removeTarget(index: number): void {
  rackForm.targets.splice(index, 1)
}

async function submitRack(): Promise<void> {
  if (!currentBatch.value || !sourceSegment.value) return
  const targets = rackForm.targets
    .filter((row) => row.tankId && row.volumeL > 0)
    .map((row) => ({ tankId: row.tankId, volumeL: row.volumeL }))
  if (targets.length === 0) {
    ElMessage.warning('请至少填写一个目标罐与倒罐量')
    return
  }
  const total = targets.reduce((sum, row) => sum + row.volumeL, 0)
  if (total > sourceSegment.value.volumeL) {
    ElMessage.warning(`倒罐量合计 ${total}L 超过来源段量 ${sourceSegment.value.volumeL}L`)
    return
  }
  const draft: RackingDraft = {
    batchId: currentBatch.value.id,
    sourceSegmentId: sourceSegment.value.id,
    sourceRevision: sourceSegment.value.revision,
    targets
  }
  try {
    const ok = await segmentStore.rack(draft)
    if (ok) {
      ElMessage.success('倒罐已保存，批次段已绑到目标罐')
      rackDialog.value = false
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '倒罐保存失败')
  }
  // 冲突时 store 已保留草稿与冲突信息，弹出冲突面板
}

/** 冲突后用保留的草稿重试保存 */
async function retryRack(): Promise<void> {
  try {
    const ok = await segmentStore.retry()
    if (ok) {
      ElMessage.success('倒罐已保存，批次段已绑到目标罐')
      segmentStore.clearConflict()
      rackDialog.value = false
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '重试失败')
  }
}

/* ------------------------------ 读数录入 ------------------------------ */
const readingDialog = ref(false)
const readingFormRef = ref<FormInstance>()
const readingForm = reactive<Omit<Reading, 'id'>>(createEmptyReading())

const readingRules: FormRules = {
  segmentId: [{ required: true, message: '请选择批次段', trigger: 'change' }],
  date: [{ required: true, message: '请选择日期', trigger: 'change' }],
  gravity: [{ required: true, message: '请填写比重', trigger: 'blur' }]
}

function openCreateReading(): void {
  if (!currentBatch.value) {
    ElMessage.warning('请先选择批次')
    return
  }
  if (currentSegments.value.length === 0) {
    ElMessage.warning('该批次还没有段，无法录入读数')
    return
  }
  Object.assign(readingForm, createEmptyReading())
  readingForm.batchId = currentBatch.value.id
  readingForm.segmentId = segmentFilter.value || currentSegments.value[0].id
  readingDialog.value = true
}

async function submitReading(): Promise<void> {
  const valid = await readingFormRef.value?.validate().catch(() => false)
  if (!valid) return
  const duplicate = batchReadings.value.some(
    (row) => row.date === readingForm.date && row.segmentId === readingForm.segmentId
  )
  if (duplicate) {
    ElMessage.warning('该段当日已有读数，请直接编辑已有记录')
    return
  }
  const now = Date.now()
  await db.readings.put({
    ...readingForm,
    id: `reading-${now.toString(36)}`,
    revision: 1,
    createdAt: now,
    updatedAt: now
  })
  ElMessage.success('读数已记录')
  readingDialog.value = false
}

async function removeReading(row: ReadingRow): Promise<void> {
  try {
    await ElMessageBox.confirm(`删除 ${row.date} 的读数？`, '删除确认', { type: 'warning' })
  } catch {
    return
  }
  await db.readings.delete(row.id)
  ElMessage.success('读数已删除')
}

function onFilterChange(next: FilterModel): void {
  store.setFilters(next)
}

onMounted(() => {
  store.applyQuery(route.query)
  if (!store.currentBatchId && filteredBatches.value.length > 0) {
    store.select(filteredBatches.value[0].id)
  }
})

watch(
  () => store.filters,
  (value) => {
    void router.replace({ path: route.path, query: filtersToQuery(value) })
  },
  { deep: true }
)

watch(currentBatch, (batch) => {
  segmentFilter.value = ''
  if (batch) {
    void router.replace({ path: route.path, query: { ...filtersToQuery(store.filters), batchId: batch.id } })
  }
})
</script>

<template>
  <div class="page">
    <div class="page__head">
      <div>
        <h2 class="page__title">入罐登记与发酵读数</h2>
        <p class="page__subtitle">
          倒罐后按段绑罐，段量合计恒等于入罐量；读数认段，超温（{{ OVER_TEMP_C }} ℃）自动标记。
        </p>
      </div>
      <el-button type="primary" :icon="Plus" @click="openCreateBatch">新建入罐批次</el-button>
    </div>

    <div class="badge-row">
      <StatBadge label="批次数" :value="batchTotals.batchCount" suffix="批" icon="Files" tone="primary" />
      <StatBadge label="在罐批次" :value="batchTotals.activeCount" suffix="批" icon="Grid" tone="warning" />
      <StatBadge label="在罐量" :value="batchTotals.activeVolume" suffix="L" icon="Histogram" tone="success" />
      <StatBadge label="平均入罐糖度" :value="batchTotals.avgBrix" suffix="°Bx" icon="TrendCharts" tone="info" />
      <StatBadge label="读数条数" :value="batchTotals.readingCount" suffix="条" icon="DataLine" tone="danger" />
    </div>

    <FilterBar
      :model-value="store.filters"
      :selects="selects"
      keyword-placeholder="搜索地块 / 批次号 / 状态…"
      @update:model-value="onFilterChange"
      @reset="store.resetFilters()"
    />

    <el-row :gutter="16">
      <el-col :span="10">
        <el-card shadow="never">
          <template #header>
            <div class="card-title">
              <span>批次清单（{{ filteredBatches.length }}）</span>
              <span class="muted">点击选择批次</span>
            </div>
          </template>
          <EmptyPanel
            v-if="ready && filteredBatches.length === 0"
            title="暂无批次"
            description="先做一次入罐登记，把地块与发酵罐绑定起来。"
            create-text="新建入罐批次"
            @create="openCreateBatch"
          />
          <div v-else class="batch-list">
            <div
              v-for="batch in filteredBatches"
              :key="batch.id"
              class="batch-item"
              :class="{ 'is-active': batch.id === store.currentBatchId }"
              @click="store.select(batch.id)"
            >
              <div class="batch-item__head">
                <span class="batch-item__name">{{ parcelName(batch.parcelId) }}</span>
                <StageTag :value="batch.state" size="small" />
              </div>
              <div class="batch-item__meta">
                {{ batch.harvestDate }} · {{ batch.volumeL }}L · {{ batch.brix }}°Bx · 主罐 {{ tankCode(batch.tankId) }}
              </div>
              <div class="batch-item__segs">
                <el-tag
                  v-for="seg in segmentStore.segmentsOfBatch(batch.id)"
                  :key="seg.id"
                  size="small"
                  effect="plain"
                  class="seg-tag"
                >
                  段{{ seg.seq }} · {{ tankCode(seg.tankId) }} · {{ seg.volumeL }}L
                </el-tag>
              </div>
              <div class="batch-item__actions">
                <el-button link type="primary" size="small" @click.stop="shipBatch(batch)">出罐</el-button>
                <el-button link type="danger" size="small" @click.stop="removeBatch(batch)">删除</el-button>
              </div>
            </div>
          </div>
        </el-card>
      </el-col>

      <el-col :span="14">
        <el-card shadow="never">
          <template #header>
            <div class="card-title">
              <span>
                批次段
                <template v-if="currentBatch"> · {{ parcelName(currentBatch.parcelId) }}</template>
              </span>
              <el-button type="primary" size="small" :icon="Plus" @click="openRack">倒罐绑段</el-button>
            </div>
          </template>

          <EmptyPanel
            v-if="!currentBatch"
            title="未选择批次"
            description="在左侧选择一个批次后查看批次段。"
            :show-create="false"
          />

          <template v-else>
            <el-alert
              v-if="!volumeConsistent"
              type="error"
              :closable="false"
              show-icon
              title="段量合计不等于入罐量"
              :description="`各段合计 ${currentSegmentVolume}L，入罐量 ${currentBatch.volumeL}L，差 ${(currentSegmentVolume - currentBatch.volumeL).toFixed(1)}L。`"
              class="mb"
            />
            <div class="seg-overview">
              <el-tag type="info" effect="plain">入罐量 {{ currentBatch.volumeL }}L</el-tag>
              <el-tag type="success" effect="plain">各段合计 {{ currentSegmentVolume }}L</el-tag>
              <el-tag effect="plain">分罐 {{ segmentStore.tankCountOfBatch(currentBatch.id) }} 个</el-tag>
            </div>
            <el-table :data="currentSegments" stripe border size="small" class="mt">
              <el-table-column label="段号" width="70" align="center">
                <template #default="{ row }">段{{ row.seq }}</template>
              </el-table-column>
              <el-table-column label="发酵罐" min-width="120">
                <template #default="{ row }">{{ tankCode(row.tankId) }}</template>
              </el-table-column>
              <el-table-column label="段量(L)" width="110" align="right">
                <template #default="{ row }">{{ row.volumeL }}</template>
              </el-table-column>
              <el-table-column label="来源" width="120">
                <template #default="{ row }">
                  {{ row.fromSegmentId ? `段${row.fromSegmentId.slice(-4)}` : '入罐整段' }}
                </template>
              </el-table-column>
            </el-table>
          </template>
        </el-card>

        <el-card shadow="never" class="mt">
          <template #header>
            <div class="card-title">
              <span>
                读数明细
                <template v-if="currentBatch"> · {{ parcelName(currentBatch.parcelId) }}</template>
              </span>
              <div>
                <el-select
                  v-model="segmentFilter"
                  size="small"
                  class="seg-filter"
                  placeholder="全部段"
                >
                  <el-option v-for="item in segmentFilterOptions" :key="item.value" :label="item.label" :value="item.value" />
                </el-select>
                <el-button type="primary" size="small" :icon="Plus" @click="openCreateReading">录入读数</el-button>
              </div>
            </div>
          </template>

          <EmptyPanel
            v-if="!currentBatch"
            title="未选择批次"
            description="在左侧选择一个批次后即可录入发酵读数。"
            :show-create="false"
          />

          <template v-else>
            <el-alert
              v-if="trend.stuck.value"
              type="warning"
              :closable="false"
              show-icon
              title="疑似发酵停滞"
              description="末尾两次读数的比重日下降速率低于 0.002，建议检查温度与营养盐。"
              class="mb"
            />
            <el-alert
              v-if="trend.overTempDays.value > 0"
              type="error"
              :closable="false"
              show-icon
              :title="`累计超温 ${trend.overTempDays.value} 天`"
              :description="`存在温度高于 ${OVER_TEMP_C} ℃ 的读数，已在明细中标记。`"
              class="mb"
            />

            <div class="metric-row">
              <StageTag :value="trend.stage.value" />
              <el-tag type="info" effect="plain">最新比重 {{ trend.latestGravity.value || '—' }}</el-tag>
              <el-tag type="info" effect="plain">日均下降 {{ trend.avgDeclinePerDay.value }}</el-tag>
              <el-tag type="info" effect="plain">潜在酒精度 {{ trend.potential.value }}%vol</el-tag>
            </div>

            <div class="trend-bar">
              <div v-for="point in trend.points.value" :key="point.id" class="trend-bar__item" :title="`${point.date} · ${point.gravity}`">
                <div
                  class="trend-bar__fill"
                  :class="{ 'is-over': point.overTemp }"
                  :style="{ height: `${barHeight(point.gravity)}%` }"
                />
                <span class="trend-bar__label">{{ point.date.slice(5) }}</span>
              </div>
            </div>

            <el-table :data="trend.points.value" stripe border class="mt">
              <el-table-column prop="date" label="日期" width="110" />
              <el-table-column label="批次段" width="120">
                <template #default="{ row }">
                  <el-tag size="small" effect="plain">
                    段{{ currentSegments.find((s) => s.id === row.segmentId)?.seq ?? '?' }} · {{ tankCode(currentSegments.find((s) => s.id === row.segmentId)?.tankId ?? '') }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column prop="gravity" label="比重" width="90" align="right" />
              <el-table-column prop="brix" label="糖度(°Bx)" width="100" align="right" />
              <el-table-column prop="tempC" label="温度(℃)" width="100" align="right">
                <template #default="{ row }">
                  <el-tag :type="row.overTemp ? 'danger' : 'success'" effect="plain" size="small">
                    {{ row.tempC }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="下降速率/日" width="120" align="right">
                <template #default="{ row }">{{ row.declinePerDay }}</template>
              </el-table-column>
              <el-table-column label="操作" width="80">
                <template #default="{ row }">
                  <el-button link type="danger" size="small" @click="removeReading(row)">删除</el-button>
                </template>
              </el-table-column>
            </el-table>
          </template>
        </el-card>
      </el-col>
    </el-row>

    <!-- 新建入罐批次 -->
    <el-dialog v-model="batchDialog" title="新建入罐批次" width="560px">
      <el-form ref="batchFormRef" :model="batchForm" :rules="batchRules" label-width="100px">
        <el-form-item label="地块" prop="parcelId">
          <el-select v-model="batchForm.parcelId" class="full" placeholder="选择地块">
            <el-option v-for="item in parcels" :key="item.id" :label="`${item.name}（${item.variety}）`" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="发酵罐" prop="tankId">
          <el-select v-model="batchForm.tankId" class="full" placeholder="仅列出可分配罐位">
            <el-option
              v-for="item in assignableTanks"
              :key="item.id"
              :label="`${item.code} · ${item.material} ${item.capacityL}L`"
              :value="item.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="采收日期">
          <el-date-picker v-model="batchForm.harvestDate" type="date" value-format="YYYY-MM-DD" class="full" />
        </el-form-item>
        <el-form-item label="入罐量(L)" prop="volumeL">
          <el-input-number v-model="batchForm.volumeL" :min="10" :max="50000" :step="50" />
        </el-form-item>
        <el-form-item label="入罐糖度">
          <el-input-number v-model="batchForm.brix" :min="5" :max="40" :step="0.5" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="batchDialog = false">取消</el-button>
        <el-button type="primary" @click="submitBatch">确认入罐</el-button>
      </template>
    </el-dialog>

    <!-- 倒罐绑段 -->
    <el-dialog v-model="rackDialog" title="倒罐：把批次段绑到目标罐" width="640px">
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="每次只转指定段；各段量之和恒等于批次入罐量。目标罐容量不足将拒绝开工并显示差量。"
        class="mb"
      />
      <el-form label-width="100px">
        <el-form-item label="来源段">
          <el-select v-model="rackForm.sourceSegmentId" class="full">
            <el-option
              v-for="seg in currentSegments"
              :key="seg.id"
              :label="`段${seg.seq} · ${tankCode(seg.tankId)} · ${seg.volumeL}L`"
              :value="seg.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="来源段量">
          <el-tag type="info" effect="plain">{{ sourceSegment?.volumeL ?? 0 }}L</el-tag>
        </el-form-item>
        <el-form-item
          v-for="(target, index) in rackForm.targets"
          :key="index"
          :label="`目标罐 ${index + 1}`"
        >
          <div class="target-row">
            <el-select v-model="target.tankId" placeholder="选择目标罐" class="target-tank">
              <el-option
                v-for="tank in rackTargetTankOptions(sourceSegment?.tankId ?? '')"
                :key="tank.id"
                :label="`${tank.code} · ${tank.material} ${tank.capacityL}L`"
                :value="tank.id"
              />
            </el-select>
            <el-input-number v-model="target.volumeL" :min="0" :max="50000" :step="50" placeholder="倒罐量(L)" class="target-volume" />
            <el-button link type="danger" size="small" @click="removeTarget(index)">移除</el-button>
          </div>
          <div v-if="target.tankId && target.volumeL > 0" class="target-preview">
            <span class="muted">
              罐 {{ previewOf(target.tankId, target.volumeL)?.tank.code }} · 容量
              {{ previewOf(target.tankId, target.volumeL)?.tank.capacityL }}L · 已占
              {{ previewOf(target.tankId, target.volumeL)?.occupiedL }}L · 转入 {{ target.volumeL }}L
            </span>
            <el-tag v-if="previewOf(target.tankId, target.volumeL) && !previewOf(target.tankId, target.volumeL)!.sufficient" type="danger" size="small" effect="dark">
              差 {{ previewOf(target.tankId, target.volumeL)?.deficitL }}L，无法开工
            </el-tag>
            <el-tag v-else type="success" size="small" effect="plain">可容纳</el-tag>
          </div>
        </el-form-item>
      </el-form>
      <el-button size="small" @click="addTarget">+ 添加目标罐</el-button>
      <template #footer>
        <el-button @click="rackDialog = false">取消</el-button>
        <el-button
          type="primary"
          :disabled="rackForm.targets.some((t) => t.tankId && t.volumeL > 0 && previewOf(t.tankId, t.volumeL) && !previewOf(t.tankId, t.volumeL)!.sufficient)"
          @click="submitRack"
        >
          确认倒罐
        </el-button>
      </template>
    </el-dialog>

    <!-- 并发保存冲突：保留草稿，列出冲突罐与差量，可重试 -->
    <el-dialog
      :model-value="segmentStore.hasConflict"
      title="倒罐保存冲突"
      width="620px"
      :close-on-click-modal="false"
    >
      <el-alert
        type="error"
        :closable="false"
        show-icon
        title="先到者已占住目标段，本次保存未写入"
        description="草稿已保留，可在核对冲突罐与差量后重试；重试仍失败请刷新后再改。"
        class="mb"
      />
      <div v-if="(segmentStore.conflict?.changedSegmentIds.length ?? 0) > 0" class="mb">
        <el-tag type="warning" effect="plain">来源段已被其它平板改动，段量可能已变化</el-tag>
      </div>
      <el-table :data="segmentStore.conflict?.conflicts ?? []" stripe border size="small">
        <el-table-column prop="tankCode" label="冲突罐" width="120" />
        <el-table-column prop="capacityL" label="容量(L)" width="100" align="right" />
        <el-table-column prop="occupiedL" label="已占(L)" width="100" align="right" />
        <el-table-column prop="transferL" label="转入(L)" width="100" align="right" />
        <el-table-column label="差量(L)" width="110" align="right">
          <template #default="{ row }">
            <el-tag type="danger" size="small" effect="dark">差 {{ row.deficitL }}L</el-tag>
          </template>
        </el-table-column>
      </el-table>
      <template #footer>
        <el-button @click="segmentStore.clearConflict()">关闭（保留草稿）</el-button>
        <el-button type="primary" :icon="Warning" @click="retryRack">重试保存</el-button>
      </template>
    </el-dialog>

    <!-- 录入发酵读数 -->
    <el-dialog v-model="readingDialog" title="录入发酵读数" width="520px">
      <el-form ref="readingFormRef" :model="readingForm" :rules="readingRules" label-width="100px">
        <el-form-item label="批次段" prop="segmentId">
          <el-select v-model="readingForm.segmentId" class="full" placeholder="选择读数所属段">
            <el-option
              v-for="seg in currentSegments"
              :key="seg.id"
              :label="`段${seg.seq} · ${tankCode(seg.tankId)} · ${seg.volumeL}L`"
              :value="seg.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="日期" prop="date">
          <el-date-picker v-model="readingForm.date" type="date" value-format="YYYY-MM-DD" class="full" />
        </el-form-item>
        <el-form-item label="比重(SG)" prop="gravity">
          <el-input-number v-model="readingForm.gravity" :min="0.9" :max="1.2" :step="0.001" :precision="3" />
        </el-form-item>
        <el-form-item label="温度(℃)">
          <el-input-number v-model="readingForm.tempC" :min="5" :max="45" :step="0.5" />
        </el-form-item>
        <el-form-item label="糖度(°Bx)">
          <el-input-number v-model="readingForm.brix" :min="-5" :max="40" :step="0.1" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="readingDialog = false">取消</el-button>
        <el-button type="primary" @click="submitReading">保存读数</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
export default defineComponent({ name: 'BatchReading' })
</script>

<style scoped>
.full {
  width: 100%;
}

.mb {
  margin-bottom: 12px;
}

.mt {
  margin-top: 12px;
}

.metric-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}

.seg-overview {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.seg-filter {
  width: 180px;
  margin-right: 8px;
}

.batch-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 620px;
  overflow-y: auto;
}

.batch-item {
  padding: 10px 12px;
  border: 1px solid var(--wine-border);
  border-radius: 10px;
  background: #fffdfd;
  cursor: pointer;
  transition: border-color 0.2s ease;
}

.batch-item.is-active {
  border-color: #b9688a;
  background: #fdf3f6;
}

.batch-item__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.batch-item__name {
  font-weight: 600;
}

.batch-item__meta {
  margin-top: 4px;
  font-size: 12px;
  color: #8c8479;
}

.batch-item__segs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 6px;
}

.seg-tag {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.batch-item__actions {
  margin-top: 4px;
}

.target-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}

.target-tank {
  flex: 1;
}

.target-volume {
  width: 140px;
}

.target-preview {
  margin-top: 4px;
  margin-left: 100px;
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
