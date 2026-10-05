<script setup lang="ts">
/** /tanks 发酵罐容量配置与罐位状态看板：按材质与温控方式筛选并校验占用冲突 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StageTag from '@/components/common/StageTag.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { db, type BatchRow, type ParcelRow, type SegmentRow, type TankRow } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useTankStore } from '@/stores/tankStore'
import {
  TANK_MATERIALS,
  TANK_STATES,
  TANK_TEMP_CONTROLS,
  createEmptyTank,
  type Tank,
  type TankState
} from '@/types/tank'
import type { FilterSelectConfig, FilterModel } from '@/types/filter'
import { filtersToQuery } from '@/utils/query'
import { ROUTES } from '@/router'

const route = useRoute()
const router = useRouter()
const store = useTankStore()

const { rows: tanks, ready } = useIdbTable<TankRow>(() => db.tanks, {
  compare: (a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN')
})
const { rows: batches } = useIdbTable<BatchRow>(() => db.batches)
const { rows: segments } = useIdbTable<SegmentRow>(() => db.segments, { compare: (a, b) => a.seq - b.seq })
const { rows: parcels } = useIdbTable<ParcelRow>(() => db.parcels)

const selects: FilterSelectConfig[] = [
  { key: 'materials', label: '材质', options: TANK_MATERIALS.map((item) => ({ label: item, value: item })) },
  { key: 'tempControls', label: '温控', options: TANK_TEMP_CONTROLS.map((item) => ({ label: item, value: item })) },
  { key: 'states', label: '罐位', options: TANK_STATES.map((item) => ({ label: item, value: item })) }
]

/** 占用该罐的在罐段 */
function occupantSegmentsOf(tankId: string): SegmentRow[] {
  return store.occupantSegmentsOf(tankId, segments.value, batches.value)
}

/** 该罐在罐占用量（L） */
function occupiedVolumeOf(tankId: string): number {
  return store.occupiedVolumeOf(tankId, segments.value, batches.value)
}

function segmentBatchLabel(segment: SegmentRow): string {
  const batch = batches.value.find((item) => item.id === segment.batchId)
  if (!batch) return '批次已删除'
  const parcel = parcels.value.find((item) => item.id === batch.parcelId)
  return `${parcel ? parcel.name : '未知地块'} · 第${segment.seq}段 ${segment.volumeL}L`
}

function occupantText(tankId: string): string {
  return occupantSegmentsOf(tankId)
    .map((segment) => segmentBatchLabel(segment))
    .join('；')
}

const filtered = computed(() => {
  const keyword = String(store.filters.keyword ?? '').trim().toLowerCase()
  const materials = Array.isArray(store.filters.materials) ? store.filters.materials : []
  const tempControls = Array.isArray(store.filters.tempControls) ? store.filters.tempControls : []
  const states = Array.isArray(store.filters.states) ? store.filters.states : []
  return tanks.value.filter((tank) => {
    const label = `${tank.code} ${tank.material} ${tank.tempControl} ${tank.state}`
    if (keyword && !label.toLowerCase().includes(keyword)) return false
    if (materials.length > 0 && !materials.includes(tank.material)) return false
    if (tempControls.length > 0 && !tempControls.includes(tank.tempControl)) return false
    if (states.length > 0 && !states.includes(tank.state)) return false
    return true
  })
})

const totals = computed(() => {
  const totalCapacity = tanks.value.reduce((sum, tank) => sum + tank.capacityL, 0)
  const usedCapacity = tanks.value.reduce((sum, tank) => sum + occupiedVolumeOf(tank.id), 0)
  return {
    tankCount: tanks.value.length,
    totalCapacity,
    usedCapacity,
    freeCapacity: totalCapacity - usedCapacity,
    usageRatio: totalCapacity > 0 ? Math.round((usedCapacity / totalCapacity) * 100) : 0,
    freeCount: tanks.value.filter((tank) => tank.state === '空闲').length
  }
})

/* ------------------------------ 新增 / 编辑 ------------------------------ */
const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const formRef = ref<FormInstance>()
const form = reactive<Omit<Tank, 'id'>>(createEmptyTank())

const rules: FormRules = {
  code: [{ required: true, message: '请填写罐号', trigger: 'blur' }],
  capacityL: [{ required: true, message: '请填写容量', trigger: 'blur' }]
}

function openCreate(): void {
  editingId.value = null
  Object.assign(form, createEmptyTank())
  dialogVisible.value = true
}

function openEdit(tank: TankRow): void {
  editingId.value = tank.id
  Object.assign(form, {
    code: tank.code,
    material: tank.material,
    capacityL: tank.capacityL,
    tempControl: tank.tempControl,
    state: tank.state
  })
  dialogVisible.value = true
}

async function submit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  if (editingId.value) {
    await store.updateTank(editingId.value, { ...form })
    ElMessage.success('罐位配置已更新')
  } else {
    await store.createTank({ ...form })
    ElMessage.success('发酵罐已建档')
  }
  dialogVisible.value = false
}

async function remove(tank: TankRow): Promise<void> {
  const occupied = occupiedVolumeOf(tank.id)
  if (occupied > 0) {
    ElMessage.warning(`罐 ${tank.code} 仍有 ${occupied}L 在罐批次段，请先出罐或倒罐改绑其它罐位`)
    return
  }
  try {
    await ElMessageBox.confirm(`确认删除发酵罐「${tank.code}」？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '确认删除'
    })
  } catch {
    return
  }
  await store.deleteTank(tank.id)
  ElMessage.success('发酵罐已删除')
}

async function changeState(tank: TankRow, next: TankState): Promise<void> {
  try {
    await store.changeState(tank, next)
    ElMessage.success(`罐 ${tank.code} 已置为「${next}」`)
  } catch (error) {
    ElMessage.warning(error instanceof Error ? error.message : '操作失败')
  }
}

/** 罐位分配改为倒罐：引导到作业页对指定段开工 */
function goRacking(): void {
  void router.push(ROUTES.operations)
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
        <h2 class="page__title">发酵罐容量配置与罐位看板</h2>
        <p class="page__subtitle">罐位「在用」由入罐批次绑定后自动置位；重复分配会被拦截并列出占用批次。</p>
      </div>
      <div>
        <el-button @click="router.push(ROUTES.batches)">去入罐登记</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">新增发酵罐</el-button>
      </div>
    </div>

    <div class="badge-row">
      <StatBadge label="罐总数" :value="totals.tankCount" suffix="个" icon="Grid" tone="primary" />
      <StatBadge label="空闲罐位" :value="totals.freeCount" suffix="个" icon="Files" tone="success" />
      <StatBadge label="总容量" :value="totals.totalCapacity" suffix="L" icon="Histogram" tone="info" />
      <StatBadge label="已占用" :value="totals.usedCapacity" suffix="L" icon="DataLine" tone="warning" />
      <StatBadge label="剩余容量" :value="totals.freeCapacity" suffix="L" icon="PieChart" tone="success" />
    </div>

    <FilterBar
      :model-value="store.filters"
      :selects="selects"
      keyword-placeholder="搜索罐号 / 材质 / 温控…"
      @update:model-value="onFilterChange"
      @reset="store.resetFilters()"
    />

    <el-card shadow="never">
      <template #header>
        <div class="card-title">
          <span>罐位清单（{{ filtered.length }} / {{ tanks.length }}）</span>
      <span class="muted">按段占用：一个罐可容纳多个批次段，受容量（L）约束</span>
        </div>
      </template>

      <EmptyPanel
        v-if="ready && filtered.length === 0"
        title="没有匹配的发酵罐"
        description="新增一个发酵罐，或调整材质 / 温控 / 罐位筛选。"
        create-text="新增发酵罐"
        @create="openCreate"
      />

      <el-table v-else :data="filtered" stripe border>
        <el-table-column prop="code" label="罐号" width="100" />
        <el-table-column prop="material" label="材质" width="100" />
        <el-table-column prop="capacityL" label="容量(L)" width="100" align="right" />
        <el-table-column label="在罐量(L)" width="110" align="right">
          <template #default="{ row }">
            <span :class="{ 'over-cap': occupiedVolumeOf(row.id) > row.capacityL }">
              {{ occupiedVolumeOf(row.id) }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="剩余(L)" width="100" align="right">
          <template #default="{ row }">
            <el-tag :type="row.capacityL - occupiedVolumeOf(row.id) <= 0 ? 'danger' : 'success'" size="small" effect="plain">
              {{ row.capacityL - occupiedVolumeOf(row.id) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="tempControl" label="温控" width="90" />
        <el-table-column label="罐位状态" width="110">
          <template #default="{ row }">
            <StageTag :value="row.state" size="small" />
          </template>
        </el-table-column>
        <el-table-column label="占用段" min-width="240">
          <template #default="{ row }">
            <span v-if="occupantSegmentsOf(row.id).length > 0">{{ occupantText(row.id) }}</span>
            <span v-else class="muted">未占用</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="300" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="goRacking">倒罐入此罐</el-button>
            <el-button
              v-if="row.state !== '清洗中'"
              link
              type="warning"
              :disabled="occupiedVolumeOf(row.id) > 0"
              @click="changeState(row, '清洗中')"
            >
              转清洗
            </el-button>
            <el-button v-else link type="success" @click="changeState(row, '空闲')">清洗完成</el-button>
            <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button link type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑发酵罐' : '新增发酵罐'" width="520px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="90px">
        <el-form-item label="罐号" prop="code">
          <el-input v-model="form.code" placeholder="如：F-05" />
        </el-form-item>
        <el-form-item label="材质">
          <el-radio-group v-model="form.material">
            <el-radio-button v-for="item in TANK_MATERIALS" :key="item" :value="item">{{ item }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="容量(L)" prop="capacityL">
          <el-input-number v-model="form.capacityL" :min="50" :max="50000" :step="50" />
        </el-form-item>
        <el-form-item label="温控方式">
          <el-select v-model="form.tempControl" class="full">
            <el-option v-for="item in TANK_TEMP_CONTROLS" :key="item" :label="item" :value="item" />
          </el-select>
        </el-form-item>
        <el-form-item label="罐位状态">
          <el-select v-model="form.state" class="full">
            <el-option v-for="item in TANK_STATES" :key="item" :label="item" :value="item" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.full {
  width: 100%;
}

.muted {
  color: #8c8479;
}

.over-cap {
  color: #d63a4a;
  font-weight: 700;
}
</style>
