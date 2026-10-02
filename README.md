# X-WIDE Preset Switch Plus

**把整个工作流的状态存成几套预设，点一下整体切换** —— 节点的**开关状态（bypass / mode）**和**参数值（widget）**一起切换。

支持**子模式**（一个模式下面挂多套子状态）、**缺失节点红点提示**、**清爽模式**、
以及**快捷键一键收起/展开面板**。

> 这是 [CarlMarkswx/comfyui_workflow_preset_switch](https://github.com/CarlMarkswx/comfyui_workflow_preset_switch) 的增强版（GPL-3.0），由 **X-WIDE** 维护。
> 原版只记录节点的 bypass / mode 状态；**本版额外记录并还原节点的 widget 参数值**。

在节点搜索框里输入 **`xwide`** / **`x-wide`** / **`X-WIED`** / **`预设`** / **`子模式`** 都能直接搜到（已配置搜索别名）。

<p align="center">
  <img src="web/preview.png" alt="X-WIDE Preset Switch 节点面板" width="420">
  <br>
  <sub>节点面板：预设列表 · 红点缺节点提示 · 完整/清爽模式 · 操作按钮 · 快捷键</sub>
</p>

---

## 解决的问题

工作流里有多个状态时（比如「文生图 / 图生图 / 图像编辑」），每次切换都要手动改好几个地方：

- 某个开关要改成 `1` 或 `2`
- 另一个开关要改成 `true` 或 `false`
- 还有几个节点要开或者要关

**改漏一个就出错，而且很难发现。** 这个插件让你把这些组合存成预设，以后只点一下。

```
        ┌─────────────────────────────────────────┐
        │  X-WIDE Preset Switch                   │
        │  ┌───────────────────────────────────┐  │
        │  │ ▼ 0  生图模式                     │  │ ← 点这行切模式
        │  │   └ 0-1 官方提示词优化 开          │  │ ← 子模式，只覆盖差异
        │  │   └ 0-2 官方提示词优化 关          │  │
        │  │   1  图像编辑模式              ●  │  │ ← 红点 = 有节点被删了
        │  ├───────────────────────────────────┤  │
        │  │ 当前 0-1 · …           [清爽模式] │  │
        │  │                                   │  │
        │  │ [＋预设][＋子模式] [●记录当前][🗑删除] [◀][▶] │
        │  └───────────────────────────────────┘  │
        └─────────────────────────────────────────┘
             开关状态 + 参数值，一起切
```

---

## 相比原版

| 能力 | 原版 | 本版 v0.12.19 |
|---|:---:|:---:|
| 记录/还原节点 bypass、mode | ✅ | ✅ |
| 记录/还原 widget 参数值 | ❌ | ✅ |
| 子模式（一个模式下面挂多套子状态） | ❌ | ✅ |
| 缺失节点红点提示 + 一键忽略 | ❌ | ✅ |
| 清爽模式（隐藏操作按钮） | ❌ | ✅ |
| **快捷键一键收起/展开 + 自定义 + 冲突提示** | ❌ | ✅ |
| 节点搜索别名（按 X-WIDE 搜到） | ❌ | ✅ |
| 预设浏览器 / 改名 / 增删 | ✅ | ✅ |
| 分组三态面板（Group Editor） | ✅ | ✅ |
| 节点类型名 | `PresetSwitch` | 同名，**可直接迁移** |

---

## 安装

### 方式一：ComfyUI Manager（推荐）

Manager → **Install via Git URL** → 填入本仓库地址：

```
https://github.com/XWIDE/comfyui-preset-switch-plus
```

### 方式二：手动

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/XWIDE/comfyui-preset-switch-plus.git
```

**没有依赖，不用 pip 安装任何东西。** 装完重启 ComfyUI。

> ⚠️ **不要和原版 `comfyui_workflow_preset_switch` / `comfyui_workflow_state_presets` 同时安装**，
> 两者注册的节点类型名相同，会冲突。装本版前请先删掉原版目录。

---

## 用法

### 1. 加节点

画布空白处双击 → 搜 **`xwide`** 或 **`预设`** 或 **`Preset Switch`**
（分类：`X-WIDE/Preset`，显示名 `X-WIDE Preset Switch 预设开关`）。

### 2. 存第一套状态

1. 把工作流**摆成第一套的样子**（该开的开、该改的参数改好）
2. `preset_index` 设成 **`0`**
3. 点 **`● 记录当前`**
4. **双击列表里那一行** → 输入名字，比如 `生图模式`

### 3. 存第二套状态

1. 把工作流**摆成第二套的样子**
2. 点 **`＋ 预设`**（会自动新建 `1` 并切过去）
3. 点 **`● 记录当前`**，再双击改名，比如 `图像编辑模式`

> 存几套就重复几次，编号递增即可。

### 4. 切换

- **点列表里的一行** → 整套状态立刻套用
- 或者改 `preset_index` 的数字，效果一样
- `◀` / `▶` 按「父模式 → 它的子模式 → 下个父模式」的顺序前后翻

---

## 子模式（0.3.0 新增）

同一套大模式下面如果想再分几种小状态，就用子模式。典型场景：

> **生图模式**下面要分「官方提示词优化 开 / 关」两种；**图像编辑模式**下面也一样。
> 差别只有那么一两个节点，不想为每种组合再建一个完整的顶层模式。

### 怎么建

1. 先把**父模式**摆好并点 `● 记录当前`（比如 `0 生图模式`）
2. 在父模式状态下，**只改你要变的那些东西**（例如把"官方提示词优化"节点设成跳过）
3. 点 **`＋ 子模式`** → 自动生成 `0.1` 并记录当前状态
4. 再改一次（换个组合），再点 `＋ 子模式` → 生成 `0.2`
5. 双击行改名，比如 `0-1 官方提示词优化 开` / `0-2 官方提示词优化 关`

### 怎么工作

点子模式时，插件**先恢复父模式的状态，再叠加这个子模式记录的差异**。
所以子模式是"在父模式基础上的增量覆盖"，不用把整套状态重复存一遍。

### 面板交互

| 操作 | 效果 |
|---|---|
| 点**父模式行的文字** | 切到该模式，并展开它的子模式 |
| 点**子模式行的文字** | 先恢复父模式，再叠加子模式的差异 |
| 点左侧 **▶ / ▼ 三角** | 只展开或收起，**不会改变当前生效的模式**（防误触） |
| 双击任意行 | 重命名该预设 |
| 上下拖动行 | 同层内重排（父模式和父模式换、子模式和同父的兄弟换） |

---

## 缺失节点红点提示（0.3.0 新增）

记录预设时会记住每一行快照来自哪个节点。如果你后来**把某个节点删掉了**，
那个预设本身就不完整了——插件会提示你，而不是默默跳过。

### 表现

1. 套用（或切换）到那个预设时，检测到被记录的节点已经不在画布里
2. 该行**末尾出现红点**；缺多个时红点旁边标出数量
3. **鼠标悬停红点** → 提示"缺少 N 个节点：节点类型A、节点类型B…"
4. **点击红点** → 弹出窗口，列出缺失节点的**类型和 ID**，可以：
   - **复制清单** —— 拿去画布里把缺的节点加回来
   - **忽略这条记录（去掉红点）** —— 确认这些节点不再需要，把它们从该预设的记录里摘掉，
     红点消失，以后不再提示

> 如果你**重新点一次 `● 记录当前`**，提示状态会自动重置（因为新记录里已经包含当前真实节点）。

---

## 清爽模式（0.3.0 新增）

预设都调好之后，整条工具栏（`＋预设` / `＋子模式` / `●记录当前` / `🗑删除` / `◀` / `▶`）
平时就用不到了。

**点面板右侧的「清爽模式」开关**，整条工具栏一起隐藏，只留下预设列表，界面立刻干净。
再点一下恢复。开关状态会**跟着工作流一起保存**。

---

## 实际例子：一个开关切换「文生图 / 图生图」

假设你有两个文本编码器、两套提示词，各自对应一种模式：

**存 `0 文生图` 时**：`CLIP` 开关 = t2i、提示词开关 = `true`
**存 `1 图生图` 时**：`CLIP` 开关 = i2i、提示词开关 = `false`

存好之后，**点列表里的一行，两个开关的布尔值一起变**，不用再手动改两处。

配合 `Preset Group Editor` 还能把"哪些模块要跑"也一起切（比如图生图时才加载的相机旋转模块）。

---

## 按钮说明

工具栏按用途分成三组，组间留有空隙：

| 分组 | 按钮 | 作用 |
|---|---|---|
| **新增** | `＋ 预设` | 新建一个顶层预设并切过去 |
| | `＋ 子模式` | 在**当前模式**下面新建一个子模式，记录当前状态 |
| **记录** | `● 记录当前` | 把**当前状态**覆盖存进当前生效的那个预设（最常用，琥珀色高亮） |
| | `🗑 删除` | 删除当前预设（删父模式会连它的子模式一起删） |
| **切换** | `◀` / `▶` | 按「父模式 → 它的子模式 → 下个父模式」的顺序前后翻 |

> 每个按钮鼠标悬停都会显示完整说明。改 `preset_index` 数字、或直接点列表里的行，
> 同样可以切换，所以 `◀` / `▶` 只占两个小箭头的位置。

| 其它 | 作用 |
|---|---|
| 预设列表 | **点一行即切换**，双击改名，上下拖动同层重排 |
| 左侧 `▶` / `▼` | 只展开 / 收起子模式，**不改变**当前生效的模式 |
| 行尾红点 | 该预设记录的节点已不在画布里，悬停看摘要、点击看详情 |
| 清爽模式开关 | 隐藏整条工具栏，只留预设列表（状态随工作流保存） |
| **X-WIDE 徽章** | 点一下打开作者主页（B 站） |
| `⚙ 设置` | 快捷键、署名、浮层缩放范围 |

---

## 署名徽章

面板表头左侧有一个白色小徽章，显示 **X-WIDE logo**，点一下打开作者主页：

**https://space.bilibili.com/374064919**

> 其中的数字是 B 站账号 **UID，永久不变**（改昵称也不影响），所以这个地址可以长期使用。
> 原分享链接里的 `?spm_id_from=…` 只是流量来源追踪参数，已去掉。

在 `⚙ 设置` 里可以改三项：

| 设置 | 说明 |
|---|---|
| 署名文字 | 没有 logo 图时显示这段文字 |
| 跳转网址 | 徽章点开的目标，**只放行 http/https**（`javascript:` 会被拒绝） |
| logo 图片 | 插件内相对路径（如 `./logo_xwide.png`）或完整网址；**留空则回退成文字徽章** |

随插件附带两个切好的 logo，按需要填进设置：

| 文件 | 尺寸 | 适合 |
|---|---|---|
| `web/logo_xwide.png` | 600×300（2:1） | 默认，X 图形 + X-WIDE 字 |
| `web/logo_xwide_icon.png` | 128×128（1:1） | 想更小、只要 X 图形时填这个 |

---

## 快捷键（0.5.0 新增）

默认 **<kbd>Alt</kbd> + <kbd>X</kbd>**：在 ComfyUI 页面里按一下 **进入清爽模式**
（收起整条工具栏，只留预设列表），再按一下退出。在输入框里打字时不会抢键。

在 `⚙ 设置` 里可以把快捷键的动作改成 **「收起 / 展开整个面板」**（节点只剩标题栏），
适合需要完全腾出画布的场景。

### 改成你喜欢的键

点工具栏最右侧 **`⚙ 设置`** → 点快捷键输入框 → **直接按下你想要的组合键**。
设置界面会立刻告诉你这个组合能不能用：

| 提示 | 含义 | 例子 |
|---|---|---|
| ✕ 系统/浏览器保留 | 按了根本到不了页面，**用不了** | <kbd>Alt</kbd>+<kbd>Space</kbd>、<kbd>F5</kbd>、<kbd>Ctrl</kbd>+<kbd>W</kbd> |
| ✕ 与 ComfyUI 冲突 | 会被 ComfyUI 抢走，**用不了** | <kbd>Ctrl</kbd>+<kbd>Enter</kbd>、<kbd>Ctrl</kbd>+<kbd>S</kbd> |
| ! 容易误触 | 能注册，但代价大 | <kbd>Delete</kbd>、空格、无修饰键 |
| ✓ 可用 | 未发现冲突 | <kbd>Alt</kbd>+<kbd>X</kbd>、<kbd>Alt</kbd>+<kbd>J</kbd> |

也可以点「清除快捷键」完全关掉（面板仍可从节点上操作），或「恢复默认」。

> ⚠️ 快捷键只在 **ComfyUI 页面里**有效。想在 Photoshop、浏览器地址栏等
> **任何程序里**都能唤出，需要另外做一个操作系统级的全局热键工具，那已经不属于这个插件。

### 浮层缩放范围

工具栏、红点、开关会跟随画布缩放，但夹在设定的上下限之间（默认 `0.8 ~ 1.4`），
这样画布放到很大时按钮不会跟着变成巨块把面板挡住，缩到很小时也不至于点不中。

设置存放在浏览器 `localStorage`，**所有工作流共用**；预设内容仍然各自跟着自己的工作流走。

---

## 选项（可选）

在节点右键 → `Properties` 或工作流元数据里可调：

| 选项 | 默认 | 说明 |
|---|---|---|
| `onUntrackedNode` | `bypass` | 不在预设里的**新节点**如何处理：`bypass` 跳过 / `enable` 启用 / `preserve` 保持不变 |
| `onMissingNode` | `skip` | 预设里的节点已被删除时的行为（红点提示不受此项影响，始终提示） |
| `indexOutOfRange` | `warn` | `preset_index` 指向不存在的预设时 |
| `hideCrudButtons` | `false` | 是否开启清爽模式（面板右上角开关控制） |

> 💡 新加了节点却发现"它自己变成紫色的（被跳过）"，就是这个 `onUntrackedNode` 在起作用。
> 把它 `Record` 进每个预设，或者改成 `preserve`。

### 排查用的小工具

工具栏、红点、清爽模式开关、署名徽章都是浮在画布上的 HTML 元素。
如果它们显示异常，打开浏览器控制台（F12）执行：

```js
__wpsOverlay.info()      // 打印基准点、缩放、被拒绝的测量值、各按钮坐标
__wpsOverlay.lastReject  // 上一次被判定为不可信的控件测量值
```

面板表头右侧显示当前版本号（如 `v0.12.19`），设置界面标题旁也会显示，
方便确认浏览器里跑的是哪一版。

---

## 注意事项

- **预设保存在工作流文件里**（`workflow.graph.extra`），跟着工作流走，分享出去也带着。
- **从 0.1.0 升级后请重新记录**：旧版存的预设里没有 widget 数据。
  从 0.2.0 起升级**不用**重新记录，老记录会自动补出缺失节点检测所需的信息。
- **子模式只有一层**：`0.1` 下面不能再挂 `0.1.1`。需要更细的划分就再开一个顶层模式。
- **如果参数值被输入端口接管，还原时不会生效**：widget 一旦被连线占用，实际取值来自上游节点，
  预设里的值会被覆盖。这种情况请改为对上游节点做预设。
- 「不用的分支也会执行」是 ComfyUI 的机制，不是本插件的行为。想避免白跑，
  用 `Preset Group Editor` 把不用的模块设成跳过（BYPASS）。

---

## License

**GPL-3.0**，与原版一致。

本仓库是 [CarlMarkswx/comfyui_workflow_preset_switch](https://github.com/CarlMarkswx/comfyui_workflow_preset_switch)（作者 CarlMarkswx，GPL-3.0）的修改版本，
修改内容见 [CHANGELOG.md](CHANGELOG.md)。原版版权归原作者所有。

---

## English

**X-WIDE Preset Switch Plus** — save whole-workflow states (node bypass/mode **plus widget values**) and switch between them with one click.

Beyond the original, this version adds:

- **Sub-modes** — a top-level mode (`0`) can hold sub-states (`0.1`, `0.2`). Clicking a sub-mode restores the parent first, then layers that sub-mode's differences on top, so you only record the deltas.
- **Missing-node badge** — presets remember which nodes they were recorded from. If a node is later deleted, the row shows a red dot: hover for a summary, click for the full type/ID list, with a one-click *"forget this record"* to dismiss it.
- **Compact mode** — a toggle in the panel hides the whole action toolbar, leaving just the preset list. The setting is saved with the workflow.
- **Search aliases** — search the node menu for `xwide`, `x-wide`, `X-WIED`, `preset` or `预设`.

The toolbar is grouped by purpose: *add* (`＋ preset`, `＋ sub-mode`), *record* (`● record current` — highlighted,
`🗑 delete`), and *navigate* (`◀` `▶`). All overlay controls scale with the canvas.

Install via ComfyUI Manager → *Install via Git URL* → this repository URL. No dependencies.
Node type names (`PresetSwitch`, `PresetGroupEditor`) are unchanged, so existing workflows keep working.

Workflow: place the graph in state A → `preset_index = 0` → `● record current`; place it in state B → `＋ preset` → `● record current`. Afterwards click a row in the preset list to apply the whole state.

Licensed under **GPL-3.0**. This is a modified version of [CarlMarkswx/comfyui_workflow_preset_switch](https://github.com/CarlMarkswx/comfyui_workflow_preset_switch); see [CHANGELOG.md](CHANGELOG.md).
