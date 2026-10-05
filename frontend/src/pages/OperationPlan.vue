<script setup lang="ts">
/** /operations 倒罐与压帽作业编排：按段排班、拖拽调序；倒罐开工时按段转酒并校验目标罐容 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { Plus, Rank } from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StageTag from '@/components/common/StageTag.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { db, type BatchRow, type OperationRow, type ParcelRow, type SegmentRow, type TankRow } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useOperationStore } from '@/stores/operationStore'
import { OPERATION_STATES, OPERATION_TYPES, createEmptyOperation, type Operation } from '@/types/operation'
import { isRackingConflictError, type RackingDraft, type RackingMoveDraft } from '@/types/racking'
import type { FilterSelectConfig, FilterModel } from '@/types/filter'
import { filtersToQuery } from '@/utils/query'

const route = useRoute()
const router = useRouter()
const store = useOperationStore()

const { rows: operations, ready } = useIdbTable<OperationRow>(() => db.operations, {
  compare: (a, b) => a.seq - b.seq || a.date.localeCompare(b.date)
})
const { rows: batches } = useIdbTable<BatchRow>(() => db.batches)
const { rows: segments } = useIdbTable<SegmentRow>(() => db.segments, { compare: (a, b) => a.seq - b.seq })
const { rows: tanks } = useIdbTable<TankRow>(() => db.tanks)
const { rows: parcels } = useIdbTable<ParcelRow>(() => db.parcels)

const selects: FilterSelectConfig[] = [
  { key: 'types', label: '作业类型', options: OPERATION_TYPES.map((item) => ({ label: item, value: item })) },
  { key: 'states', label: '状态', options: OPERATION_STATES.map((item) => ({ label: item, value: item })) }
]

function batchOf(batchId: string): BatchRow | undefined {
  return batches.value.find((item) => item.id === batchId)
}

function segmentOf(segmentId: string): SegmentRow | undefined {
  return segments.value.find((item) => item.id === segmentId)
}

function tankCode(tankId: string): string {
  if (!tankId) return '—'
  return tanks.value.find((item) => item.id === tankId)?.code ?? '未知罐'
}

function batchLabel(batchId: string): string {
  const batch = batchOf(batchId)
  if (!batch) return '批次已删除'
  const parcel = parcels.value.find((item) => item.id === batch.parcelId)
  return `${parcel ? parcel.name : '未知地块'} · ${batch.harvestDate}`
}

/** 作业的段标签：罐号 + 段量 */
function segmentLabelOf(segmentId: string): string {
  const segment = segmentOf(segmentId)
  if (!segment) return '段已删除'
  return `第${segment.seq}段 ${tankCode(segment.tankId)} ${segment.volumeL}L`
}

/** 供选择的全部在罐段 */
const selectableSegments = computed(() =>
  segments.value
    .filter((segment) => {
      const batch = batchOf(segment.batchId)
      return batch && batch.state !== '已出罐'
    })
    .map((segment) => ({
      segment,
      label: `${batchLabel(segment.batchId)} / ${segmentLabelOf(segment.id)}`
    }))
)

const filtered = computed(() => {
  const keyword = String(store.filters.keyword ?? '').trim().toLowerCase()
  const types = Array.isArray(store.filters.types) ? store.filters.types : []
  const states = Array.isArray(store.filters.states) ? store.filters.states : []
  const scoped = store.currentBatchId
    ? operations.value.filter((item) => item.batchId === store.currentBatchId)
    : operations.value
  return scoped
    .filter((item) => {
      const label = `${item.type} ${item.operator} ${batchLabel(item.batchId)} ${segmentLabelOf(item.segmentId)}`.toLowerCase()
      if (keyword && !label.includes(keyword)) return false
      if (types.length > 0 && !types.includes(item.type)) return false
      if (states.length > 0 && !states.includes(item.state)) return false
      return true
    })
    .sort((a, b) => a.seq - b.seq)
})

const summary = computed(() => ({
  total: filtered.value.length,
  planned: filtered.value.filter((item) => item.state === '计划').length,
  done: filtered.value.filter((item) => item.state === '已完成').length,
  totalMinutes: filtered.value.reduce((sum, item) => sum + item.durationMin, 0)
}))

/** 保留下来的倒罐草稿（开工失败者） */
const keptDrafts = computed(() => store.drafts)

/* ------------------------------ 拖拽调序 ------------------------------ */
const dragIndex = ref<number | null>(null)
const overIndex = ref<number | null>(null)

function onDragStart(index: number): void {
  dragIndex.value = index
}

function onDragOver(index: number): void {
  overIndex.value = index
}

async function onDrop(index: number): Promise<void> {
  const from = dragIndex.value
  dragIndex.value = null
  overIndex.value = null
  if (from === null || from === index) return
  await store.move(filtered.value, from, index)
  ElMessage.success('作业顺序已更新并写回本地库')
}

async function moveBy(index: number, offset: number): Promise<void> {
  await store.move(filtered.value, index, index + offset)
}

/* ------------------------------ 新增 / 编辑作业 ------------------------------ */
const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const formRef = ref<FormInstance>()
const form = reactive<Omit<Operation, 'id' | 'seq'>>(createEmptyOperation())

const rules: FormRules = {
  segmentId: [{ required: true, message: '请选择批次段', trigger: 'change' }],
  operator: [{ required: true, message: '请填写操作人', trigger: 'blur' }]
}

/** 选中段时带出其批次 */
function onSegmentChange(segmentId: string): void {
  const segment = segmentOf(segmentId)
  if (segment) form.batchId = segment.batchId
}

function openCreate(): void {
  editingId.value = null
  Object.assign(form, createEmptyOperation())
  if (store.currentSegmentId) {
    const segment = segmentOf(store.currentSegmentId)
    if (segment) {
      form.segmentId = segment.id
      form.batchId = segment.batchId
    }
  } else if (store.currentBatchId) {
    form.batchId = store.currentBatchId
  }
  dialogVisible.value = true
}

function openEdit(row: OperationRow): void {
  editingId.value = row.id
  Object.assign(form, {
    batchId: row.batchId,
    segmentId: row.segmentId,
    type: row.type,
    date: row.date,
    durationMin: row.durationMin,
    operator: row.operator,
    state: row.state,
    targetTankId: row.targetTankId,
    transferVolumeL: row.transferVolumeL
  })
  dialogVisible.value = true
}

async function submit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  try {
    const segment = segmentOf(form.segmentId)
    const payload = { ...form, batchId: segment?.batchId ?? form.batchId }
    if (editingId.value) {
      await store.updateOperation(editingId.value, payload)
      ElMessage.success('作业已更新')
    } else {
      await store.createOperation(payload)
      ElMessage.success('作业已排入队列')
    }
    dialogVisible.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败')
  }
}

async function finish(row: OperationRow): Promise<void> {
  await store.finish(row.id)
  ElMessage.success('作业已完成，批次最近作业时间已回写')
}

async function remove(row: OperationRow): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认删除 ${row.date} 的「${row.type}」作业？`, '删除确认', { type: 'warning' })
  } catch {
    return
  }
  await store.deleteOperation(row.id)
  ElMessage.success('作业已删除')
}

/* ------------------------------ 倒罐开工（并发 + 差量） ------------------------------ */
const rackingVisible = ref(false)
const rackingOperation = ref<OperationRow | null>(null)
/** 本次开工的移动行（每次只转指定段） */
interface RackingRow {
  segmentId: string
  targetTankId: string
  volumeL: number
}
const rackingRows = reactive<RackingRow[]>([])
const rackingBaseVersion = ref(0)

/** 某目标罐在「当前草稿移动 + 已有占用」下的剩余容量（实时预览） */
function previewFree(targetTankId: string, selfBatchId: string): { freeL: number; capacityL: number } {
  const tank = tanks.value.find((item) => item.id === targetTankId)
  if (!tank) return { freeL: 0, capacityL: 0 }
  const occupied = segments.value
    .filter((segment) => segment.tankId === targetTankId && segment.volumeL > 0)
    .filter((segment) => {
      const batch = batchOf(segment.batchId)
      return batch && batch.state !== '已出罐' && segment.batchId !== selfBatchId
    })
    .reduce((sum, segment) => sum + segment.volumeL, 0)
  const pending = rackingRows
    .filter((row) => row.targetTankId === targetTankId)
    .reduce((sum, row) => sum + (row.volumeL || 0), 0)
  return { freeL: tank.capacityL - occupied - pending, capacityL: tank.capacityL }
}

/** 倒罐可选目标罐：非清洗中、非转出段当前所在罐 */
function targetOptions(sourceTankId: string) {
  return tanks.value.filter((tank) => tank.state !== '清洗中' && tank.id !== sourceTankId)
}

function openRacking(operation: OperationRow): void {
  rackingOperation.value = operation
  const segment = segmentOf(operation.segmentId)
  rackingRows.splice(0)
  const existing = store.draftOf(operation.id)
  if (existing && existing.moves.length > 0) {
    existing.moves.forEach((move) => rackingRows.push({ ...move }))
    rackingBaseVersion.value = existing.baseVersion
  } else {
    rackingRows.push({
      segmentId: operation.segmentId,
      targetTankId: operation.targetTankId || '',
      volumeL: operation.transferVolumeL || segment?.volumeL || 0
    })
    rackingBaseVersion.value = segment?.updatedAt ?? Date.now()
  }
  store.lastConflicts = []
  rackingVisible.value = true
}

function addRackingRow(): void {
  const op = rackingOperation.value
  if (!op) return
  rackingRows.push({ segmentId: op.segmentId, targetTankId: '', volumeL: 0 })
}

function removeRackingRow(index: number): void {
  rackingRows.splice(index, 1)
}

function buildDraft(): RackingDraft | null {
  const op = rackingOperation.value
  const segment = op ? segmentOf(op.segmentId) : null
  if (!op || !segment) return null
  const moves: RackingMoveDraft[] = rackingRows
    .filter((row) => row.volumeL > 0 && row.targetTankId)
    .map((row) => ({ segmentId: row.segmentId, targetTankId: row.targetTankId, volumeL: row.volumeL }))
  return {
    operationId: op.id,
    batchId: op.batchId,
    type: '倒罐',
    date: op.date,
    durationMin: op.durationMin,
    operator: op.operator,
    moves,
    baseVersion: rackingBaseVersion.value,
    savedAt: Date.now()
  }
}

/** 保存排程（不落罐位，只存草稿，可被后续开工使用） */
function saveRackingDraft(): void {
  const draft = buildDraft()
  if (!draft || draft.moves.length === 0) {
    ElMessage.warning('请至少指定一段、目标罐与转酒量')
    return
  }
  store.saveDraft(draft)
  ElMessage.success('倒罐草稿已保留，稍后可继续开工')
}

/** 开工：先到者占住目标段与罐容；失败保留草稿并显示冲突罐与差量 */
async function startRacking(): Promise<void> {
  const draft = buildDraft()
  if (!draft) return
  if (draft.moves.length === 0) {
    ElMessage.warning('请至少指定一段、目标罐与转酒量')
    return
  }
  // 前端预检：段量与目标罐容
  for (const row of draft.moves) {
    const segment = segmentOf(row.segmentId)
    if (!segment) {
      ElMessage.error('转出段不存在，可能已被其它平板倒走')
      return
    }
    if (row.volumeL > segment.volumeL) {
      ElMessage.error(`第${segment.seq}段仅剩 ${segment.volumeL}L，不能转 ${row.volumeL}L`)
      return
    }
  }
  try {
    const ok = await store.startRacking(draft)
    if (ok) {
      ElMessage.success('倒罐已开工：指定段已转入目标罐，段量合计保持不变')
      rackingVisible.value = false
    }
  } catch (error) {
    if (isRackingConflictError(error)) {
      ElMessage.error('开工被拒绝，草稿已保留，请按冲突差量调整后重试')
    } else {
      ElMessage.error(error instanceof Error ? error.message : '开工失败')
    }
  }
}

/** 冲突后用最新数据刷新基准版本并重试 */
async function retryRacking(): Promise<void> {
  const op = rackingOperation.value
  if (op) {
    const segment = segmentOf(op.segmentId)
    if (segment) rackingBaseVersion.value = segment.updatedAt
  }
  await startRacking()
}

function resumeDraft(draft: RackingDraft): void {
  const op = operations.value.find((item) => item.id === draft.operationId)
  if (!op) {
    ElMessage.warning('关联作业已不存在')
    return
  }
  openRacking(op)
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
        <h2 class="page__title">倒罐与压帽作业编排</h2>
        <p class="page__subtitle">
          作业认批次段；倒罐开工时每次只转指定段，目标罐容量不足会拒绝开工并显示差量。
        </p>
      </div>
      <el-button type="primary" :icon="Plus" @click="openCreate">新增作业</el-button>
    </div>

    <el-card shadow="never">
      <div class="metric-row">
        <el-tag type="info" effect="plain">作业 {{ summary.total }} 条</el-tag>
        <el-tag type="warning" effect="plain">计划中 {{ summary.planned }}</el-tag>
        <el-tag type="success" effect="plain">已完成 {{ summary.done }}</el-tag>
        <el-tag effect="plain">合计工时 {{ summary.totalMinutes }} 分钟</el-tag>
        <el-select
          v-model="store.currentBatchId"
          clearable
          placeholder="全部批次"
          class="batch-filter"
          @change="store.select(store.currentBatchId)"
        >
          <el-option v-for="item in batches" :key="item.id" :label="batchLabel(item.id)" :value="item.id" />
        </el-select>
      </div>
    </el-card>

    <el-alert
      v-if="keptDrafts.length > 0"
      type="warning"
      show-icon
      :closable="false"
      class="draft-alert"
      title="有倒罐草稿因容量不足 / 并发冲突未开工"
    >
      <div v-for="draft in keptDrafts" :key="draft.operationId ?? draft.savedAt" class="draft-line">
        <span>{{ batchLabel(draft.batchId) }} · {{ draft.date }} · {{ draft.moves.length }} 段移动</span>
        <el-button link type="primary" size="small" @click="resumeDraft(draft)">打开草稿重试</el-button>
        <el-button link type="danger" size="small" @click="store.discardDraft(draft.operationId)">放弃</el-button>
      </div>
    </el-alert>

    <FilterBar
      :model-value="store.filters"
      :selects="selects"
      keyword-placeholder="搜索作业类型 / 操作人 / 批次 / 段…"
      @update:model-value="onFilterChange"
      @reset="store.resetFilters()"
    />

    <EmptyPanel
      v-if="ready && filtered.length === 0"
      title="还没有排定的作业"
      description="为在罐批次段添加倒罐 / 压帽 / 淋皮作业，然后用拖拽排出执行顺序。"
      create-text="新增作业"
      @create="openCreate"
    />

    <div v-else class="op-list">
      <div
        v-for="(row, index) in filtered"
        :key="row.id"
        class="op-item"
        :class="{ 'is-dragging': dragIndex === index, 'is-over': overIndex === index }"
        draggable="true"
        @dragstart="onDragStart(index)"
        @dragover.prevent="onDragOver(index)"
        @drop.prevent="onDrop(index)"
        @dragend="dragIndex = null"
      >
        <el-icon class="drag-handle"><Rank /></el-icon>
        <div class="op-item__seq">#{{ index + 1 }}</div>
        <div class="op-item__body">
          <div class="op-item__title">
            <strong>{{ row.type }}</strong>
            <StageTag :value="row.state" size="small" />
            <el-tag size="small" effect="plain">{{ row.durationMin }} 分钟</el-tag>
            <el-tag v-if="row.type === '倒罐' && row.state === '计划'" size="small" type="danger" effect="plain">
              待开工
            </el-tag>
          </div>
          <div class="op-item__meta">
            {{ row.date }} · 操作人 {{ row.operator }} · {{ batchLabel(row.batchId) }}
          </div>
          <div class="op-item__segment">{{ segmentLabelOf(row.segmentId) }}</div>
          <div v-if="row.type === '倒罐' && row.targetTankId" class="op-item__meta">
            去向：罐 {{ tankCode(row.targetTankId) }} · {{ row.transferVolumeL }}L
          </div>
        </div>
        <div class="op-item__actions">
          <el-button link size="small" :disabled="index === 0" @click="moveBy(index, -1)">上移</el-button>
          <el-button link size="small" :disabled="index === filtered.length - 1" @click="moveBy(index, 1)">下移</el-button>
          <el-button
            v-if="row.type === '倒罐' && row.state === '计划'"
            link
            type="warning"
            size="small"
            @click="openRacking(row)"
          >
            开工
          </el-button>
          <el-button v-else-if="row.state === '计划'" link type="success" size="small" @click="finish(row)">完成</el-button>
          <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
          <el-button link type="danger" size="small" @click="remove(row)">删除</el-button>
        </div>
      </div>
    </div>

    <!-- 新增 / 编辑作业 -->
    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑作业' : '新增作业'" width="540px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="100px">
        <el-form-item label="批次段" prop="segmentId">
          <el-select v-model="form.segmentId" class="full" placeholder="选择批次段" @change="onSegmentChange">
            <el-option
              v-for="item in selectableSegments"
              :key="item.segment.id"
              :label="item.label"
              :value="item.segment.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="作业类型">
          <el-radio-group v-model="form.type">
            <el-radio-button v-for="item in OPERATION_TYPES" :key="item" :value="item">{{ item }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="日期">
          <el-date-picker v-model="form.date" type="date" value-format="YYYY-MM-DD" class="full" />
        </el-form-item>
        <el-form-item label="时长(分钟)">
          <el-input-number v-model="form.durationMin" :min="5" :max="600" :step="5" />
        </el-form-item>
        <el-form-item label="操作人" prop="operator">
          <el-input v-model="form.operator" placeholder="如：陈岩" />
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="form.state" class="full">
            <el-option v-for="item in OPERATION_STATES" :key="item" :label="item" :value="item" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>

    <!-- 倒罐开工 -->
    <el-dialog v-model="rackingVisible" title="倒罐开工 · 指定段转酒" width="680px">
      <el-alert
        type="info"
        :closable="false"
        show-icon
        class="mb"
        title="每次只转指定段；开工瞬间校验目标罐剩余容量，不足则拒绝并显示差量。"
        description="多台平板同时开工同一目标罐时，先到者占住罐容，后到者保留草稿，可改派罐位后重试。"
      />

      <el-table :data="rackingRows" border size="small">
        <el-table-column label="转出段" min-width="180">
          <template #default="{ row }">{{ segmentLabelOf(row.segmentId) }}</template>
        </el-table-column>
        <el-table-column label="转酒量(L)" width="140">
          <template #default="{ row }">
            <el-input-number v-model="row.volumeL" :min="1" :max="segmentOf(row.segmentId)?.volumeL ?? 1" :step="50" size="small" />
          </template>
        </el-table-column>
        <el-table-column label="目标罐" min-width="180">
          <template #default="{ row }">
            <el-select v-model="row.targetTankId" size="small" placeholder="选择目标罐">
              <el-option
                v-for="tank in targetOptions(segmentOf(row.segmentId)?.tankId ?? '')"
                :key="tank.id"
                :label="`${tank.code} ${tank.capacityL}L（剩 ${previewFree(tank.id, rackingOperation?.batchId ?? '').freeL}L）`"
                :value="tank.id"
              />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="容量差量" width="120" align="center">
          <template #default="{ row }">
            <el-tag
              v-if="row.targetTankId"
              :type="previewFree(row.targetTankId, rackingOperation?.batchId ?? '').freeL >= row.volumeL ? 'success' : 'danger'"
              size="small"
              effect="plain"
            >
              {{
                previewFree(row.targetTankId, rackingOperation?.batchId ?? '').freeL >= row.volumeL
                  ? '可容纳'
                  : `差 ${row.volumeL - previewFree(row.targetTankId, rackingOperation?.batchId ?? '').freeL}L`
              }}
            </el-tag>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="70" align="center">
          <template #default="{ $index }">
            <el-button link type="danger" size="small" :disabled="rackingRows.length <= 1" @click="removeRackingRow($index)">
              移除
            </el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-button class="mt" size="small" :icon="Plus" @click="addRackingRow">再转一段（同段分批转）</el-button>

      <!-- 冲突明细：先到者占住目标段 / 罐容不足 -->
      <el-alert
        v-if="store.lastConflicts.length > 0"
        type="error"
        show-icon
        :closable="false"
        class="mt"
        title="开工被拒绝：以下目标罐容量不足或段已被先到者占用"
      >
        <div v-for="(conflict, i) in store.lastConflicts" :key="i" class="conflict-line">
          <el-tag type="danger" size="small" effect="dark">罐 {{ conflict.tankCode }}</el-tag>
          <span>申请 {{ conflict.requestedL }}L · 仅剩 {{ conflict.availableL }}L ·</span>
          <strong>差 {{ conflict.shortfallL }}L</strong>
          <el-tag v-if="conflict.segmentTaken" type="warning" size="small">段已被改动</el-tag>
          <span class="muted">{{ conflict.occupiedBy }}</span>
        </div>
      </el-alert>

      <template #footer>
        <el-button @click="rackingVisible = false">取消</el-button>
        <el-button @click="saveRackingDraft">保留草稿</el-button>
        <el-button v-if="store.lastConflicts.length > 0" type="warning" @click="retryRacking">刷新后重试</el-button>
        <el-button type="primary" @click="startRacking">确认开工</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.metric-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.batch-filter {
  width: 240px;
  margin-left: auto;
}

.draft-alert {
  margin-top: 12px;
}

.draft-line {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 4px;
  font-size: 13px;
}

.mb {
  margin-bottom: 12px;
}

.mt {
  margin-top: 12px;
}

.muted {
  color: #8c8479;
}

.conflict-line {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 6px;
  font-size: 13px;
}

.op-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.op-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  background: #ffffff;
  border: 1px solid var(--wine-border);
  border-left: 4px solid #b9688a;
  border-radius: 10px;
}

.op-item.is-dragging {
  opacity: 0.45;
}

.op-item.is-over {
  border-top: 2px dashed #b9688a;
}

.op-item__seq {
  width: 38px;
  font-weight: 700;
  color: #8a3b56;
  font-variant-numeric: tabular-nums;
}

.op-item__body {
  flex: 1;
}

.op-item__title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.op-item__meta {
  margin-top: 4px;
  font-size: 12px;
  color: #8c8479;
}

.op-item__segment {
  margin-top: 2px;
  font-size: 12px;
  color: #8a3b56;
}

.op-item__actions {
  display: flex;
  align-items: center;
}
</style>
