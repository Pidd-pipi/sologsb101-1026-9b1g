# 葡萄酒发酵罐与倒罐批次台（gbwinetank）

面向酒庄酿酒师与发酵车间班组的本地化车间台账：按地块采收把葡萄入罐发酵，逐日记录比重、温度与糖度，编排倒罐、压帽与淋皮作业，跟踪苹果酸乳酸发酵进度，并在出罐前完成品评与调配结论。

**倒罐按「批次段」管理**：一次入罐是一个批次，倒罐时每次只转指定段到目标发酵罐，一个批次可同时分布在多个罐；段量合计始终等于批次入罐量，发酵读数 / 苹乳 / 作业都认段。目标罐容量不足会拒绝开工并显示差量；多台平板同时开工时先到者占住目标段，后到者保留草稿并列出冲突罐与差量，可改派后重试。

核心动作：**建地块与品种 → 配置发酵罐容量 → 录发酵读数（按段）→ 排作业工序并倒罐开工 → 启动苹乳发酵（按段）→ 录品评并导出批次档案**。

纯前端单页应用（Vue 3 + TypeScript + Element Plus + Vite + Pinia + Vue Router + Dexie），**无后端、无数据库服务、无 API 服务**，全部数据保存在浏览器本地（IndexedDB），刷新或重启浏览器后仍然存在。

---

## 一、Docker 一键启动（推荐）

```bash
# 1. 首次启动先复制环境变量模板
cp .env.example .env

# 2. 构建并启动
docker compose up -d --build
```

启动完成后访问：**http://localhost:22826**

常用命令：

```bash
docker compose ps                 # 查看服务状态（healthy 表示就绪）
docker compose logs -f frontend   # 查看 nginx 日志
docker compose down               # 停止并移除容器
docker compose up -d --build      # 代码改动后重新构建
```

> 端口可在 `.env` 中通过 `FRONTEND_PORT` 修改；容器名固定为 `${COMPOSE_PROJECT_NAME:-gbwinetank}-frontend`。
> 容器无状态：不连接数据库、不挂载命名卷，数据全部在浏览器本地，迁移设备请使用应用内「导出整库 JSON / 导入备份」。

---

## 二、技术栈

| 分类 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3（`<script setup>` + Composition API） | 全部页面与组件使用组合式 API |
| 语言 | TypeScript（`strict: true`，无 `any`） | `npm run build` 内含 `vue-tsc --noEmit` 类型检查 |
| UI 组件库 | Element Plus 2.x（含 `@element-plus/icons-vue`） | 表格、卡片、对话框、表单、进度条、时间线交互 |
| 构建工具 | Vite 6 | 开发服务器端口 22826 |
| 状态管理 | Pinia（setup store） | `parcelStore` / `tankStore` / `batchStore` / `segmentStore` / `operationStore` / `mlfStore` |
| 路由 | Vue Router 4（history 模式） | nginx 侧配合 `try_files` 做 SPA fallback |
| 本地存储 | Dexie 4（IndexedDB 封装） | 库名 `gbwinetank-db`，含结构版本号与 upgrade 迁移（当前 v2：新增批次段表） |
| 容器化 | Docker 多阶段构建：`node:20-alpine` → `nginx:alpine` | 构建阶段执行类型检查与打包，运行阶段仅托管静态产物 |

---

## 三、本地开发方式

```bash
cd frontend
npm install
npm run dev        # 开发服务器 http://localhost:22826
npm run build      # 类型检查 + 生产构建，产物在 frontend/dist
npm run preview    # 本地预览构建产物（http://localhost:22826）
npm run test:smoke # Node + fake-indexeddb 冒烟测试（段守恒/容量差量/并发CAS/v1升级）
```

---

## 四、页面与路由

| 路由 | 模块 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/parcels` | 地块与品种台账 | Parcel、Batch | 新建/编辑/删除地块、按品种与朝向筛选、回显在罐批次数与累计入罐量、筛选同步 URL query |
| `/tanks` | 发酵罐容量配置与罐位看板 | Tank、BatchSegment | 按材质/温控/罐位筛选、按段统计在罐量与剩余容量、清洗状态流转 |
| `/batches` | 入罐登记与发酵读数 | Batch、BatchSegment、Reading、Parcel、Tank | 绑定地块与罐入罐（自动建唯一整段）、按段切换录比重/温度/糖度、段量守恒提示、趋势条、超温标记、出罐释放各段罐位 |
| `/operations` | 倒罐与压帽作业编排 | Operation、BatchSegment | 按日期排班、拖拽调序（含上下移按钮）、指派操作人；倒罐「开工」按指定段转酒、校验目标罐容、并发冲突保留草稿并重试、完成回写批次最近作业时间 |
| `/mlf` | 苹果酸乳酸发酵跟踪 | Mlf、BatchSegment、Reading | 每个罐段独立启动苹乳、逐段录入苹果酸、低于阈值自动判定结束并联动批次状态 |
| `/tasting` | 品评调配与批次档案 | Tasting 及全部模型 | 同批次多次品评并列对比、批次档案 JSON 导出、本地库版本查看与整库导入导出 |

---

## 五、目录结构

```
sologsb101-1026/
├── README.md
├── docker-compose.yml
├── .env / .env.example
├── .gitignore
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # try_files SPA fallback + gzip
    ├── .dockerignore
    ├── index.html / vite.config.ts / tsconfig.json / package.json
    ├── public/favicon.svg
    └── src/
        ├── main.ts  App.vue  env.d.ts
        ├── types/              # parcel.ts tank.ts batch.ts segment.ts reading.ts operation.ts mlf.ts tasting.ts racking.ts filter.ts
        ├── stores/             # parcelStore tankStore batchStore segmentStore operationStore mlfStore
        ├── components/common/  # StageTag.vue FilterBar.vue StatBadge.vue EmptyPanel.vue
        ├── hooks/              # useFermentTrend.ts useIdbTable.ts
        ├── utils/              # gravity.ts db.ts export.ts seed.ts uuid.ts query.ts
        ├── pages/              # ParcelList TankBoard BatchReading OperationPlan MlfBoard TastingExport
        ├── scripts/            # smoke-segments.ts：段守恒 / 容量差量 / 并发 CAS / v1→v2 升级冒烟测试
        ├── styles/main.css
        └── router/index.ts
```

---

## 六、数据存储说明

- **IndexedDB 库名**：`gbwinetank-db`（Dexie 封装），结构版本号 `version(2)`，并带分版本 `upgrade()` 迁移逻辑。
- **分表存储（8 张表）**：`parcels` 地块、`tanks` 发酵罐、`batches` 入罐批次、`segments` 批次段、`readings` 发酵读数、`operations` 作业、`mlfs` 苹乳发酵、`tastings` 品评调配；每行带 `revision` / `createdAt` / `updatedAt`。
- **批次段模型（v2 核心）**：入罐时每个批次自动建立唯一「整段」（量=入罐量、绑定入罐罐）；倒罐开工把指定段整段改绑或拆出新段，**段量合计恒等于批次入罐量**。读数 / 苹乳 / 作业都挂 `segmentId` 跟随具体罐段。
- **v1 → v2 升级**：`upgrade()` 为每个旧批次按确定性 id（`seg-<batchId>`）自动补出唯一整段、绑定批次原罐、量取入罐量，并把旧读数 / 作业 / 苹乳的 `segmentId` 回填到整段、为作业补倒罐去向字段。导入缺少段表的旧备份时，`repairSegments()` 做同样的兜底修复。
- **容量校验**：一个罐可容纳多个批次段，受容量 L 约束（同批次合罐不重复计占用）。倒罐开工在单事务内校验：目标罐清洗中或剩余容量放不下转出量即**拒绝开工**，错误里带每个冲突罐的申请量 / 剩余量 / 差量。
- **并发保存（乐观锁 CAS）**：开工草稿带打开时的段快照 `baseVersion`；IndexedDB 事务串行化保证先到者占住目标段与罐容，后到者若段已被改动（`segmentTaken`）或容量不足则整事务回滚、保留 localStorage 草稿并列出冲突罐与差量，刷新基准版本后可重试。
- **首屏自动播种**：`utils/db.ts` 的 `initDatabase()` 在 `parcels` 表为空时调用 `seedDatabase()`，灌入互相引用的演示数据（地块 → 罐 → 批次 → 段 → 读数/作业/苹乳/品评），其中 `b-001` 已倒罐拆成两段；播种幂等。
- **无后端**：没有 API 服务、没有数据库容器；容器本身无状态，不挂载任何卷。多平板各自保存到本机 IndexedDB，靠开工时的容量与 CAS 校验避免冲突。
- **数据迁移**：在「品评与批次档案」页可导出整库 JSON 备份（含段表），或导出单批次档案；在其它设备用「导入备份」还原（旧备份自动补整段）。
- **级联规则**：删除地块会级联删除其下批次、批次段与读数/作业/苹乳/品评并同步罐位；仍有在罐段的发酵罐不允许删除。
- **冒烟测试**：`npm run test:smoke` 用 fake-indexeddb 在 Node 中验证段量守恒、容量不足拒绝与差量、并发先到者占 / 后到者重试、v1→v2 自动补整段。
