# UI 升级 Skill - Figma UI 替换方案

将 Figma 生成的 UI 代码还原到现有 Vue 项目中，页面需要100%还原（要求布局、颜色、样式，字体，字体颜色，等百分之百还原到本项目），不要破坏功能逻辑和接口调用。

## 触发条件

当用户请求以下内容时触发：

- "UI升级"、"Figma UI 替换"
- "把 Figma 生成的 UI 替换到现有项目"
- 指定特定页面从 Figma UI 文件夹替换

## 源文件位置

**Figma UI 项目**: `D:\20260511\UI\拓影ToVid`

结构概览：

```
拓影ToVid/src/app/
├── components/
│   ├── Home.tsx          # 首页（含 Banner 轮播、统计卡片、视频列表）
│   ├── Layout.tsx        # 布局（侧边栏导航、用户信息）
│   ├── Login.tsx         # 登录页
│   ├── AiCreation.tsx     # AI 创作页
│   ├── Assets.tsx         # 素材库页
│   ├── Pricing.tsx        # 定价页
│   ├── Replication.tsx    # 爆款复刻页
│   └── UserProfile.tsx    # 用户中心页
├── ui/                   # shadcn/ui 基础组件库
│   ├── button.tsx
│   ├── card.tsx
│   ├── badge.tsx
│   ├── dropdown-menu.tsx
│   └── ...
└── routes.tsx
```

**目标项目**: `D:\20260511\tovid\ai-video-java\ai-video-web`

```
src/views/
├── main/
│   ├── Main.vue          # 主布局（侧边栏导航）✅ 已完成
│   ├── TopBar.vue        # 顶栏 → 已合并到 Main.vue
│   ├── MenuNav.vue       # 菜单导航 → 已合并到 Main.vue
│   └── TopBarPersonalInfo.vue → 已合并到 Main.vue
├── home/
│   └── Index.vue         # 首页 ✅ 已完成
├── login/
│   └── Login.vue         # 登录页 ✅ 已完成
└── create/               # 创作流程（待完成）
    └── ...
```

## 源文件位置与目标项目项目路由对应关系

```
| 页面名称 | Figma UI (React)对应访问路由 | 目标项目 (Vue)对应访问路由 |
|------|------------------|----------------|
| 工作台 | http://localhost:5173/ | http://localhost:7007/resource |
| 素材库 | http://localhost:5173/assets | http://localhost:7007/resource |
| 爆款复刻 | http://localhost:5173/replication | http://120.27.112.103/create |
```

## 如果Figma UI 项目中，页面需要的图标等资源，现有项目没有，帮我找到需要的库，在现有项目中实现一下

## 已完成的工作

### 1. 主题变量文件

- **`src/assets/css/theme-figma.scss`** - Figma UI 主题色变量文件
  - 定义了 Figma/shadcn CSS 变量到 Element Plus CSS 变量的映射
  - 支持亮色/暗色主题切换

### 2. 布局重构 (Main.vue)

- 将顶部导航栏改为左侧边栏布局
- Logo 区域 + 导航菜单 + 用户信息
- 主题切换按钮（暗色/亮色模式）
- 算力充值卡片
- 暗色模式极光背景装饰

### 3. 首页重构 (Index.vue)

- Banner 3D 轮播区域（3张轮播卡片）
- 统计卡片（我的素材/脚本库/累计生成）
- 最近创作视频网格
- 保留所有原有接口调用

### 4. 登录页重构 (Login.vue)

- 左侧品牌区域（Logo + 标语 + 版权信息）
- 右侧登录表单区域
- 响应式适配（移动端/桌面端）
- 保留 UserLoginForm 组件

### 5. 入口文件更新 (main.ts)

- 引入 `theme-figma.scss` 主题文件

## 核心技术差异

| 方面   | Figma UI (React)                     | 目标项目 (Vue)                         |
| ------ | ------------------------------------ | -------------------------------------- |
| 框架   | React 18 + TypeScript                | Vue 3.3 + TypeScript                   |
| 组件库 | shadcn/ui (Radix)                    | Element Plus                           |
| 样式   | Tailwind CSS (oklch 颜色)            | SCSS + CSS 变量                        |
| 主题   | CSS 变量 `--primary`, `--background` | Element Plus 变量 `--el-color-primary` |
| 动画   | Framer Motion                        | CSS transitions                        |
| 图标   | Lucide React (fa-solid)              | Element Plus Icons (i-ep-\*)           |

## 替换原则

### 1. 功能不变原则

- **保留所有 API 接口调用**：如 `getCreateRecordList()`, `getHomeStats()` 等
- **保留所有业务逻辑**：状态管理、路由跳转、表单验证等
- **保留所有交互行为**：点击、拖拽、弹窗等

### 2. 样式替换策略

- **颜色变量映射**：将 Tailwind 的 `--primary` 等映射到 Element Plus 的 `--el-color-primary`
- **布局适配**：React 的 Flex/Grid 布局转为 Vue 的 SCSS 布局
- **组件映射**：shadcn/ui Button → Element Plus ElButton

### 3. 主题系统映射

**Tailwind/shadcn 变量 → Element Plus 变量对照表**：

| Figma (Tailwind)     | Element Plus                | 用途        |
| -------------------- | --------------------------- | ----------- |
| `--primary`          | `--el-color-primary`        | 主色调      |
| `--background`       | `--el-bg-color-page`        | 页面背景    |
| `--foreground`       | `--el-text-color-primary`   | 主文字      |
| `--muted-foreground` | `--el-text-color-secondary` | 次要文字    |
| `--card`             | `#ffffff`                   | 卡片背景    |
| `--border`           | `--el-border-color`         | 边框色      |
| `--destructive`      | `--el-color-danger`         | 危险/错误色 |
| `--secondary`        | `--el-fill-color`           | 次要背景    |

## 待完成的工作

### 阶段 3：其他业务页面（根据需要）

- [ ] `views/resource/index.vue` - 素材库页面
- [ ] `views/segmentVideo/index.vue` - 视频切片页面
- [ ] `views/create/index.vue` - 创作流程页面
- [ ] `views/segmentVideo/index.vue` - 其他业务页面

### 阶段 4：细节优化

- [ ] 暗色模式下的 Banner 样式优化
- [ ] 移动端响应式细节调整
- [ ] 动画过渡效果优化

## 图标映射表

Figma (Lucide React) → Element Plus Icons:

| Figma                           | Element Plus                  |
| ------------------------------- | ----------------------------- |
| fa-solid fa-house               | i-ep-HomeFilled               |
| fa-solid fa-folder-open         | i-ep-FolderOpened             |
| fa-solid fa-sparkles            | i-ep-Sparkle                  |
| fa-solid fa-wand-magic-sparkles | i-ep-MagicStick / i-ep-Wand   |
| fa-solid fa-video               | i-ep-VideoCamera              |
| fa-solid fa-image               | i-ep-Picture                  |
| fa-solid fa-file-lines          | i-ep-Collection               |
| fa-solid fa-clock               | i-ep-Clock                    |
| fa-solid fa-arrow-right         | i-ep-ArrowRight               |
| fa-solid fa-chevron-up/down     | i-ep-ArrowUp / i-ep-ArrowDown |
| fa-solid fa-play                | i-ep-VideoPlay                |
| fa-solid fa-ellipsis-vertical   | i-ep-MoreVertical             |
| fa-solid fa-pen                 | i-ep-Edit                     |
| fa-solid fa-download            | i-ep-Download                 |
| fa-solid fa-trash               | i-ep-Delete                   |
| fa-solid fa-user                | i-ep-User                     |
| fa-solid fa-sun                 | i-ep-Sunny                    |
| fa-solid fa-moon                | i-ep-Moon                     |
| fa-solid fa-bolt                | i-ep-Lightning                |
| fa-solid fa-gift                | i-ep-Present                  |
| fa-solid fa-right-from-bracket  | i-ep-RightFromBracket         |

## 验证清单

替换完成后验证：

- [x] 首页数据正确加载（统计数字、创作记录）
- [x] 登录/登出功能正常
- [x] 路由跳转正常
- [x] 主题切换正常
- [ ] 响应式布局正常（待验证）
- [ ] 所有按钮点击事件正常
