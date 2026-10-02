import { app } from "../../../scripts/app.js";

/**
 * Preset Switch Plus
 *
 * Phase 1: bypass 套装记录/应用 + index 自动切换
 * Phase 2: 记录并还原节点 widget 参数值
 * Phase 3: 子模式（0 / 0.1 / 0.2）、缺失节点红点提示、界面清爽模式
 */

const EXTENSION_NAME = "comfyui.preset_switch_plus";
const TARGET_NODE_NAME = "PresetSwitch";
const STORE_KEY = "comfyui_workflow_state_presets_plus";
/*
 * 4 = 控件值改成"池化"存储（见 poolPresetWidgets）。
 * 读的时候两种形态都认（明文 / __w 指纹），所以老工作流不用迁移也不会丢数据。
 */
const STORE_VERSION = 4;

/**
 * 插件版本号。改版本时请与 pyproject.toml / __init__.py 的 version 保持一致，
 * 面板和设置界面会显示它，方便一眼确认浏览器里跑的是哪一版（前端是 no-store，
 * 刷新即最新；但确认一下总没错）。
 */
const PLUGIN_VERSION = "0.12.19";
const MODE_BYPASS = 4;
const MODE_ENABLE = Number.isFinite(globalThis?.LiteGraph?.ALWAYS)
  ? globalThis.LiteGraph.ALWAYS
  : 0;

const PANEL_PADDING = 8;
const ROW_HEIGHT = 26;
const HEADER_HEIGHT = 26;
const DIVIDER_HEIGHT = 9;
const TOOLBAR_HEIGHT = 34; // 底部那条：圆形清爽开关
/*
 * 缺失节点那个红点（里面写着 ! 或缺失数量）。
 *
 * 用户 m06099：「现在这个小感叹号，点不上」。原来的值偏保守
 * （半径 6、点击区 20），字号也只有 9px —— 画布一缩小，或者手一抖，
 * 就落不到那 20px 里。这里放大到半径 8、点击区 40、字号 11px。
 *
 * 注意 DOT_HIT 是**点击区**（正方形边长），不是画出来的直径
 * （画出来只有 DOT_RADIUS * 2 = 16px）。点击区比圆大一大圈是故意的。
 *
 * 为什么不能"只把 hitTestLenient 放宽"了事：hitTestLocal 里的
 * rowRects 横跨整行，一定先命中 "row"，宽松那条路实际上走不到
 * （v7 里"框外也能点中"那条断言一开始就是被这个坑打红的）。
 * 要真放宽，就得放宽 missingRects 这个框本身。
 */
const DOT_RADIUS = 8;
const DOT_HIT = 40;
const NODE_WIDTH = 480;

/*
 * 布局自愈的两个保险丝（见 layoutNeedsHeal / healNodeLayout）。
 *
 * 判据本身曾经差了一个标题栏高度，于是每 250ms 误报一次、无条件重排一次，
 * 把用户点控件的鼠标事件全吃掉了（"界面延迟点没有反应"）。
 * 判据已经修正，但这里再加两道硬约束，保证以后无论判据再怎么错，
 * 都不会退化成"每帧重排"：
 *   - LAYOUT_HEAL_SLACK：底边允许超出这么多像素，吸收浮点误差和圆整；
 *   - HEAL_MIN_INTERVAL_MS：同一个节点 1 秒内最多自愈一次。
 */
const LAYOUT_HEAL_SLACK = 4;
const HEAL_MIN_INTERVAL_MS = 1000;

/**
 * 节点能被拖到的最窄宽度。
 *
 * 存在的唯一理由是"挡手抖"：再窄连一行状态文字都放不下，那不是用户想要的窄，
 * 是拖过头了。**不要**把它调成 `computeSize()[0]`（按钮标签不截断所需的宽度）——
 * 那样等于让控件决定节点宽度，用户就再也拖不窄了，而这正是 v0.12.14 修掉的毛病
 * （用户 m05646 第 1 条：「它不可能拖宽拖窄」）。
 */
const NODE_MIN_WIDTH = 300;

/**
 * 估算一个双语按钮名需要多宽。
 *
 * ComfyUI 会把名字里的 "中文 / English" 拆成上下两行画，所以宽度只取决于
 * 较长的那一半；再给左右内边距留出余量。
 */
function labelMinWidth(name) {
  const text = String(name || "");
  const parts = text.split("/").map((s) => s.trim()).filter(Boolean);
  const longest = parts.length ? Math.max(...parts.map((p) => p.length)) : text.length;
  // 中文按 13px/字、英文按 7.5px/字符粗估，再加 60px 内边距
  const hasCjk = /[\u4e00-\u9fa5]/.test(text);
  return Math.round(longest * (hasCjk ? 13 : 7.5) + 60);
}
const OVERLAY_Z = 12000;

/* ------------------------------------------------------------------ *
 *  浮层控件（红点 / 清爽模式开关 / 工具栏）
 *
 *  addCustomWidget 收到的鼠标坐标是 DOM 元素的 offsetX/offsetY，
 *  与画布坐标不同源，靠 canvas 做精确区域命中不可靠。
 *  因此交互控件一律用真正的 HTML 元素浮在画布上，
 *  并按画布缩放同步缩放，保证视觉大小和点击区域始终一致。
 * ------------------------------------------------------------------ */

/** 设置窗口的样式（大字号、紧凑间距），注入一次即可 */
function installSettingsStyle() {
  if (document.getElementById("wps-settings-style")) return;
  const style = document.createElement("style");
  style.id = "wps-settings-style";
  style.textContent = `/* 字号比 ComfyUI 原生弹窗明显大一档：用户反馈"设置面板字太小"。
   基准 15px（原来是 13px），层级 h1 22 / h2 18 / 正文 15 / 说明 14 / 页脚 12。
   正文用 em 而不是固定 px，这样以后只改基准一行就能整档放大。 */
.wps-set {
  font: 15px/1.6 "Segoe UI", "Microsoft YaHei", Arial, sans-serif;
  color: #e6e6e6;
  min-width: 460px;
  max-width: 620px;
}
.wps-set h1 {
  font-size: 22px; font-weight: 600; color: #ffd479;
  margin: 0 0 14px 0; padding-bottom: 10px; border-bottom: 1px solid #3a3a3a;
}
.wps-set h2 {
  font-size: 18px; font-weight: 600; color: #e2e6ea;
  margin: 0 0 10px 0;
}
.wps-set .sec { margin-top: 16px; padding-top: 14px; border-top: 1px solid #33373d; }
.wps-set .hint { font-size: 0.94em; color: #9aa0a8; line-height: 1.6; margin: 0 0 8px 0; }
.wps-set .row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.wps-set .row > label { font-size: 0.94em; color: #aeb4bb; flex: none; }

.wps-set input[type="text"],
.wps-set input[type="number"] {
  box-sizing: border-box; padding: 9px 11px; border-radius: 6px;
  border: 1px solid #555; background: #1b1b1b; color: #e6e6e6;
  font-size: 15px; font-family: inherit;
}
.wps-set input[type="number"] { width: 92px; }
.wps-set input[type="text"]:focus,
.wps-set input[type="number"]:focus { outline: none; border-color: #79a9ff; }

#wps-hotkey-input {
  width: 100%; text-align: center; cursor: pointer;
  font: 600 18px Consolas, monospace; color: #ffd479; padding: 14px;
}
.wps-set .status { font-size: 0.94em; line-height: 1.6; margin: 10px 0 12px 0; }
.wps-set .btns { display: flex; gap: 10px; flex-wrap: wrap; }

.wps-set button.comfy-btn,
.wps-set .wps-btn2 {
  padding: 9px 16px; border-radius: 6px; border: 1px solid #555;
  background: #3a3a3a; color: #ddd; cursor: pointer; font-size: 15px;
}
.wps-set button.comfy-btn:hover { background: #4a4a4a; border-color: #6a707a; }

.wps-set .radios { display: flex; flex-direction: column; gap: 9px; }
.wps-set .radios label {
  display: flex; align-items: flex-start; gap: 10px;
  font-size: 15px; color: #cfd4da; cursor: pointer; line-height: 1.55;
}
.wps-set .radios input { margin: 3px 0 0 0; flex: none; }
.wps-set .check {
  display: flex; align-items: flex-start; gap: 10px;
  font-size: 15px; color: #cfd4da; cursor: pointer; line-height: 1.55;
}
.wps-set .check input { margin: 3px 0 0 0; flex: none; }

.wps-set .card {
  display: flex; align-items: center; gap: 14px;
  background: #1b1b1b; border: 1px solid #3a3a3a; border-radius: 8px;
  padding: 12px 14px; margin-bottom: 10px;
  /* 卡片不许横向撑满：用户反馈"里面内容铺太开"，把人名和链接甩到两头去了 */
  max-width: 470px;
}
.wps-set .card img {
  width: 96px; height: 96px; object-fit: contain; flex: none;
  background: #f4f5f7; border: 1px solid #c9ced4; border-radius: 8px;
}
/* 文字列必须能收缩，否则 flex 会把它顶到卡片最右边 */
.wps-set .card > div:not([class]) { min-width: 0; flex: 1 1 auto; }
.wps-set .card .who { font-size: 17px; font-weight: 600; color: #ffd479; margin-bottom: 5px; }
.wps-set .card .what { font-size: 14px; color: #9aa0a8; line-height: 1.65; }
.wps-set .card a { color: #79a9ff; text-decoration: underline; font-size: 14px; }
.wps-set .card a:hover { color: #a8c8ff; }

.wps-set .ver {
  margin-top: 20px; padding-top: 14px; border-top: 1px solid #33373d;
  font-size: 12px; color: #6f757d; text-align: center; line-height: 1.9;
}

/* 顶掉 ComfyUI 原生那两套会把设置窗口撑开的规则。
   ComfyDialog 把内容塞进一个 <p> 里，而 bundle 里写着
   .comfy-modal p{white-space:pre-line;margin-bottom:20px;overflow:auto} ——
   pre-line 会把模板字符串里的**每一个换行都当成真换行**，
   于是 buildSettingsBody() 里所有缩进都变成标题下面一大片空行。 */
.comfy-modal > .comfy-modal-content > p {
  white-space: normal;
  margin-bottom: 0;
  overflow: visible;
}

/* 作者卡片那一段没有分隔线，也不该有上边距 */
.wps-set .sec.first { margin-top: 0; padding-top: 0; border-top: none; }

/* ------------------------------------------------------------------ *
 *  设置窗口：自建 DOM，不再走 ComfyUI 的 .comfy-modal
 *
 *  v0.12.14 换的。以前是给原生 .comfy-modal 打补丁（它的
 *  max-height:80vh + overflow:hidden 会把下半截连关闭按钮一起裁掉，
 *  用户实测「图1 无法看全。还关不了」），再给 ComfyDialog 的构造函数
 *  包一层去重（它每 new 一次就往 body 追加一个窗口，点两次就叠两个，
 *  用户实测「又出现了上面那个弹开的问题」）。
 *
 *  两个补丁都是在改别人的东西：人家的 CSS 一升级就白打，人家的构造函数
 *  只要有一条路绕过我们的包装，叠窗就回来了。现在窗口完全是我们自己的节点
 *  （buildSettingsWindow()），这三件事一次性都没了：
 *    · 唯一性 = 结构保证（先拆旧的再造新的），不再靠包装构造函数；
 *    · 高度 = 我们自己写 max-height: 88vh，正文那一栏自己滚；
 *    · 尺寸 = resize: both，用户可以像普通窗口一样拖宽拖窄。
 *
 *  resize 只在 overflow 不是 visible 时才生效，所以这里是 overflow:auto
 *  而不是 visible —— 这个组合是 CSS 规范要求的，不是随手写的。
 *
 *  【注意】本段整个位于一个 JS 模板字符串里，注释里**不能出现反引号**：
 *  一个反引号就会把模板字符串提前闭合，整份文件当场变成语法错误
 *  （v0.12.14 写这段时就踩了一次，而且是连着踩了两次 —— 第二次是在
 *    这条警告自己的文字里又写了一个反引号。所以别指望肉眼检查：
 *    必须复制成 .mjs 再跑 node --check，对 .js 直接 check 是按 CommonJS
 *    解析的，不报这个错。）
 * ------------------------------------------------------------------ */
.wps-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1400;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
}
.wps-modal {
  display: flex;
  flex-direction: column;
  width: min(680px, 92vw);
  min-width: 360px;
  height: min(760px, 88vh);
  min-height: 240px;
  max-width: 96vw;
  max-height: 92vh;
  padding: 16px 20px 12px;
  box-sizing: border-box;
  background: var(--comfy-menu-bg, #202020);
  color: var(--fg-color, #ddd);
  border: 1px solid #4a4a4a;
  border-radius: 10px;
  box-shadow: 0 0 24px #000a;
  font-family: monospace;
  font-size: 14px;
  overflow: auto;
  resize: both;
}
.wps-modal-title {
  flex: none;
  margin-bottom: 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid #3a3a3a;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.5px;
}
.wps-modal-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  padding-right: 8px;
  /* 长名字、长网址不许把窗口撑破 */
  overflow-wrap: anywhere;
}
.wps-modal-foot {
  flex: none;
  display: flex;
  justify-content: flex-end;
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid #3a3a3a;
}
.wps-modal-close {
  padding: 6px 18px;
  border-radius: 5px;
  border: 1px solid #555;
  background: #3a3a3a;
  color: #eee;
  cursor: pointer;
  font-size: 13px;
}
.wps-modal-close:hover {
  background: #4a4a4a;
}

/* 排除清单 / 帮助文档：比设置窗口宽一点，列表和文档都要横向空间
   （注意：CSS 注释里绝对不能出现反引号，外层是模板字符串） */
.wps-modal-wide {
  width: min(980px, 96vw);
  height: min(820px, 92vh);
}
.wps-help-host {
  padding: 0;
  overflow: hidden;
  position: relative;
}
.wps-help-frame {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border: 0;
  background: #1b1e24;
}
.wps-help-open {
  margin-right: auto;
  align-self: center;
  color: #7fb2ff;
  font-size: 13px;
  text-decoration: none;
}
.wps-help-open:hover {
  text-decoration: underline;
}
.wps-ex-head {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin: 10px 0 8px;
}
.wps-ex-search {
  flex: 1 1 220px;
  min-width: 160px;
  padding: 5px 8px;
  border-radius: 5px;
  border: 1px solid #555;
  background: #2a2a2a;
  color: #eee;
  font-family: inherit;
  font-size: 13px;
}
.wps-ex-only {
  flex: none;
  color: #b9bec6;
  font-size: 13px;
  cursor: pointer;
}
.wps-ex-clear {
  flex: none;
  padding: 5px 12px;
  border-radius: 5px;
  border: 1px solid #555;
  background: #3a3a3a;
  color: #eee;
  cursor: pointer;
  font-size: 13px;
}
.wps-ex-clear:hover {
  background: #4a4a4a;
}
.wps-ex-summary {
  margin-bottom: 6px;
  color: #8b9199;
  font-size: 13px;
}
.wps-ex-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.wps-ex-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 6px;
  border-radius: 4px;
  background: #262626;
}
.wps-ex-row.is-excluded {
  background: #33272a;
}
.wps-ex-toggle {
  flex: none;
  width: 74px;
  padding: 3px 0;
  border-radius: 4px;
  border: 1px solid #555;
  cursor: pointer;
  font-family: inherit;
  font-size: 12px;
}
.wps-ex-toggle.is-on {
  background: #2f6b3f;
  border-color: #4c9a5e;
  color: #d8f5e0;
}
.wps-ex-toggle.is-off {
  background: #6e2626;
  border-color: #b3352f;
  color: #ffd7d7;
}
.wps-ex-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wps-ex-row.is-excluded .wps-ex-name {
  color: #e59a9a;
}
.wps-ex-type {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #8b9199;
  font-size: 12px;
}
.wps-ex-id {
  flex: none;
  color: #6b7079;
  font-size: 12px;
}
.wps-ex-empty {
  padding: 14px 4px;
  color: #8b9199;
}
 `;
  document.head.appendChild(style);
}

function installOverlayStyle() {
  if (document.getElementById("wps-overlay-style")) return;
  const style = document.createElement("style");
  style.id = "wps-overlay-style";
  style.textContent = `
    .wps-layer {
      position: absolute; top: 0; left: 0; width: 100%; height: 100%;
      overflow: hidden; pointer-events: none; z-index: ${OVERLAY_Z};
    }
    .wps-el {
      position: absolute; box-sizing: border-box; margin: 0;
      transform-origin: top left; pointer-events: auto;
    }

    /* 红点 */
    .wps-dot {
      border: 2px solid #7a1f1f; border-radius: 50%;
      background: #ff3b3b; cursor: pointer; padding: 0;
      transition: background .12s, box-shadow .12s;
    }
    .wps-dot:hover {
      background: #ff6b6b;
      box-shadow: 0 0 0 3px rgba(255,60,60,.45), 0 0 10px rgba(255,60,60,.7);
    }

    /* 清爽模式开关 */
    .wps-badge {
      border-radius: 8px; border: 1px solid #4a4f57;
      background: #33373d; color: #aeb4bb;
      cursor: pointer; padding: 0;
      display: flex; align-items: center; justify-content: center;
      white-space: nowrap; transition: background .12s, border-color .12s, color .12s;
    }
    .wps-badge:hover { border-color: #6a707a; color: #dfe3e8; }
    .wps-badge.wps-on { background: #3f6f4a; border-color: #5c9c6b; color: #e8f5ec; }

    /* 署名徽章（可点，打开作者主页） */
    .wps-brand {
      border-radius: 8px; border: 1px solid #4a4f57;
      background: #2a2d31; color: #9aa0a8;
      cursor: pointer; padding: 0;
      display: flex; align-items: center; justify-content: center;
      white-space: nowrap; overflow: hidden;
      font: 11px/1 Arial, sans-serif;
      transition: background .12s, border-color .12s, color .12s;
    }
    .wps-brand:hover {
      background: #3a3f46; border-color: #ff7ba8; color: #ffd7e4;
    }

    /* 工具栏按钮 */
    .wps-btn {
      border-radius: 6px; border: 1px solid #454a52;
      background: #2f3339; color: #d7dbe0;
      cursor: pointer; padding: 0;
      display: flex; align-items: center; justify-content: center;
      white-space: nowrap; overflow: hidden;
      transition: background .1s, border-color .1s, color .1s;
    }
    .wps-btn:hover { background: #3c424a; border-color: #6a707a; color: #ffffff; }
    .wps-btn:active { background: #262a2f; }

    .wps-btn.wps-primary {
      background: #7a5a1f; border-color: #b98c33; color: #ffe9b8; font-weight: 600;
    }
    .wps-btn.wps-primary:hover { background: #946d26; border-color: #d9a63f; color: #fff4da; }

    .wps-btn.wps-danger { border-color: #6e3a3a; color: #e8b6b6; }
    .wps-btn.wps-danger:hover { background: #4a2a2a; border-color: #a05050; color: #ffd9d9; }

    .wps-gap { pointer-events: none; background: transparent; border: none; }
  `;
  document.head.appendChild(style);
}

function ensureOverlayLayer() {
  if (overlay.layer && overlay.layer.isConnected) return overlay.layer;
  const parent =
    document.querySelector(".graph-canvas-container") ||
    document.querySelector("#graph-canvas")?.parentElement ||
    document.body;
  const layer = document.createElement("div");
  layer.className = "wps-layer";
  parent.appendChild(layer);
  overlay.layer = layer;
  overlay.buttons = new Map();
  return layer;
}

/** 节点被删除时，把它的浮层控件一并清掉 */
function disposeOverlayButtons(node) {
  const prefix = `${node?.id ?? "?"}::`;
  for (const [key, btn] of Array.from(overlay.buttons.entries())) {
    if (!key.startsWith(prefix)) continue;
    btn.remove();
    overlay.buttons.delete(key);
  }
}

const overlay = {
  layer: null,
  buttons: new Map(),
  raf: 0,
  node: null,
  lastReject: null, // 最近一次被判定为不可信的控件画布实测值（排查用）
  sync: (node) => syncOverlays(node),
  ensureLayer: () => ensureOverlayLayer(),
  anchor: () => panelAnchor(),
  state: (key) => computePresetState(key),
  refresh: (node) => refreshPresetWidgets(node),
  scale: () => overlayScale(),
};

/**
 * 自绘控件的画布元素。addCustomWidget 的绘制坐标以它为原点，
 * 浮层定位也必须以它为基准，否则会整体偏移。
 */
let nodeWidgetCanvasEl = null;

/*
 * 注意：控制台排查入口（__wpsOverlay / __wpsGeom / __wpsDiag / __wpsLib …）
 * 统一挪到文件末尾再挂。原因见文件末尾那一段的注释（TDZ）。
 */



function overlayKey(node, suffix) {
  return `${node.id ?? "?"}::${suffix}`;
}

/** 画布缩放比：浮层要按它缩放，才能和节点一起变大变小 */
function canvasScale() {
  const scale = app?.canvas?.ds?.scale;
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/**
 * 浮层实际使用的缩放系数：跟随画布，但夹在用户设定的上下限之间。
 * 上限防止画布放大时按钮变成巨块挡住面板，下限防止缩小时点不中。
 */
function overlayScale() {
  const anchor = panelAnchor();
  const raw = anchor ? anchor.pxPerUnit : canvasScale();
  return clampNumber(raw, config.scaleMin, config.scaleMax, 1);
}

/**
 * 找出"面板局部坐标 (0,0)"在屏幕上的位置。
 *
 * 只用 ComfyUI 自己拖节点时用的那套画布变换来算，不依赖任何 DOM 元素的
 * 测量值 —— 自绘控件的画布元素在 ComfyUI 重建 DOM widget 时会返回 (0,0)，
 * 那正是浮层跑到画面左上角的原因。
 *
 * 如果控件的画布元素确实存在、且它的测量结果与画布变换一致，就采用测量值
 * （能顺带修正 ComfyUI 内部的边距）；否则一律用画布变换的结果。
 */
function panelAnchor() {
  const layer = overlay.layer;
  if (!layer) return null;

  const layerRect = layer.getBoundingClientRect();
  const scale = canvasScale();
  const ds = app?.canvas?.ds;

  // 1) 由画布变换推出的、稳定的基准点
  const canvasEl = app?.canvas?.canvas;
  const canvasRect = canvasEl?.getBoundingClientRect?.();
  const baseLeft = canvasRect ? canvasRect.left - layerRect.left : 0;
  const baseTop = canvasRect ? canvasRect.top - layerRect.top : 0;

  const hasDs = ds && Number.isFinite(ds.offset?.[0]) && Number.isFinite(ds.offset?.[1]);
  const fromTransform = hasDs
    ? {
        left: baseLeft + ds.offset[0] * scale,
        top: baseTop + ds.offset[1] * scale,
      }
    : { left: baseLeft, top: baseTop };

  // 2) 用控件画布的实测值校验；只有两者吻合时才采信实测值
  const el = nodeWidgetCanvasEl;
  if (el && typeof el.getBoundingClientRect === "function") {
    const rect = el.getBoundingClientRect();
    const logicalW = Number(el.width) || rect.width;
    const sane =
      rect.width > 1 &&
      rect.height > 1 &&
      logicalW > 1 &&
      Number.isFinite(rect.left) &&
      Number.isFinite(rect.top);

    if (sane) {
      const measuredLeft = rect.left - layerRect.left;
      const measuredTop = rect.top - layerRect.top;
      const dx = Math.abs(measuredLeft - fromTransform.left);
      const dy = Math.abs(measuredTop - fromTransform.top);
      const tolerance = 48 + 24 * Math.abs(scale);

      if (dx <= tolerance && dy <= tolerance) {
        return {
          left: measuredLeft,
          top: measuredTop,
          pxPerUnit: rect.width / logicalW,
        };
      }

      overlay.lastReject = { dx: Math.round(dx), dy: Math.round(dy), tolerance: Math.round(tolerance) };
    }
  }

  return { left: fromTransform.left, top: fromTransform.top, pxPerUnit: scale };
}

function toLayerPoint(layer, localX, localY) {
  const anchor = panelAnchor();
  if (!anchor) return { x: 0, y: 0 };
  return {
    x: anchor.left + localX * anchor.pxPerUnit,
    y: anchor.top + localY * anchor.pxPerUnit,
  };
}

function ensureOverlayButton(node, suffix, className, spec) {
  const layer = ensureOverlayLayer();
  const key = overlayKey(node, suffix);
  let btn = overlay.buttons.get(key);

  if (!btn || !btn.isConnected) {
    btn = document.createElement("button");
    btn.type = "button";
    btn.className = `wps-el ${className}`;
    layer.appendChild(btn);
    overlay.buttons.set(key, btn);
    uiLogEvent("overlay+", `${key} (${className})`);
  }

  // 位置按面板局部坐标换算；尺寸再乘一次反向缩放抵消。
  // 反向缩放夹在 min/max 之间——画布放大到 3x 时如果完全跟随，
  // 按钮会变得巨大并把节点整个挡住，所以超过上限就保持固定屏幕尺寸。
  const inv = 1 / overlayScale();

  btn.style.left = `${spec.x}px`;
  btn.style.top = `${spec.y}px`;
  btn.style.width = `${spec.w}px`;
  btn.style.height = `${spec.h}px`;
  btn.style.transform = `scale(${inv})`;

  // 内容：署名徽章可以用图片（logo）代替文字。
  // 每次都重建，避免"文字→图片→文字"切换后留下空按钮。
  const wantImage = spec.image || "";
  const wantText = wantImage ? "" : spec.text || "";
  if (btn.__wpsImage !== wantImage || btn.__wpsText !== wantText) {
    btn.__wpsImage = wantImage;
    btn.__wpsText = wantText;
    btn.textContent = "";
    if (wantImage) {
      const img = document.createElement("img");
      img.src = wantImage;
      img.alt = spec.text || "logo";
      img.draggable = false;
      img.style.cssText =
        "width:100%;height:100%;object-fit:contain;display:block;pointer-events:none;";
      btn.appendChild(img);
    } else {
      btn.textContent = wantText;
    }
  }

  if (btn.dataset.wpsOn !== String(!!spec.on)) {
    btn.dataset.wpsOn = String(!!spec.on);
    btn.classList.toggle("wps-on", !!spec.on);
  }

  if (btn.title !== (spec.title || "")) btn.title = spec.title || "";

  if (btn.dataset.wpsBound !== spec.action) {
    btn.dataset.wpsBound = spec.action;
    btn.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      spec.handler(event);
    };
    // 阻止画布拖动 / 框选 / 右键菜单被顺带触发
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "dblclick", "contextmenu"]) {
      btn.addEventListener(type, (event) => event.stopPropagation());
    }
  }

  btn.style.display = "";
  return btn;
}

function hideOverlayButton(node, suffix) {
  const btn = overlay.buttons.get(overlayKey(node, suffix));
  if (btn) btn.style.display = "none";
}

/** 每个动画帧同步一次浮层位置，跟随平移/缩放 */
function scheduleOverlaySync(node) {
  overlay.node = node;
  if (overlay.raf) return;
  overlay.raf = requestAnimationFrame(() => {
    overlay.raf = 0;
    const target = overlay.node;
    if (target) syncOverlays(target);
  });
}

/**
 * 浮层同步：已经全部停用。
 *
 * 早先红点 / 清爽开关 / 署名徽章都是浮在画布上的 HTML 元素，
 * 在真实 ComfyUI 里会整层失效（看得见槽、点不到、甚至完全不显示）。
 * 现在这些元素一律改为画布绘制 + 行级命中，浮层退出关键路径。
 * 保留本函数只为兼容旧调用点，不再创建任何浮层控件。
 */
function syncOverlays(node) {
  if (!node) return;
  for (const [key, btn] of overlay.buttons) {
    if (key.startsWith(`${node.id ?? "?"}::`)) btn.style.display = "none";
  }
}
function buildMissingTitle(key, tokens) {
  if (!tokens.length) return "";
  const names = tokens.map((t) => nodeInfoOf(t).title || nodeInfoOf(t).type);
  const shown = names.slice(0, 4).join("、");
  const more = names.length > 4 ? ` 等 ${names.length} 个` : "";
  return `缺少 ${tokens.length} 个节点：${shown}${more}\n点一下查看详情 / 忽略这条记录`;
}

/**
 * 让节点尺寸贴合当前面板高度。
 *
 * 【高度】用 `Math.max` 而不是直接取 `computeSize()`：
 * `computeSize()` 算的是"控件自然高度之和"，**不含** ComfyUI 自己给控件加的
 * 4px 间距和分给弹性控件的空间；而 `_arrangeWidgets` 在内容超出 bodyHeight 时
 * 会按累加值 `setSize`。如果这里用了更小的值，就会形成
 * "我们缩小 → 前端下一帧又撑大"的来回抖动（实机上表现为面板/按钮忽大忽小、
 * 底下多出一块）。高度只增不减，收窄的活儿交给 `fitNodeToContent()`。
 *
 * 【宽度】**不动它**，只保一个下限。
 * v0.12.14 之前这里是 `Math.max(cur[0] ?? size[0], size[0])` —— 用的是
 * `computeSize()` 算出来的"自然宽度"，也就是**按钮标签不被截断所需的最小宽度**。
 * 它比用户手拖出来的宽度大得多，于是用户每拖窄一点，250ms 后这一句就把宽度
 * 顶回去，表现就是"节点拖不窄"（用户 m05646 第 1 条问的正是这件事）。
 *
 * 宽度本来就该由用户说了算：面板里的名字有省略号截断、按钮画不下就裁掉，
 * 都不会坏掉；反倒是"控件说了算"会让人以为节点卡住了。
 * 唯一的例外是下限 `NODE_MIN_WIDTH` —— 比它还窄的话连一行都放不下，
 * 那不是"用户想要的窄"，是拖过头了。
 */
/*
 * ============================ 界面事件日志 ============================
 *
 * 用户 m06099：「图1多出来了一块又回去了」「那个菜单又生出一大块来，就忽然间，
 * 我不确认是什么问题造成的弹出来了」「节点在执行过程中发生错误」。
 *
 * 这种"闪一下就没了"的界面变化，截图截不到、读代码读不出来 —— 靠猜只会
 * 越改越糟。所以这里全程留一份证据：凡是**我们这边动了界面**（开窗、建
 * DOM、改节点尺寸、重建面板行）就记一条，环形缓冲，最多 200 条。
 *
 * 它还能反过来证明清白：如果用户看到多出一块，而这段时间的日志里
 * 一条记录都没有，那就不是这个插件干的。
 *
 * 用法（F12 控制台）：`__wpsUILog()` 拿数组，`__wpsUILogDump()` 打印成表。
 * 开销可以忽略：一次 push 加一次字符串拼接，而且只在界面真的动时才跑。
 */
const UI_LOG_LIMIT = 200;
const uiLog = [];

function uiLogEvent(kind, detail = "") {
  try {
    const d = new Date();
    const pad = (n, w = 2) => String(n).padStart(w, "0");
    uiLog.push({
      t: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`,
      kind: String(kind),
      detail: String(detail),
    });
    if (uiLog.length > UI_LOG_LIMIT) uiLog.shift();
  } catch (_) {
    // 日志本身绝不能把界面搞崩
  }
}

/** 节点当前尺寸的短标签，用在日志里 */
function sizeTag(node) {
  const s = Array.isArray(node?.size) ? node.size : null;
  if (!s) return "?";
  const w = Number.isFinite(s[0]) ? Math.round(s[0]) : "?";
  const h = Number.isFinite(s[1]) ? Math.round(s[1]) : "?";
  return `${w}x${h}`;
}

/**
 * 面板行变化监视：行数/签名一变就记一条。
 *
 * "多出一大块又回去了"最可能就是行集合短暂地多出几行（子模式展开、
 * 缺失节点刚被检测到、预设被临时读成空……），节点跟着变高又变回去。
 * 这里把每一次变化都钉下来，带上前后行数和签名。
 */
function watchPanelRows(node, rows, signature) {
  try {
    const prev = node.__wpsRowWatch;
    const count = rows.length;
    if (!prev) {
      node.__wpsRowWatch = { count, signature };
      return;
    }
    if (prev.count !== count || prev.signature !== signature) {
      uiLogEvent(
        "rows",
        `#${numericNodeId(node)} ${prev.count} -> ${count} 行  ${sizeTag(node)}`
      );
      prev.count = count;
      prev.signature = signature;
    }
  } catch (_) {}
}

/** 节点尺寸监视，在每 250ms 那轮轮询里顺手跑，比包 setSize 稳 */
function watchNodeSize(node) {
  try {
    const now = sizeTag(node);
    const prev = node.__wpsSizeWatch;
    if (prev === undefined) {
      node.__wpsSizeWatch = now;
      return;
    }
    if (prev !== now) {
      uiLogEvent("size", `#${numericNodeId(node)} ${prev} -> ${now}`);
      node.__wpsSizeWatch = now;
    }
  } catch (_) {}
}

function relayoutNode(node) {
  if (!node || typeof node.computeSize !== "function") return;
  try {
    const cur = Array.isArray(node.size) ? node.size : [300, 100];
    const size = node.computeSize();
    if (!Array.isArray(size) || !(size[1] > 0)) return;

    const hasWidth = Number.isFinite(cur[0]) && cur[0] > 0;
    const width = hasWidth ? Math.max(cur[0], NODE_MIN_WIDTH) : Math.max(size[0], NODE_MIN_WIDTH);

    const next = [Math.round(width), Math.round(Math.max(cur[1] ?? size[1], size[1]))];
    const before = Array.isArray(node.size) ? [Math.round(node.size[0]), Math.round(node.size[1])] : null;
    if (!before || before[0] !== next[0] || before[1] !== next[1]) {
      uiLogEvent("grow", `#${numericNodeId(node)} ${before ? before.join("x") : "?"} -> ${next.join("x")}`);
    }
    node.setSize(next);
  } catch (error) {
    console.warn(`[${EXTENSION_NAME}] relayout failed`, error);
  }
  app.graph?.setDirtyCanvas(true, true);
}

/**
 * 把多余的空白收掉：节点高度应当等于"控件自然高度之和"。
 *
 * 为什么需要它：`relayoutNode()` 只许变大不许变小（那是为了不和前端的
 * `_arrangeWidgets` 打架），可一旦节点的 `size[1]` 被别的东西撑大了 ——
 * 用户手动拖拽、前端按 DOM 内容尺寸给的渲染尺寸、或者早期版本的遗留 ——
 * 那个高度就**再也回不去了**，节点底部就会一直挂一大块死空白。
 *
 * 这个函数只做一件事：算出控件真正需要的高度，比当前小就缩回去。
 * 它自己会和前端的重排收敛（同样输入 → 同样输出），不会来回抖。
 *
 * 什么时候不该动：正在被拖拽（`node.resizing`）、或者用户正把节点当"手写备注板"
 * 用（`node.flags.pinned`）时不动手。
 */
function fitNodeToContent(node) {
  if (!node || node.flags?.collapsed || node.__wpsPanelHidden) return;
  if (node.resizing || node.flags?.pinned) return;
  if (!Array.isArray(node.size) || !(node.size[1] > 0)) return;
  if (typeof node.computeSize !== "function") return;

  const curH = node.size[1];
  let nextH = 0;
  try {
    const size = node.computeSize();
    if (!Array.isArray(size) || !(size[1] > 0)) return;
    nextH = size[1];
  } catch (error) {
    return;
  }

  /*
   * `node.computeSize()` 是"控件净高度"，**不含每个控件那 4px 间距**，
   * 而前端的 `_arrangeWidgets` 是 `e.computeSize()[1] + 4` 逐个累加的。
   * 直接用 computeSize() 的值会缩得过头，下一帧前端又按累加值撑回来 ——
   * 那就成了来回抖。这里按前端的算法自己累一遍，才是真正"够用"的高度。
   */
  try {
    const widgets = (node.widgets || []).filter((w) => w && !w.hidden && w.type !== "hidden");
    if (widgets.length) {
      let acc = 2; // _arrangeWidgets 的起始偏移 `n`
      for (const w of widgets) {
        if (typeof w.computeSize === "function") {
          const s = w.computeSize();
          const hh = Array.isArray(s) ? s[1] : NaN;
          acc += Number.isFinite(hh) ? hh + 4 : 28;
        } else {
          acc += 28; // NODE_WIDGET_HEIGHT + 4
        }
      }
      const titleH = Number.isFinite(globalThis?.LiteGraph?.NODE_TITLE_HEIGHT)
        ? globalThis.LiteGraph.NODE_TITLE_HEIGHT
        : 30;
      const arranged = Math.max(nextH, acc + titleH);
      if (Number.isFinite(arranged) && arranged > 0) nextH = arranged;
    }
  } catch (error) {
    /* 累加失败就退回 computeSize() 的值，不因为兜底逻辑本身出错而不干活 */
  }

  // 多出来的空白还不够一行（26px）就别折腾了，免得每帧都在动
  if (curH - nextH < 26) return;

  try {
    const prev = node.__wpsLastFit;
    uiLogEvent("shrink", `#${numericNodeId(node)} 收掉底部空白 ${Math.round(curH)} -> ${Math.round(nextH)}`);
    node.setSize([node.size[0], nextH]);
    node.__wpsLastFit = { from: Math.round(curH), to: Math.round(nextH), at: Date.now() };
    if (!prev || Date.now() - prev.at > 2000) {
      console.log(
        `[${EXTENSION_NAME}] 节点底部有多余空白，已收掉：${Math.round(curH)} → ${Math.round(nextH)}`
      );
    }
    app.graph?.setDirtyCanvas(true, true);
  } catch (error) {
    console.warn(`[${EXTENSION_NAME}] fitNodeToContent failed`, error);
  }
}

/* ------------------------------------------------------------------ *
 *  全局配置（存 localStorage，所有工作流共用）
 *
 *  快捷键、缩放上下限这类偏好属于"人"而不属于"某个工作流"，
 *  所以放在 localStorage；预设数据仍然跟着工作流走。
 * ------------------------------------------------------------------ */

const CONFIG_KEY = "xwide_preset_switch_config";

const CONFIG_DEFAULTS = {
  hotkey: "alt+x",        // 空字符串 = 关闭快捷键
  hotkeyAction: "compact", // compact = 切清爽/完整模式（默认）；collapse = 收起整个面板
  /*
   * 第二个快捷键：把画面移到 Preset Switch 节点上。
   *
   * 和上面那个刻意分开，而不是塞进 hotkeyAction 里当第三个选项：
   * 这两个是**不同频率**的动作。切清爽模式是高频操作，跳转是"找不着它了"
   * 时候用的低频操作 —— 挤在同一个键上，用另一个就得先改设置。
   *
   * 默认 alt+z：alt+字母 是画布快捷键常见形式，而 alt+z 没被 ComfyUI
   * 占用（KEY_CONFLICTS 里 alt+c / alt+s / alt+a 都已占用）。
   * 空字符串 = 关闭。
   */
  jumpHotkey: "alt+z",
  scaleMin: 0.8,          // 浮层缩放下限（画布缩小到很小时）
  scaleMax: 1.4,          // 浮层缩放上限（画布放大到很大时，防止按钮挡住面板）
  brand: "X-WIDE",        // 作者署名
  brandUrl: "https://space.bilibili.com/374064919", // 作者主页
  repoUrl: "https://github.com/XWIDE/comfyui-preset-switch-plus", // 开源项目首页（用户 m06099 要求补上）
  brandImage: "./logo_xwide.png", // 设置窗口里展示的 logo
};

/**
 * 本版本自己的开源项目首页。
 *
 * 用户 m06099：「图二应该加上我的那个，开源的那个首页 https://github.com/XWIDE」。
 * 单独拎出来是为了让 `config.repoUrl` 被清空时卡片里也还能显示出来 ——
 * 署名链接丢掉比多显示一条糟得多。
 */
const PROJECT_REPO_URL = "https://github.com/XWIDE/comfyui-preset-switch-plus";

/** 原作者信息（GPL-3.0 要求署名，且本版本是在其基础上升级） */
const ORIGINAL_AUTHOR = {
  name: "CarlMarkswx",
  project: "comfyui_workflow_preset_switch",
  url: "https://github.com/CarlMarkswx/comfyui_workflow_preset_switch",
};

/**
 * 把插件目录内的相对路径转成可直接给 <img> 用的地址。
 * 插件的前端文件是通过 /extensions/<插件目录名>/… 暴露的。
 */
function pluginAssetUrl(relPath) {
  const p = String(relPath || "").trim();
  if (!p) return "";
  if (/^(https?:|data:|blob:)/i.test(p)) return p;
  const clean = p.replace(/^\.?\//, "");
  return `/extensions/comfyui-preset-switch-plus/${clean}`;
}

/** 署名文案；留空则显示作者主页图标 */
function brandName() {
  const name = String(config.brand ?? "").trim();
  return name || "作者主页";
}

/**
 * 打开外部链接。只放行 http/https —— 防止把配置改成 javascript: 之类的伪协议。
 * 浏览器会把它开在新标签页；DSH / Electron 这类外壳则由系统浏览器接管。
 */
function openExternalLink(url) {
  const target = String(url || "").trim();
  if (!target) {
    console.warn(`[${EXTENSION_NAME}] 未设置跳转地址，可在设置里填写`);
    return false;
  }
  if (!/^https?:\/\//i.test(target)) {
    console.warn(`[${EXTENSION_NAME}] 只允许 http/https 链接，已拒绝：${target}`);
    return false;
  }
  try {
    const win = globalThis.open(target, "_blank", "noopener,noreferrer");
    if (win) win.opener = null;
    console.log(`[${EXTENSION_NAME}] 已打开：${target}`);
    return true;
  } catch (error) {
    console.warn(`[${EXTENSION_NAME}] 打开链接失败：${target}`, error);
    return false;
  }
}

const config = { ...CONFIG_DEFAULTS };

function loadConfig() {
  try {
    const raw = globalThis.localStorage?.getItem(CONFIG_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved && typeof saved === "object") {
      for (const key of Object.keys(CONFIG_DEFAULTS)) {
        if (saved[key] === undefined || saved[key] === null) continue;
        config[key] = saved[key];
      }
    }
  } catch (error) {
    console.warn(`[${EXTENSION_NAME}] config load failed`, error);
  }

  // 兜底校验，避免手改 localStorage 后出现奇怪数值
  if (typeof config.hotkey !== "string") config.hotkey = CONFIG_DEFAULTS.hotkey;
  if (!["compact", "collapse"].includes(config.hotkeyAction)) config.hotkeyAction = "compact";
  if (typeof config.jumpHotkey !== "string") config.jumpHotkey = CONFIG_DEFAULTS.jumpHotkey;
  /*
   * 两个快捷键撞在一起时，把跳转那个让出来。
   *
   * 撞了的话 keydown 里先跑的那个会 preventDefault，第二个永远收不到，
   * 用户看到的是"设了跳转键但按了没反应"，很难自己想到是撞键。
   * 主快捷键是用户明确选过动作的，优先级更高，所以让跳转键退回默认。
   */
  if (
    config.jumpHotkey &&
    config.hotkey &&
    config.jumpHotkey === config.hotkey
  ) {
    console.warn(
      `[${EXTENSION_NAME}] 跳转快捷键与主快捷键撞了（${config.hotkey}），跳转键已退回默认 ${CONFIG_DEFAULTS.jumpHotkey}`
    );
    config.jumpHotkey =
      CONFIG_DEFAULTS.jumpHotkey === config.hotkey ? "" : CONFIG_DEFAULTS.jumpHotkey;
  }
  // 空字符串也视为"未设置"并回退默认值，否则清空过一次署名/网址后，
  // 默认的作者主页链接就永久失效了
  if (!String(config.brand || "").trim()) config.brand = CONFIG_DEFAULTS.brand;
  if (!String(config.brandUrl || "").trim()) config.brandUrl = CONFIG_DEFAULTS.brandUrl;
  if (!String(config.repoUrl || "").trim()) config.repoUrl = CONFIG_DEFAULTS.repoUrl;
  if (!String(config.brandImage || "").trim()) config.brandImage = CONFIG_DEFAULTS.brandImage;
  config.scaleMin = clampNumber(config.scaleMin, 0.2, 3, CONFIG_DEFAULTS.scaleMin);
  config.scaleMax = clampNumber(config.scaleMax, 0.2, 3, CONFIG_DEFAULTS.scaleMax);
  if (config.scaleMax < config.scaleMin) {
    const swap = config.scaleMin;
    config.scaleMin = config.scaleMax;
    config.scaleMax = swap;
  }
}

function saveConfig() {
  try {
    globalThis.localStorage?.setItem(CONFIG_KEY, JSON.stringify(config));
  } catch (error) {
    console.warn(`[${EXTENSION_NAME}] config save failed`, error);
  }
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/* ------------------------------------------------------------------ *
 *  基础工具
 * ------------------------------------------------------------------ */

function getGraph() {
  return app?.graph ?? null;
}

function asFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeIndex(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

function isChildKey(key) {
  return String(key).includes(".");
}

function rootKeyOf(key) {
  return String(key).split(".")[0];
}

function childSuffixOf(key) {
  const parts = String(key).split(".");
  return parts.length > 1 ? normalizeIndex(parts[1]) : null;
}

function makeChildKey(rootKey, suffix) {
  return `${rootKeyOf(rootKey)}.${normalizeIndex(suffix)}`;
}

/** 稳定排序：0, 1, 2, 0.1, 0.2 … 先按根序号，再按父级归拢子项 */
function compareKeys(a, b) {
  const ra = normalizeIndex(rootKeyOf(a));
  const rb = normalizeIndex(rootKeyOf(b));
  if (ra !== rb) return ra - rb;
  const sa = childSuffixOf(a);
  const sb = childSuffixOf(b);
  if (sa === null && sb === null) return 0;
  if (sa === null) return -1; // 父项排在自己的子项之前
  if (sb === null) return 1;
  return sa - sb;
}

function sortKeys(keys) {
  return keys.slice().sort(compareKeys);
}

/* ------------------------------------------------------------------ *
 *  数据存储
 * ------------------------------------------------------------------ */

function newPresetRecord(key) {
  return {
    name: defaultPresetName(key),
    nodes: {},
    node_ids: [],
    updated_at: null,
  };
}

function ensureStore() {
  const graph = getGraph();
  if (!graph) return null;

  graph.extra = graph.extra || {};

  /*
   * 这里必须**原地**返回同一个 store 对象，绝不能再造一个新的。
   *
   * 老写法是每调一次就 `graph.extra[STORE_KEY] = { ...一整套新对象... }`。
   * 可 ensureStore() 在 250ms 那一轮里要被调好几次（面板模型、缺失核对、
   * 状态检测各一次），于是每 0.25 秒就凭空造出一整套新对象、还把 graph.extra
   * 里的引用换掉。后果有两个：
   *   1. 白白制造垃圾，白白触发一轮重画；
   *   2. ComfyUI 靠"序列化结果变没变"判断工作流是否被修改 —— 引用被反复换掉
   *      会让自动保存反复触发。而工作流草稿是写进浏览器 localStorage 的
   *      （配额约 5MB），一超就弹一片"保存工作流草稿失败"。
   *      实机报告里右边那一摞红框就是被这种反复触发喂出来的。
   */
  const store =
    graph.extra[STORE_KEY] && typeof graph.extra[STORE_KEY] === "object"
      ? graph.extra[STORE_KEY]
      : {};
  graph.extra[STORE_KEY] = store;

  store.version = STORE_VERSION;
  if (!store.presets || typeof store.presets !== "object") store.presets = {};
  if (!store.child_ack || typeof store.child_ack !== "object") store.child_ack = {};
  if (!store.pool || typeof store.pool !== "object") store.pool = {};
  if (!store.excluded || typeof store.excluded !== "object") store.excluded = {};

  if (!store.options || typeof store.options !== "object") store.options = {};
  const optionDefaults = {
    onMissingNode: "skip",
    indexOutOfRange: "warn",
    onUntrackedNode: "bypass",
    hideCrudButtons: false,
  };
  for (const [name, value] of Object.entries(optionDefaults)) {
    if (typeof store.options[name] === "undefined") store.options[name] = value;
  }

  /*
   * 一次性迁移。做完在 store 上钉一个**不可枚举**的记号 —— 不可枚举才不会
   * 跟着工作流一起被序列化 —— 之后每次 ensureStore() 都是 O(1) 直接返回，
   * 绝不会每帧去遍历几 MB 的控件值。
   */
  if (store.__wpsReady !== true) {
    // 老版本记录（Phase 1/2）没有 node_ids，补上，红点检测才能工作
    for (const record of Object.values(store.presets)) {
      if (!record || typeof record !== "object") continue;
      if (!Array.isArray(record.node_ids)) {
        record.node_ids = record.nodes && typeof record.nodes === "object"
          ? Object.keys(record.nodes)
          : [];
      }
    }

    // 老格式是每份预设各存一份控件值明文，先就地池化一遍，
    // 这样用户下次保存工作流时体积立刻减半（实测省 1113KB）
    for (const record of Object.values(store.presets)) {
      poolPresetWidgets(store, record);
    }

    Object.defineProperty(store, "__wpsReady", {
      value: true,
      enumerable: false,
      writable: true,
      configurable: true,
    });
  }

  return store;
}

function listRootKeys() {
  const store = ensureStore();
  if (!store) return [];
  return sortKeys(
    Object.keys(store.presets || {}).filter((k) => !isChildKey(k) && store.presets[k])
  );
}

function listChildKeys(rootKey) {
  const store = ensureStore();
  if (!store) return [];
  const root = rootKeyOf(rootKey);
  return sortKeys(
    Object.keys(store.presets || {}).filter(
      (k) => isChildKey(k) && rootKeyOf(k) === root && store.presets[k]
    )
  );
}

/** 扁平化遍历顺序：[根, 根的子项…, 下一个根, …] */
function listAllKeys() {
  const result = [];
  for (const rootKey of listRootKeys()) {
    result.push(rootKey);
    result.push(...listChildKeys(rootKey));
  }
  return result;
}

function defaultPresetName(key) {
  const suffix = childSuffixOf(key);
  if (suffix === null) return `Preset ${normalizeIndex(key)} 预设`;
  return `Preset ${rootKeyOf(key)}-${suffix} 预设`;
}

function isDefaultPresetName(name, key) {
  return String(name ?? "") === defaultPresetName(key);
}

function getPresetName(key) {
  const store = ensureStore();
  if (!store) return defaultPresetName(key);
  return store.presets?.[String(key)]?.name || defaultPresetName(key);
}

function setPresetName(key, name) {
  const store = ensureStore();
  if (!store) return false;

  const preset = store.presets?.[String(key)];
  if (!preset) return false;

  const normalized = String(name ?? "").trim() || defaultPresetName(key);
  if (preset.name === normalized) return true;

  preset.name = normalized;
  preset.updated_at = Date.now();
  app.graph?.setDirtyCanvas(true, true);
  return true;
}

function nextRootKey() {
  const roots = listRootKeys().map((k) => normalizeIndex(k));
  if (!roots.length) return "0";
  return String(Math.max(...roots) + 1);
}

function nextChildKey(parentKey) {
  const existing = listChildKeys(parentKey)
    .map((k) => childSuffixOf(k))
    .filter((v) => v !== null);
  const next = existing.length ? Math.max(...existing) + 1 : 1;
  return makeChildKey(parentKey, next);
}

/* ------------------------------------------------------------------ *
 *  widget 快照 / 还原
 * ------------------------------------------------------------------ */

function readNumericWidgetValue(node, names = []) {
  if (!node?.widgets?.length) return null;

  for (const name of names) {
    const widget = node.widgets.find((w) => w?.name === name);
    if (!widget) continue;
    const n = asFiniteNumber(widget.value);
    if (n !== null) return n;
  }

  for (const widget of node.widgets) {
    const n = asFiniteNumber(widget?.value);
    if (n !== null) return n;
  }

  return null;
}

function resolvePresetIndexFromLink(node) {
  const graph = getGraph();
  if (!graph) return null;

  const presetInput = node?.inputs?.find((i) => i?.name === "preset_index");
  if (!presetInput || presetInput.link == null) return null;

  const visitedLinks = new Set();
  const visitedNodes = new Set();

  function resolveFromLink(linkId) {
    if (linkId == null || visitedLinks.has(linkId)) return null;
    visitedLinks.add(linkId);

    const link = graph.links?.[linkId];
    if (!link) return null;

    const sourceNode = graph.getNodeById?.(link.origin_id);
    if (!sourceNode || visitedNodes.has(sourceNode.id)) return null;
    visitedNodes.add(sourceNode.id);

    // 穿透 Reroute，继续向上游查找
    if (sourceNode.type === "Reroute") {
      const inputLink = sourceNode.inputs?.[0]?.link;
      return resolveFromLink(inputLink);
    }

    const fromNamedWidget = readNumericWidgetValue(sourceNode, [
      "preset_index",
      "value",
      "index",
    ]);
    if (fromNamedWidget !== null) return fromNamedWidget;

    if (Array.isArray(sourceNode.widgets_values)) {
      for (const value of sourceNode.widgets_values) {
        const n = asFiniteNumber(value);
        if (n !== null) return n;
      }
    }

    return null;
  }

  return resolveFromLink(presetInput.link);
}

function getPresetIndexFromNode(node) {
  const linkedValue = resolvePresetIndexFromLink(node);
  if (linkedValue !== null) return normalizeIndex(linkedValue);

  const widget = node?.widgets?.find((w) => w?.name === "preset_index");
  if (!widget) return 0;
  return normalizeIndex(widget.value);
}

function isPresetInputLinked(node) {
  const presetInput = node?.inputs?.find((i) => i?.name === "preset_index");
  return !!presetInput && presetInput.link != null;
}

function getAllNodes() {
  const graph = getGraph();
  return graph?._nodes || [];
}

/* ------------------------------------------------------------------ *
 *  控件按钮定义
 *
 *  用节点自带的按钮控件（不是 HTML 浮层）。理由见 injectNodeButtons。
 *  图标前缀表达分组，悬停说明写清楚用途。
 * ------------------------------------------------------------------ */

const WIDGET_BUTTONS = [
  {
    id: "addPreset",
    group: "create",
    color: "#2b3b52",
    textColor: "#cfe0f5",
    name: "＋ 新增预设 / Add Preset",
    title: "新增一个顶层预设（Add Preset）",
    run: (node) => {
      // 新建的预设故意"不记录"，保持未记录状态（暗红），
      // 由用户确认当前画布摆好后自己点「记录当前」。
      const key = nextRootKey();
      const store = ensureStore();
      if (!store) return;
      if (!store.presets[key]) {
        store.presets[key] = {
          name: defaultPresetName(key),
          nodes: {},
          node_ids: [],
          updated_at: null,
        };
      }
      switchPreset(node, key);
      app.graph?.setDirtyCanvas(true, true);
    },
  },
  {
    id: "addSub",
    group: "create",
    color: "#2b3b52",
    textColor: "#cfe0f5",
    name: "＋ 新增子模式 / Add Sub-mode",
    title: "在当前模式下面新增一个子模式，并记录当前状态（Add Sub-mode）",
    run: (node) => {
      const parentKey = activeParentKey(node);
      if (!parentKey) {
        console.warn(`[${EXTENSION_NAME}] 请先新增一个顶层预设，再添加子模式`);
        return;
      }
      const key = nextChildKey(parentKey);
      if (!recordPreset(key)) return;
      node.__wpsExpanded = node.__wpsExpanded || {};
      node.__wpsExpanded[parentKey] = true;
      switchPreset(node, key);
    },
  },
  {
    id: "record",
    group: "edit",
    name: "● 记录当前 / Record",
    title: "把当前画布状态覆盖存进当前生效的预设（Record Current）",
    run: (node) => {
      recordPreset(currentKeyOfNode(node));
      refreshPresetWidgets(node);
    },
  },
  {
    id: "delete",
    group: "edit",
    color: "#4a2a2a",
    textColor: "#f5d5d2",
    name: "🗑 删除 / Delete",
    title: "删除当前预设（删除父模式会连同它的子模式一起删）",
    run: (node) => {
      const active = currentKeyOfNode(node);
      const ok = deletePreset(active);
      if (!ok) {
        refreshPresetWidgets(node);
        return;
      }
      const all = listAllKeys();
      if (all.length) {
        switchPreset(node, all.includes(active) ? active : all[0]);
      } else {
        refreshPresetWidgets(node);
      }
    },
  },
  {
    id: "prev",
    group: "nav",
    color: "#2f3339",
    textColor: "#d5dae0",
    name: "◀ 上一个 / Prev",
    title: "上一个预设 / 子模式（Prev Preset）",
    run: (node) => {
      switchPreset(node, stepPresetKey(currentKeyOfNode(node), -1));
    },
  },
  {
    id: "next",
    group: "nav",
    color: "#2f3339",
    textColor: "#d5dae0",
    name: "▶ 下一个 / Next",
    title: "下一个预设 / 子模式（Next Preset）",
    run: (node) => {
      switchPreset(node, stepPresetKey(currentKeyOfNode(node), 1));
    },
  },
  {
    id: "settings",
    group: "misc",
    color: "#25282d",
    textColor: "#b9bfc6",
    name: "⚙ 设置 / Settings",
    title: "快捷键、署名、浮层缩放范围（X-WIDE Preset Switch 设置）",
    run: (node) => showSettingsDialog(node),
  },
];

/** 面板内框宽度：工具栏换行、面板高度都以它为准 */
function panelContentWidth(node) {
  const w = node?.size?.[0] ?? NODE_WIDTH;
  return Math.max(180, w - 20);
}
function isWidgetSnapshotSkipped(widget) {
  if (!widget || typeof widget.name !== "string") return true;
  if (widget.name === "preset_index") return true;
  // 自建面板是纯 UI，不参与快照
  if (widget.__wpsPresetPanel) return true;
  if (widget.__wpsDynamicPresetItem) return true;
  if (typeof widget.value === "function") return true;
  return false;
}

function snapshotWidgetValue(value) {
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return value;
  if (value === null) return null;
  if (Array.isArray(value)) return value.slice();
  if (t === "object") {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (error) {
      return undefined;
    }
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 *  排除记录：哪些节点不参与预设的记录与套用
 *
 *  用户 m06692 的原话：
 *    「因为现在所有的节点都会改，我刚才试了一下，包括模型都会换，应该加一个
 *      排除功能。就是比如说，我选择这几个节点不参与记录」
 *  以及他给出的真实痛点：
 *    「我的编辑模型里面载入了 6 张图，然后我切过去到文生图的时候，他之前可能
 *      只是载入了一张图，这会顶掉我之前在编辑模型下的载入的多张图」
 *
 *  这个痛点其实有**两半机制**，只堵一半不够：
 *    1. 套用预设时会把记录里的控件值写回去 —— 包括 LoadImage 的图片、
 *       模型加载器的模型名。切到"只有 1 张图"的那份预设，6 张图就被顶掉了。
 *    2. 更隐蔽的一半：`onUntrackedNode` 的默认策略是 bypass，也就是
 *       「这份预设没记录过的节点一律旁路掉」。那几个 LoadImage 如果没被
 *       文生图那份预设记录过，切过去时它们会被**整个跳过** ——
 *       图不是被覆盖，是节点当场失效。
 *  所以排除名单必须同时挡住这两条路（见 applyStateToNode 与
 *  applyUntrackedNodePolicy 里的判断），否则用户排除了节点、图还是会丢。
 *
 *  作用范围：整个工作流共用一份名单，**对所有预设生效**（用户原话
 *  「这个是做全局的」）。名单存进工作流自己的 store 里 —— 节点 id 只在
 *  本工作流内有意义，存进浏览器全局设置的话，换个工作流就会误伤同号的节点。
 * ------------------------------------------------------------------ */

/** store.excluded 的引用；顺带保证它存在 */
function excludedMap() {
  const store = ensureStore();
  if (!store) return {};
  if (!store.excluded || typeof store.excluded !== "object") store.excluded = {};
  return store.excluded;
}

/** 节点在本工作流里的稳定标识；拿不到 id 的节点没法被排除 */
function exclusionKeyOf(node) {
  const id = numericNodeId(node);
  return id === null ? null : String(id);
}

/** 这个节点是不是被"排除记录"了 */
function isNodeExcluded(node) {
  const key = exclusionKeyOf(node);
  if (key === null) return false;
  return Object.prototype.hasOwnProperty.call(excludedMap(), key);
}

/** 名单里的 id 集合。批量遍历时比逐个查对象省事 */
function excludedIdSet() {
  const ids = new Set();
  for (const key of Object.keys(excludedMap())) ids.add(String(key));
  return ids;
}

/**
 * 把一个节点加进 / 移出排除名单。
 * 返回 true 表示名单真的变了（调用方据此决定要不要重画）。
 */
function setNodeExcluded(node, excluded) {
  const key = exclusionKeyOf(node);
  if (key === null) return false;

  const map = excludedMap();
  if (excluded) {
    const title = String(node?.title || node?.type || "");
    const type = String(node?.type || "");
    const before = map[key];
    if (before && before.title === title && before.type === type) return false;
    map[key] = { title, type, at: Date.now() };
    return true;
  }

  if (!Object.prototype.hasOwnProperty.call(map, key)) return false;
  delete map[key];
  return true;
}

/** 清空整份名单，返回清掉了几个 */
function clearExclusions() {
  const map = excludedMap();
  const keys = Object.keys(map);
  for (const key of keys) delete map[key];
  return keys.length;
}

/** 名单里仍然存在的节点，按 id 排序，供界面显示 */
function excludedNodeList() {
  const map = excludedMap();
  const list = [];
  for (const [key, info] of Object.entries(map)) {
    const id = Number(key);
    if (!Number.isFinite(id)) continue;
    const node = app.graph?.getNodeById?.(id) || null;
    list.push({
      id: key,
      title: String(node?.title || info?.title || info?.type || `#${key}`),
      type: String(node?.type || info?.type || ""),
      alive: Boolean(node),
    });
  }
  list.sort((a, b) => Number(a.id) - Number(b.id));
  return list;
}

/** 名单变了之后，把面板状态与画布刷一遍 */
function refreshAfterExclusionChange() {
  for (const target of getAllNodes()) {
    if (target?.type !== TARGET_NODE_NAME) continue;
    refreshPresetWidgets(target);
  }
  app.graph?.setDirtyCanvas(true, true);
}

/**
 * 右键菜单要对哪些节点下手。
 *
 * 用户说的是「你可以选择几个节点，然后菜单点一下」——所以如果右键点中的节点
 * 正好在多选里，就整批处理；否则只处理点中的那一个。
 *
 * Preset Switch 自己不出现在菜单里：它本来就不参与这套记录
 * （快照里一律记成启用、也不走未记录策略），把它排除掉只会让人困惑。
 */
function exclusionMenuTargets(canvas, clickedNode) {
  const list = [];
  const seen = new Set();
  const push = (node) => {
    if (!node || node.type === TARGET_NODE_NAME) return;
    const key = exclusionKeyOf(node);
    if (key === null || seen.has(key)) return;
    seen.add(key);
    list.push(node);
  };

  const selected = canvas?.selected_nodes;
  const clickedId = clickedNode?.id;
  const clickedIsSelected =
    clickedNode && selected && Object.prototype.hasOwnProperty.call(selected, clickedId);
  if (clickedIsSelected) {
    for (const node of Object.values(selected)) push(node);
  }
  push(clickedNode);
  return list;
}

/**
 * 给**任意节点**的右键菜单加上「排除记录 / 恢复记录」。
 *
 * 为什么要包 LGraphCanvas 而不是包节点类型：插件只 registerExtension 了
 * Preset Switch 自己那一种节点，而用户要排除的是 LoadImage、模型加载器……
 * 这些节点类型五花八门，一个一个包既不现实、也迟早漏。画布这一层是唯一
 * 的必经之路。
 *
 * 已核对过 ComfyUI 前端（comfyui_frontend_package 的 settingStore 里）：
 *   - 空画布右键走 this.getCanvasMenuOptions()
 *   - 节点右键走   this.getNodeMenuOptions(node)
 * 两者都必须**返回数组**（ComfyUI 自己也是这么包的），所以这里一律
 * `return result`，只在原数组上追加，绝不替换。
 */
function installExclusionContextMenu() {
  const proto = app?.canvas?.constructor?.prototype;
  if (!proto) return false;
  if (proto.__wpsExcludeMenuPatched === true) return true;

  const originalNodeMenu = proto.getNodeMenuOptions;
  if (typeof originalNodeMenu !== "function") return false;

  proto.getNodeMenuOptions = function getNodeMenuOptionsWithExclusion(node) {
    const result = originalNodeMenu.apply(this, arguments);
    try {
      if (Array.isArray(result)) {
        const targets = exclusionMenuTargets(this, node);
        if (targets.length) {
          const excludedCount = targets.filter((n) => isNodeExcluded(n)).length;
          const allExcluded = excludedCount === targets.length;
          const suffix = targets.length > 1 ? `（${targets.length} 个节点）` : "";

          result.push(null);
          result.push({
            content: allExcluded
              ? `✅ 恢复记录 / Include${suffix}`
              : `🚫 排除记录 / Exclude from recording${suffix}`,
            callback: () => {
              const want = !allExcluded;
              let changed = 0;
              for (const target of targets) {
                if (setNodeExcluded(target, want)) changed += 1;
              }
              if (changed) refreshAfterExclusionChange();
              console.log(
                `[${EXTENSION_NAME}] ${want ? "排除" : "恢复"}了 ${changed} 个节点的记录` +
                  `（右键菜单，共选中 ${targets.length} 个）`
              );
            },
          });
          result.push({
            content: "📋 查看排除清单 / Excluded nodes…",
            callback: () => showExclusionDialog(),
          });
        }
      }
    } catch (error) {
      // 菜单挂不上不能让右键整个坏掉
      console.warn(`[${EXTENSION_NAME}] 排除菜单挂载失败`, error);
    }
    return result;
  };

  const originalCanvasMenu = proto.getCanvasMenuOptions;
  if (typeof originalCanvasMenu === "function") {
    proto.getCanvasMenuOptions = function getCanvasMenuOptionsWithExclusion() {
      const result = originalCanvasMenu.apply(this, arguments);
      try {
        if (Array.isArray(result)) {
          const count = excludedNodeList().filter((e) => e.alive).length;
          result.push(null);
          result.push({
            content: count
              ? `📋 排除记录清单（已排除 ${count} 个）/ Excluded nodes…`
              : "📋 排除记录清单 / Excluded nodes…",
            callback: () => showExclusionDialog(),
          });
        }
      } catch (error) {
        console.warn(`[${EXTENSION_NAME}] 排除菜单挂载失败`, error);
      }
      return result;
    };
  }

  proto.__wpsExcludeMenuPatched = true;
  console.log(`[${EXTENSION_NAME}] 节点右键菜单已挂上「排除记录」`);
  return true;
}

function captureNodeWidgetValues(node) {
  const widgets = {};
  if (!Array.isArray(node?.widgets)) return widgets;
  for (const widget of node.widgets) {
    if (isWidgetSnapshotSkipped(widget)) continue;
    const value = snapshotWidgetValue(widget.value);
    if (typeof value === "undefined") continue;
    widgets[widget.name] = value;
  }
  return widgets;
}

function captureNodeState(node) {
  /*
   * 快照里的 Preset Switch 节点**一律记成"启用"**。
   *
   * 理由和 applyUntrackedNodePolicy() 里那段一样：控制器不能被自己关掉。
   * 用户有可能先手动旁路了开关、再去点「记录当前」，那样这份预设就永久记住了
   * "把开关也旁路掉"——下次应用这份预设，控制器当场自锁，谁也切不回来。
   * 记录这一刻就把它归一成启用，从源头堵死。
   */
  const isSwitch = node?.type === TARGET_NODE_NAME;

  return {
    id: typeof node?.id !== "undefined" ? String(node.id) : null,
    type: node?.type || "",
    title: node?.title || node?.type || "",
    mode: isSwitch ? MODE_ENABLE : typeof node?.mode === "number" ? node.mode : null,
    bypass: isSwitch ? false : typeof node?.bypass === "boolean" ? node.bypass : null,
    widgets: captureNodeWidgetValues(node),
  };
}

function snapshotPresetGraph() {
  const nodes = {};
  const nodeIds = [];

  for (const node of getAllNodes()) {
    if (!node || typeof node.id === "undefined") continue;
    // 被"排除记录"的节点根本不进快照 —— 这就是"不参与记录"的字面意思
    if (isNodeExcluded(node)) continue;
    const state = captureNodeState(node);
    nodes[String(node.id)] = state;
    nodeIds.push(String(node.id));
  }

  return { nodes, nodeIds };
}

/* ------------------------------------------------------------------ *
 *  控件值池化：同一段控件值在多份预设里只存一份
 *
 *  为什么非做不可（实机实测，用户那份 Qwen 大工作流）：
 *    - 整个工作流存盘 4398KB，其中我们的预设数据 2195KB（占 49.9%）；
 *    - 元凶是单个节点的巨型字符串：节点 #726 的 `scene_json` 一个控件就 843KB，
 *      被 #0 / #1.1 两份预设各存一份 = 1686KB；
 *    - 四份预设的控件值内联合计 2156KB，按内容池化后只要 1043KB，**省 1113KB**。
 *  而工作流草稿是存进 localStorage 的（配额约 5MB），省下来的这 1MB
 *  正好是"保存工作流草稿失败"弹不弹的分界线。
 *
 *  形态：store.pool = { "<指纹>": "<JSON 文本>" }，节点条目上留 state.__w = 指纹。
 *  内存里 state.widgets 仍然是真对象，只是改成**不可枚举** —— 这样
 *  JSON.stringify 自然只写 __w、不会把明文又写一遍，所有既有读取方也都不用改。
 * ------------------------------------------------------------------ */

/** FNV-1a 32 位 + 长度后缀。撞车了 poolPresetWidgets 里还会顺延，不会覆盖。 */
function hashWidgetJson(json) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < json.length; i += 1) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(36)}_${json.length.toString(36)}`;
}

/** 把一份预设记录的控件值搬进 store.pool，节点条目上只留 __w 指纹。 */
function poolPresetWidgets(store, record) {
  if (!store || !record || typeof record !== "object") return 0;
  if (!record.nodes || typeof record.nodes !== "object") return 0;
  if (!store.pool || typeof store.pool !== "object") store.pool = {};

  let pooled = 0;
  for (const state of Object.values(record.nodes)) {
    if (!state || typeof state !== "object") continue;
    const widgets = state.widgets;
    if (!widgets || typeof widgets !== "object") continue;

    let json = null;
    try {
      json = JSON.stringify(widgets);
    } catch (error) {
      continue;
    }
    if (typeof json !== "string") continue;

    const base = hashWidgetJson(json);
    let key = base;
    let suffix = 0;
    // 同一个指纹下如果已经躺着一段**不一样**的 JSON，就往后顺延。
    // 绝不能覆盖 —— 覆盖等于悄悄把别的预设的控件值改掉。
    while (typeof store.pool[key] === "string" && store.pool[key] !== json) {
      suffix += 1;
      key = `${base}_${suffix}`;
    }

    try {
      Object.defineProperty(state, "widgets", {
        value: widgets,
        enumerable: false,
        writable: true,
        configurable: true,
      });
    } catch (error) {
      // 定义不了就保持明文。功能完全不受影响，只是这份省不下体积，
      // 所以也**不写 __w** —— 否则会变成"明文 + 池"双份，反而更肥。
      continue;
    }

    store.pool[key] = json;
    state.__w = key;
    pooled += 1;
  }
  return pooled;
}

/** 删预设之后把没人再引用的池条目清掉，否则删了预设体积也不降。 */
function pruneWidgetPool(store) {
  if (!store || !store.pool || typeof store.pool !== "object") return 0;

  const live = new Set();
  for (const record of Object.values(store.presets || {})) {
    if (!record || typeof record.nodes !== "object" || !record.nodes) continue;
    for (const state of Object.values(record.nodes)) {
      if (state && typeof state.__w === "string") live.add(state.__w);
    }
  }

  let removed = 0;
  for (const key of Object.keys(store.pool)) {
    if (!live.has(key)) {
      delete store.pool[key];
      removed += 1;
    }
  }
  return removed;
}

/**
 * 取一条节点状态里存的控件值。
 *
 * 池化之后节点条目上可能只有一个 __w 指纹，值躺在 store.pool 里 —— 所有
 * 读取方都必须走这里，不要直接摸 state.widgets。首次解析会回填到内存并
 * 钉成不可枚举，所以同一份数据只会 JSON.parse 一次。
 */
function stateWidgets(state) {
  if (!state || typeof state !== "object") return null;

  const direct = state.widgets;
  if (direct && typeof direct === "object") return direct;

  const key = typeof state.__w === "string" ? state.__w : null;
  if (!key) return null;

  const json = ensureStore()?.pool?.[key];
  if (typeof json !== "string") {
    console.warn(
      `[${EXTENSION_NAME}] 控件值池里找不到 ${key}（节点 #${state.id}），这份预设的控件值读不回来`
    );
    return null;
  }

  let parsed = null;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    console.warn(`[${EXTENSION_NAME}] 控件值池条目 ${key} 不是合法 JSON`, error);
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  try {
    Object.defineProperty(state, "widgets", {
      value: parsed,
      enumerable: false,
      writable: true,
      configurable: true,
    });
  } catch (error) {
    // 对象被冻结之类：解析一次照样能用，只是下次还得再解析一遍
  }
  return parsed;
}

/* ------------------------------------------------------------------ *
 *  记录状态检测：未记录 / 待记录 / 已记录
 * ------------------------------------------------------------------ */

const STATE_UNRECORDED = "unrecorded";
const STATE_DIRTY = "dirty";
const STATE_SYNCED = "synced";
const STATE_MISSING = "missing";

/** 状态配色：暗红 / 黄 / 绿 */
/** 「记录当前」按钮的三态文案与配色 */
const RECORD_BUTTON_STATES = {
  [STATE_UNRECORDED]: { name: "● 记录当前 / Record", color: "#6e2626", textColor: "#ffd7d7" },
  [STATE_DIRTY]: { name: "● 记录改动 / Record Changes", color: "#8a6a1f", textColor: "#fff0c2" },
  [STATE_SYNCED]: { name: "● 覆盖 / Overwrite", color: "#2f6b3f", textColor: "#d8f5e0" },
  [STATE_MISSING]: { name: "● 覆盖 / Overwrite", color: "#8a6a1f", textColor: "#fff0c2" },
};

/*
 * 「需要你动手」的两个状态，让按钮**亮起来**。
 *
 * 用户的反馈（m04872）：「这里在变成记录改动的时候，字体能不能变颜色，
 * 或者说是亮度，边框之类的提醒人点」。光是背景色由绿变黄太含蓄了 ——
 * 按钮排成一列，扫一眼根本注意不到。
 *
 * 做法是让底色在两个色调之间呼吸：亮度周期变化比静态的高饱和色更容易
 * 被余光抓到。相位跟着时钟走而不是跟着刷新次数走，所以刷新快慢都不会
 * 改变节奏，也不会因为节点重新渲染而重置。
 *
 * 配色只动底色，不动文字：绿/黄底配浅色文字是我们已经调过的对比度，
 * 一改文字颜色就得重新验证一遍可读性。
 */
const RECORD_GLOW = {
  [STATE_DIRTY]: { from: "#8a6a1f", to: "#e8b53c", period: 1600 },
  [STATE_MISSING]: { from: "#8a6a1f", to: "#e8b53c", period: 1600 },
};

function hexToRgb(hex) {
  const s = String(hex || "").trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

function rgbToHex(rgb) {
  return (
    "#" +
    rgb
      .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0"))
      .join("")
  );
}

/** 把两个颜色按 t（0~1）混合 */
function mixHex(from, to, t) {
  const a = hexToRgb(from);
  const b = hexToRgb(to);
  if (!a || !b) return from;
  const k = Math.max(0, Math.min(1, Number(t) || 0));
  return rgbToHex([0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * k));
}

/** 按当前时钟算出呼吸中的底色；不需要呼吸的状态原样返回 */
function glowingRecordColor(state, base) {
  const glow = RECORD_GLOW[state];
  if (!glow) return base;
  const phase = (Date.now() % glow.period) / glow.period;
  // 0 → 1 → 0 的平滑呼吸，用余弦而不是三角波，免得亮度突变
  const t = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
  return mixHex(glow.from, glow.to, t);
}

const STATE_COLORS = {
  [STATE_UNRECORDED]: { dot: "#8f2b2b", text: "#e59a9a", label: "未记录" },
  [STATE_DIRTY]: { dot: "#d9a441", text: "#ffd479", label: "待记录" },
  [STATE_SYNCED]: { dot: "#4c9a5e", text: "#8fd8a0", label: "已记录" },
  [STATE_MISSING]: { dot: "#b3352f", text: "#ff9a90", label: "待记录 · 缺节点" },
};

function sameWidgetValue(a, b) {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-9;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => sameWidgetValue(v, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => sameWidgetValue(a[k], b[k]));
  }
  return false;
}

/** 某个节点当前是否与快照一致 */
function nodeMatchesSnapshot(node, snap) {
  if (!node || !snap) return false;

  const modeNow = typeof node.mode === "number" ? node.mode : null;
  const modeWas = typeof snap.mode === "number" ? snap.mode : null;
  if (modeNow !== modeWas) return false;

  const bypassNow = typeof node.bypass === "boolean" ? node.bypass : null;
  const bypassWas = typeof snap.bypass === "boolean" ? snap.bypass : null;
  if (bypassNow !== bypassWas) return false;

  const snapWidgets = stateWidgets(snap);
  if (!snapWidgets || !Array.isArray(node.widgets)) return true;
  for (const widget of node.widgets) {
    if (isWidgetSnapshotSkipped(widget)) continue;
    if (!Object.prototype.hasOwnProperty.call(snapWidgets, widget.name)) continue;
    if (!sameWidgetValue(widget.value, snapWidgets[widget.name])) return false;
  }
  return true;
}

/** 未记录 / 待记录 / 已记录 */
function computePresetState(key) {
  const preset = ensureStore()?.presets?.[String(key)];
  if (!preset || !preset.updated_at) return STATE_UNRECORDED;
  if (!preset.nodes || !Object.keys(preset.nodes).length) return STATE_UNRECORDED;

  const excludedIds = excludedIdSet();
  for (const nodeId of Object.keys(preset.nodes)) {
    // 被排除的节点不参与"待记录"判定：它本来就不该被记录，
    // 拿"它变没变"来判定这份预设脏不脏是错的（会让面板一直黄着）
    if (excludedIds.has(String(nodeId))) continue;
    const node = app.graph?.getNodeById?.(Number(nodeId));
    // 节点被删掉属于"缺失节点"，不在这里判为有改动
    if (!node) continue;
    if (!nodeMatchesSnapshot(node, preset.nodes[nodeId])) return STATE_DIRTY;
  }

  // 记录过的节点被删掉了：预设已经不完整，单独一个状态
  if (Array.isArray(preset.missing_nodes) && preset.missing_nodes.length) return STATE_MISSING;

  // 注意：这里故意不把"后来又加了新节点"算成改动。
  // 否则新建一个预设后，所有已记录节点都成了"新节点"，别的预设会集体变黄。
  return STATE_SYNCED;
}
/* ------------------------------------------------------------------ *
 *  记录 / 套用
 * ------------------------------------------------------------------ */

function recordPreset(key) {
  const store = ensureStore();
  if (!store) return false;

  const k = String(key);
  const existing = store.presets[k];
  const { nodes, nodeIds } = snapshotPresetGraph();

  store.presets[k] = {
    name: existing?.name || defaultPresetName(k),
    nodes,
    node_ids: nodeIds,
    updated_at: Date.now(),
  };

  // 新记录已经包含了当前真实节点，旧的红点提示自动失效
  delete store.child_ack[k];

  // 立刻池化：否则这一份会以明文躺在工作流里，直到下次重新打开工作流才被迁移
  poolPresetWidgets(store, store.presets[k]);
  pruneWidgetPool(store);

  app.graph?.setDirtyCanvas(true, true);
  console.log(`[${EXTENSION_NAME}] recorded preset ${k}`, store.presets[k]);
  return true;
}

function applyStateToNode(node, state) {
  if (!node || !state) return;

  /*
   * 被"排除记录"的节点，套用预设时一概不碰。
   *
   * 判断放在这里而不是放在 applyPresetState 的循环里：这里是**唯一**的写入口，
   * 放这儿就等于无论谁调用、无论老预设里记了什么，这个节点都不会被改写。
   * 用户选的是"套用时跳过、老数据留着"——所以老预设里那些记录原样保留，
   * 以后取消排除立刻又能用。
   *
   * 但**只跳过、不早退整个流程**：mode / bypass 也不能写，因为"排除记录"
   * 的语义就是这个节点完全交给用户手动管。
   */
  if (isNodeExcluded(node)) return;

  if (typeof state.mode === "number") {
    node.mode = state.mode;
  }

  if (typeof state.bypass === "boolean") {
    node.bypass = state.bypass;
  }

  const wanted_widgets = stateWidgets(state);
  if (wanted_widgets && Array.isArray(node.widgets)) {
    for (const widget of node.widgets) {
      if (isWidgetSnapshotSkipped(widget)) continue;
      if (!Object.prototype.hasOwnProperty.call(wanted_widgets, widget.name)) continue;
      const wanted = wanted_widgets[widget.name];
      if (widget.value === wanted) continue;
      try {
        widget.value = Array.isArray(wanted) ? wanted.slice() : wanted;
        if (typeof widget.callback === "function") {
          widget.callback(widget.value, app.canvas, node, [0, 0], null);
        }
      } catch (error) {
        console.warn(
          `[${EXTENSION_NAME}] restore widget failed: ${node.title}.${widget.name}`,
          error
        );
      }
    }
  }

  if (typeof node.setDirtyCanvas === "function") {
    node.setDirtyCanvas(true, true);
  }
}

function applyUntrackedNodePolicy(node, policy) {
  if (!node) return;

  /*
   * 【控制器自己永远不参与"未记录节点策略"】
   *
   * 用户实测（m05646 图3）：「新建之后有个小bug，就是它会把自己给屏蔽掉，
   * 应该要排除自己吧」。
   *
   * 机理：预设开关节点本身也是画布上的一个节点。用户新放一个开关、
   * 或者某个预设是在"还没有这个开关"的时候录的，这个开关就不在预设记录的
   * node_ids 里 —— 于是被当成"没被本预设记录的节点"，按默认策略 bypass 掉，
   * 整个节点变紫、压暗。**控制器把自己关了，用户连切回去的地方都没有**，
   * 这是最恶性的一种自锁。
   *
   * 所以：任何 Preset Switch 节点都不走这条策略，永远保持可用。
   * 放在这个函数里而不是调用点上，是因为它必须覆盖所有调用方。
   */
  if (node.type === TARGET_NODE_NAME) return;

  /*
   * 被"排除记录"的节点同样不走这条策略。
   *
   * 这是"图被顶掉"的隐蔽那一半：默认策略 bypass 会把"这份预设没记录过的
   * 节点"整个关掉。用户把 LoadImage 排除之后，它在别的预设里自然也没被记录，
   * 如果不管，切过去时它就会被旁路 —— 图照样丢，用户会以为排除功能没生效。
   */
  if (isNodeExcluded(node)) return;

  if (policy === "bypass") {
    node.mode = MODE_BYPASS;
    node.bypass = true;
  } else if (policy === "enable") {
    node.mode = MODE_ENABLE;
    node.bypass = false;
  } else {
    return;
  }

  if (typeof node.setDirtyCanvas === "function") {
    node.setDirtyCanvas(true, true);
  }
}

/**
 * 把某个预设里的节点状态真正套到画布上。
 * 返回 { ok, missing }，missing 是被记录过、但现在已经不在画布上的节点。
 */
function applyPresetState(key, { trackMissing = true } = {}) {
  const store = ensureStore();
  if (!store) return { ok: false, missing: [] };

  const k = String(key);
  const preset = store.presets?.[k];

  if (!preset) {
    if (store.options?.indexOutOfRange === "warn") {
      console.warn(`[${EXTENSION_NAME}] preset ${k} not found`);
    }
    return { ok: false, missing: [] };
  }

  const trackedNodeIds = Object.keys(preset.nodes || {});
  const missing = [];

  /*
   * 【空预设必须什么都不做】
   *
   * 用户点「＋ 新增预设」时，新建的是一个**还没有记录任何节点**的预设。
   * 而下面那段"未记录节点策略"默认是 `bypass`（把没被这个预设记录的节点全部
   * 旁路掉）—— 对一个空预设来说，"没被记录的节点"就是画布上的**所有**节点，
   * 于是新建预设的瞬间，整个工作流的节点全被关掉（见用户反馈的图3）。
   *
   * 这不是用户想要的：新建预设的语义是"从这里开始，我接着改"，
   * 画布必须原样不动，等用户自己点「记录当前」。
   * （「新增子模式」走的是 recordPreset 路径，会把状态记下来，所以一直是对的。）
   *
   * 所以：没有任何被记录节点的预设，直接返回，绝不触碰画布。
   */
  if (trackedNodeIds.length === 0) {
    console.log(`[${EXTENSION_NAME}] preset ${k} 还没有记录任何节点，保持画布原样`);
    return { ok: true, missing: [] };
  }

  for (const nodeId of trackedNodeIds) {
    const node = app.graph?.getNodeById?.(Number(nodeId));
    if (!node) {
      const recorded = preset.nodes?.[nodeId] || {};
      if (trackMissing && !missing.some((e) => nodeInfoOf(e).id === String(nodeId))) {
        missing.push({
          id: String(nodeId),
          type: String(recorded.type || "?"),
          title: String(recorded.title || recorded.type || "?"),
        });
      }
      continue;
    }
    applyStateToNode(node, preset.nodes[nodeId]);
  }

  const untrackedPolicy = String(store.options?.onUntrackedNode || "bypass");
  if (untrackedPolicy !== "preserve") {
    const tracked = new Set(trackedNodeIds);
    for (const node of getAllNodes()) {
      if (!node || typeof node.id === "undefined") continue;
      if (tracked.has(String(node.id))) continue;
      applyUntrackedNodePolicy(node, untrackedPolicy);
    }
  }

  if (trackMissing) {
    if (missing.length) {
      preset.missing_nodes = missing;
      store.child_ack[k] = "pending";
    } else {
      delete preset.missing_nodes;
      delete store.child_ack[k];
    }
  }

  app.graph?.setDirtyCanvas(true, true);
  console.log(`[${EXTENSION_NAME}] applied preset ${k}`);
  return { ok: true, missing };
}

function applyPreset(key) {
  return applyPresetState(key).ok;
}

/** 子模式 = 先回到父模式的状态，再叠加子模式记录的差异 */
function applyPresetHierarchy(key) {
  const k = String(key);
  const rootKey = rootKeyOf(k);

  if (k === rootKey) return applyPresetState(k);

  if (ensureStore()?.presets?.[rootKey]) {
    applyPresetState(rootKey, { trackMissing: false });
  }
  return applyPresetState(k);
}

function forgetMissingNodes(key) {
  const store = ensureStore();
  if (!store) return false;

  const k = String(key);
  const preset = store.presets?.[k];
  if (!preset) return false;

  const missing = Array.isArray(preset.missing_nodes) ? preset.missing_nodes : [];
  delete preset.missing_nodes;

  // 已确认不需要的节点，从记录里摘掉，红点不再出现
  for (const token of missing) {
    // 条目现在是 { id, type, title } 对象（也兼容旧的 "Type#id" 字符串），
    // 之前这里还在按字符串切 "#"，导致对象条目一个都摘不掉。
    const nodeId = String(nodeInfoOf(token).id || "");
    if (!nodeId) continue;
    if (preset.nodes) delete preset.nodes[nodeId];
    if (Array.isArray(preset.node_ids)) {
      preset.node_ids = preset.node_ids.filter((id) => String(id) !== nodeId);
    }
  }

  delete store.child_ack[k];
  app.graph?.setDirtyCanvas(true, true);
  console.log(`[${EXTENSION_NAME}] forgot ${missing.length} missing node(s) in preset ${k}`);
  return true;
}

/* ------------------------------------------------------------------ *
 *  删除 / 移动 / 导航
 * ------------------------------------------------------------------ */

function reindexAfterRemoval(removedRoot) {
  const store = ensureStore();
  if (!store) return;

  const nextPresets = {};
  for (const [key, preset] of Object.entries(store.presets || {})) {
    const root = normalizeIndex(rootKeyOf(key));
    if (root === removedRoot) continue;

    const suffix = childSuffixOf(key);
    const newRoot = root > removedRoot ? root - 1 : root;
    const newKey = suffix === null ? String(newRoot) : `${newRoot}.${suffix}`;

    const moved = { ...preset };
    if (isDefaultPresetName(moved.name, key)) moved.name = defaultPresetName(newKey);
    nextPresets[newKey] = moved;
  }

  store.presets = nextPresets;
  store.child_ack = {};
}

function deletePreset(key) {
  const store = ensureStore();
  if (!store) return false;

  const k = String(key);
  if (!store.presets?.[k]) return false;

  const wasRoot = !isChildKey(k);

  if (wasRoot) {
    // 删父模式时，它的子模式一起删除，其余模式整体前移一位
    reindexAfterRemoval(normalizeIndex(k));
    // 池里没被引用的条目要跟着删，否则删了预设工作流体积一点不降
    pruneWidgetPool(store);
    console.log(`[${EXTENSION_NAME}] deleted preset ${k} (with its sub-modes) and reindexed`);
    app.graph?.setDirtyCanvas(true, true);
    return true;
  }

  const rootKey = rootKeyOf(k);
  delete store.presets[k];

  // 子项删除后，同一父级下的兄弟序号连续补位（1,2,3…）
  const remaining = listChildKeys(rootKey);
  remaining.forEach((oldKey, position) => {
    const preset = store.presets[oldKey];
    const newKey = makeChildKey(rootKey, position + 1);
    if (newKey === oldKey) return;
    if (isDefaultPresetName(preset.name, oldKey)) preset.name = defaultPresetName(newKey);
    store.presets[newKey] = preset;
    delete store.presets[oldKey];
  });

  app.graph?.setDirtyCanvas(true, true);
  pruneWidgetPool(store);
  console.log(`[${EXTENSION_NAME}] deleted sub-mode ${k}`);
  return true;
}

function movePresetIndex(fromKey, toKey) {
  const store = ensureStore();
  if (!store) return false;

  const from = String(fromKey);
  const to = String(toKey);
  if (from === to) return true;
  if (!store.presets?.[from] || !store.presets?.[to]) return false;

  // 只在同一层内重排：父模式和父模式换，子模式和同父的兄弟换
  if (isChildKey(from) !== isChildKey(to)) return false;
  if (isChildKey(from) && rootKeyOf(from) !== rootKeyOf(to)) return false;

  const moving = store.presets[from];

  if (!isChildKey(from)) {
    const rootSequence = listRootKeys();
    const fromPos = rootSequence.indexOf(from);
    const toPos = rootSequence.indexOf(to);
    if (fromPos < 0 || toPos < 0) return false;
    rootSequence.splice(fromPos, 1);
    rootSequence.splice(toPos, 0, from);

    const nextPresets = {};
    for (const [key, preset] of Object.entries(store.presets || {})) {
      if (isChildKey(key)) continue;
      const newRoot = normalizeIndex(rootSequence.shift() ?? key);
      const newKey = String(newRoot);
      const moved = preset;
      if (isDefaultPresetName(moved.name, key)) moved.name = defaultPresetName(newKey);
      nextPresets[newKey] = moved;
    }
    for (const [key, preset] of Object.entries(store.presets || {})) {
      if (!isChildKey(key)) continue;
      const suffix = childSuffixOf(key);
      const root = normalizeIndex(rootKeyOf(key));
      const newRoot = Object.keys(nextPresets).find(
        (rk) => normalizeIndex(rk) === root
      );
      if (newRoot === undefined) continue;
      const newKey = `${newRoot}.${suffix}`;
      const moved = preset;
      if (isDefaultPresetName(moved.name, key)) moved.name = defaultPresetName(newKey);
      nextPresets[newKey] = moved;
    }
    store.presets = nextPresets;
  } else {
    const rootKey = rootKeyOf(from);
    const sequence = listChildKeys(rootKey);
    const fromPos = sequence.indexOf(from);
    const toPos = sequence.indexOf(to);
    if (fromPos < 0 || toPos < 0) return false;
    sequence.splice(fromPos, 1);
    sequence.splice(toPos, 0, from);

    const nextPresets = {};
    for (const [key, preset] of Object.entries(store.presets || {})) {
      if (!isChildKey(key) || rootKeyOf(key) !== rootKey) {
        nextPresets[key] = preset;
        continue;
      }
      const newKey = makeChildKey(rootKey, sequence.shift() ?? childSuffixOf(key));
      const moved = preset;
      if (isDefaultPresetName(moved.name, key)) moved.name = defaultPresetName(newKey);
      nextPresets[newKey] = moved;
    }
    store.presets = nextPresets;
  }

  app.graph?.setDirtyCanvas(true, true);
  console.log(`[${EXTENSION_NAME}] moved preset ${from} -> ${to}`);
  return true;
}

function stepPresetKey(key, step) {
  const all = listAllKeys();
  if (!all.length) return String(key);
  const current = String(key);
  const at = all.indexOf(current);
  if (at < 0) return step > 0 ? all[0] : all[all.length - 1];
  const next = (at + step + all.length) % all.length;
  return all[next];
}

function currentKeyOfNode(node) {
  const rootIndex = getPresetIndexFromNode(node);
  const stored = node.__wpsActiveKey;

  // 只有当 widget 上的值仍与记账时的值一致，子模式选择才算有效；
  // 否则说明模式被外部改过（例如点了父模式行），应以 widget 为准。
  if (
    stored &&
    ensureStore()?.presets?.[stored] &&
    node.__wpsActiveRoot === rootIndex
  ) {
    return stored;
  }

  return String(rootIndex);
}

/** 记账当前激活项，同时记下对应的 preset_index，供 currentKeyOfNode 判断是否过期 */
function syncActiveKey(node, key, rootIndex) {
  node.__wpsActiveKey = String(key);
  node.__wpsActiveRoot =
    typeof rootIndex === "number" ? rootIndex : normalizeIndex(rootKeyOf(key));
}

function setIndexWidgetValue(node, value) {
  const widget = node?.widgets?.find((w) => w?.name === "preset_index");
  if (!widget) return;
  widget.value = normalizeIndex(value);
}

/* ------------------------------------------------------------------ *
 *  缺失节点弹窗
 * ------------------------------------------------------------------ */

let ComfyDialogClass = null;

/*
 * `import()` 是异步的，而用户点「⚙ 设置」/点红点可能在它完成之前就发生 ——
 * 那时 ComfyDialogClass 还是 null，对话框会静默退回到自建的简易遮罩
 * （= 画面上多出来一个不属于任何人的 .comfy-modal）。把 promise 留下来，
 * 打开对话框前先等它，就不用靠"手速够慢"来碰运气了。
 */
const comfyDialogReady = (async () => {
  try {
    const mod = await import("../../../scripts/ui.js");
    ComfyDialogClass = mod?.ComfyDialog || null;
    // 拿到就立刻包一层去重，之后所有对话框都只有一个（见 installDialogDedup）
    installDialogDedup();
  } catch (error) {
    console.warn(`[${EXTENSION_NAME}] ComfyDialog unavailable, using fallback panel`);
  }
  return ComfyDialogClass;
})();

/**
 * 等 UI 模块就绪，返回可用的对话框类（拿不到就返回 null，调用方走回退方案）。
 *
 * 上层必须 `await` 这个再决定怎么弹窗，别直接用 ComfyDialogClass —— 那是在赌
 * 用户点得比 import 慢。
 */
async function ensureDialogClass() {
  if (ComfyDialogClass) return ComfyDialogClass;
  try {
    await comfyDialogReady;
  } catch (error) {
    /* 上面那个 IIFE 自己已经 catch 过了，这里只是双保险 */
  }
  return ComfyDialogClass;
}

function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

/**
 * 缺失节点的一条记录。
 * 现在存对象 { id, type, title }，节点名取"记录那一刻"的标题 ——
 * 节点已经从画布上删掉了，只能靠快照里的名字告诉用户"删的是哪个"。
 * 旧数据是 "Type#id" 字符串，这里一并兼容。
 */
function nodeInfoOf(entry) {
  if (entry && typeof entry === "object") {
    return {
      id: String(entry.id ?? "?"),
      type: String(entry.type || "?"),
      title: String(entry.title || entry.type || "?"),
    };
  }
  const token = String(entry);
  const at = token.lastIndexOf("#");
  if (at < 0) return { id: "?", type: token || "?", title: token || "?" };
  const type = token.slice(0, at);
  return { id: token.slice(at + 1), type, title: type };
}

/** 给用户看的名字：有名字就"名字 (Type #id)"，名字和类型一样就只显示 "Type #id" */
function missingLabelOf(entry) {
  const { id, type, title } = nodeInfoOf(entry);
  const clean = (v) => String(v || "").trim();
  const name = clean(title);
  const kind = clean(type) || "?";
  if (!name || name === kind || name === "?") return `${kind} #${id}`;
  return `${name} (${kind} #${id})`;
}

/** 缺失记录之间比"是不是同一批"，避免每次刷新都判成变化 */
function missingFingerprintOf(list) {
  return list
    .map((e) => {
      const { id, type } = nodeInfoOf(e);
      return `${type}#${id}`;
    })
    .sort()
    .join(",");
}

function buildMissingDialogBody(key, tokens) {
  const rows = tokens
    .map((entry) => {
      const { id, type, title } = nodeInfoOf(entry);
      const name = String(title || "").trim();
      const kind = String(type || "?").trim();
      const showName = name && name !== kind && name !== "?";
      return `<tr>
        <td style="padding:6px 10px 6px 0;color:#ff9a90;font-weight:600;font-size:14px;">
          ${escapeHtml(showName ? name : kind)}
        </td>
        <td style="padding:6px 10px 6px 0;color:#c3c8ce;font-family:Consolas,monospace;font-size:12px;">
          ${showName ? `${escapeHtml(kind)} ` : ""}#${escapeHtml(id)}
        </td>
      </tr>`;
    })
    .join("");

  return `
    <div style="min-width:440px;max-width:640px;color:#e6e6e6;">
      <div style="font-size:14px;line-height:1.6;margin-bottom:12px;">
        预设 <b style="color:#ffd479;">${escapeHtml(key)} · ${escapeHtml(getPresetName(key))}</b>
        记过 <b style="color:#ff6b6b;">${tokens.length}</b> 个节点，
        现在画布上找不到了 —— 多半是<b>被删掉</b>了，或者这个工作流没加载完整。
      </div>
      <div style="max-height:280px;overflow:auto;background:#1b1b1b;border:1px solid #3a3a3a;border-radius:6px;padding:10px;">
        <table style="border-collapse:collapse;font-size:13px;">
          <tr>
            <th style="text-align:left;padding:0 10px 8px 0;color:#9aa0a8;font-weight:500;">节点名称</th>
            <th style="text-align:left;padding:0 10px 8px 0;color:#9aa0a8;font-weight:500;">类型 / ID</th>
          </tr>
          ${rows}
        </table>
      </div>
      <div style="font-size:12px;color:#9aa0a8;margin-top:10px;line-height:1.6;">
        名字是<b>当初记录这条预设时</b>的节点标题，所以即使节点已删掉也认得出来。<br>
        确认不再需要 → 点「忽略这条记录」把红点去掉；想找回来 → 先「复制清单」，再把节点加回画布。
      </div>
    </div>
  `;
}

function fallbackMissingOverlay(key, tokens, onForget) {
  const backdrop = document.createElement("div");
  backdrop.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:99999;display:flex;" +
    "align-items:center;justify-content:center;";

  const box = document.createElement("div");
  box.style.cssText =
    "background:#262626;border:1px solid #444;border-radius:8px;padding:18px;max-width:680px;";

  box.innerHTML = buildMissingDialogBody(key, tokens);

  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;gap:8px;justify-content:flex-end;margin-top:14px;";

  const makeButton = (label, handler) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText =
      "padding:6px 14px;border-radius:5px;border:1px solid #555;background:#3a3a3a;" +
      "color:#eee;cursor:pointer;font-size:13px;";
    b.onclick = handler;
    return b;
  };

  bar.appendChild(
    makeButton("忽略这条记录（去掉红点）", () => {
      onForget();
      backdrop.remove();
    })
  );
  bar.appendChild(makeButton("关闭", () => backdrop.remove()));

  box.appendChild(bar);
  backdrop.appendChild(box);
  document.body.appendChild(backdrop);
  uiLogEvent("missing-overlay+", `兜底弹层 preset=${key}`);
}

async function showMissingNodesDialog(node, key) {
  // 自检计数：测试与排障用，确认"点了真的弹了"
  globalThis.__wpsMissingDialogCount = (globalThis.__wpsMissingDialogCount || 0) + 1;
  const k = String(key);
  const tokens = Array.isArray(ensureStore()?.presets?.[k]?.missing_nodes)
    ? ensureStore().presets[k].missing_nodes
    : [];
  uiLogEvent("missing-dialog", `preset=${k} tokens=${tokens.length}`);

  if (!tokens.length) {
    console.warn(`[${EXTENSION_NAME}] 预设 ${k} 没有缺失节点记录`);
    return;
  }

  const onForget = () => {
    forgetMissingNodes(k);
    refreshPresetWidgets(node);
  };

  const copyList = () => {
    const text = tokens.map((entry) => missingLabelOf(entry)).join("\n");
    try {
      navigator.clipboard?.writeText(text);
      console.log(`[${EXTENSION_NAME}] 缺失节点清单已复制:\n${text}`);
    } catch (error) {
      console.warn(`[${EXTENSION_NAME}] 复制失败`, error);
    }
  };

  // 优先用 ComfyUI 自己的对话框；任何一步失败都退回到自建遮罩，
  // 保证"点缺失点一定弹出东西"，不会静默失败。
  const DialogClass = await ensureDialogClass();
  if (DialogClass) {
    try {
      const dialog = new DialogClass();
      dialog.show();
      dialog.textElement.innerHTML = buildMissingDialogBody(k, tokens);

      const bar = document.createElement("div");
      bar.style.cssText = "display:flex;gap:8px;justify-content:flex-end;margin-top:14px;";

      const makeButton = (label, handler) => {
        const b = document.createElement("button");
        b.textContent = label;
        b.className = "comfy-btn";
        b.style.cssText =
          "padding:6px 14px;border-radius:5px;border:1px solid #555;background:#3a3a3a;" +
          "color:#eee;cursor:pointer;font-size:13px;";
        b.onclick = handler;
        return b;
      };

      bar.appendChild(makeButton("复制清单 / Copy", copyList));
      bar.appendChild(
        makeButton("忽略这条记录（去掉红点）", () => {
          onForget();
          dialog.close();
        })
      );
      /*
       * 这里**故意**不再放一个「关闭 / Close」。
       *
       * ComfyDialog 自己就带一个原生 Close，我们再放一个，窗口底部就会出现
       * 两个功能完全一样的按钮 —— 用户 m05646 的图2 指的就是这件事
       * （那时是设置窗口，这里是同一处毛病）。留原生那个：它是
       * `.comfy-modal-content` 里正文的兄弟节点，永远不会被正文滚走。
       */

      dialog.textElement.appendChild(bar);
      return;
    } catch (error) {
      console.warn(`[${EXTENSION_NAME}] ComfyDialog 不可用，改用内置遮罩`, error);
    }
  }

  fallbackMissingOverlay(k, tokens, onForget);
}/* ------------------------------------------------------------------ *
 *  快捷键：规范化、冲突检查、设置界面
 * ------------------------------------------------------------------ */

/**
 * 已知会冲突的按键。分三类：
 *  - system : Windows / 浏览器保留，按下根本到不了页面
 *  - comfy  : ComfyUI 自带快捷键，会被抢走
 *  - risky  : 能注册，但容易误触（输入框里打字、删节点等）
 */
const KEY_CONFLICTS = {
  "alt+space": { kind: "system", why: "Windows 系统保留（窗口控制菜单），按不到页面" },
  "win+space": { kind: "system", why: "Windows 输入法切换" },
  "win+l": { kind: "system", why: "Windows 锁屏" },
  "win+d": { kind: "system", why: "Windows 显示桌面" },
  "alt+f4": { kind: "system", why: "Windows 关闭窗口" },
  "alt+tab": { kind: "system", why: "Windows 切换窗口" },
  "ctrl+w": { kind: "system", why: "浏览器关闭标签页" },
  "ctrl+t": { kind: "system", why: "浏览器新建标签页" },
  "ctrl+n": { kind: "system", why: "浏览器新建窗口" },
  "ctrl+shift+w": { kind: "system", why: "浏览器关闭窗口" },
  "ctrl+shift+delete": { kind: "system", why: "浏览器清除数据" },
  f5: { kind: "system", why: "浏览器刷新" },
  f11: { kind: "system", why: "浏览器全屏" },
  f12: { kind: "system", why: "浏览器开发者工具" },

  "ctrl+enter": { kind: "comfy", why: "ComfyUI 执行队列" },
  "ctrl+s": { kind: "comfy", why: "ComfyUI 保存工作流" },
  "ctrl+o": { kind: "comfy", why: "ComfyUI 打开工作流" },
  "ctrl+a": { kind: "comfy", why: "ComfyUI 全选节点" },
  "ctrl+z": { kind: "comfy", why: "ComfyUI 撤销" },
  "ctrl+y": { kind: "comfy", why: "ComfyUI 重做" },
  "ctrl+shift+z": { kind: "comfy", why: "ComfyUI 重做" },
  "ctrl+c": { kind: "comfy", why: "ComfyUI 复制节点" },
  "ctrl+v": { kind: "comfy", why: "ComfyUI 粘贴节点" },
  "ctrl+x": { kind: "comfy", why: "ComfyUI 剪切节点" },
  "ctrl+m": { kind: "comfy", why: "ComfyUI 静音/跳过节点" },
  "ctrl+b": { kind: "comfy", why: "ComfyUI 绕过节点" },
  "ctrl+g": { kind: "comfy", why: "ComfyUI 打组" },
  "ctrl+0": { kind: "comfy", why: "ComfyUI 重置缩放" },
  "ctrl+shift+enter": { kind: "comfy", why: "ComfyUI 执行到此处" },
  "alt+c": { kind: "comfy", why: "ComfyUI 画布相关快捷键" },
  "alt+s": { kind: "comfy", why: "ComfyUI 画布相关快捷键" },
  "alt+a": { kind: "comfy", why: "ComfyUI 画布相关快捷键" },
  "alt+left": { kind: "comfy", why: "ComfyUI 后退（历史导航）" },

  delete: { kind: "risky", why: "会删除选中的节点，误触代价大" },
  backspace: { kind: "risky", why: "会删除选中的节点，误触代价大" },
  space: { kind: "risky", why: "空格常用作拖动画布，且输入框里会打空格" },
  tab: { kind: "risky", why: "会切换界面焦点" },
  escape: { kind: "risky", why: "Esc 大量用于取消操作" },
  enter: { kind: "risky", why: "回车到处都在用" },
};

const MODIFIER_ONLY = new Set(["control", "alt", "shift", "meta", "altgraph", "capslock"]);

/** 把键盘事件规范化成 "ctrl+alt+x" 这样的字符串 */
function normalizeKeyEvent(event) {
  const parts = [];
  if (event.ctrlKey) parts.push("ctrl");
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  if (event.metaKey) parts.push("win");

  const key = String(event.key || "").toLowerCase();
  if (MODIFIER_ONLY.has(key)) return { combo: parts.join("+"), modifierOnly: true };

  let name = key;
  if (key === " ") name = "space";
  else if (key === "escape") name = "escape";
  else if (key === "arrowleft") name = "left";
  else if (key === "arrowright") name = "right";
  else if (key === "arrowup") name = "up";
  else if (key === "arrowdown") name = "down";

  parts.push(name);
  return { combo: parts.join("+"), modifierOnly: false };
}

/** 组合键是否可用；返回 null 表示没问题 */
function checkHotkeyConflict(combo) {
  if (!combo) return null;
  return KEY_CONFLICTS[combo] || null;
}

/** 没有修饰键的组合几乎都会和输入框打架 */
function missingModifierWarning(combo) {
  if (!combo) return null;
  const hasModifier = /(^|\+)(ctrl|alt|shift|win)(\+|$)/.test(combo);
  if (hasModifier) return null;
  return "这个组合没有 Ctrl / Alt / Shift，在节点搜索框里打字时会误触发";
}

function hotkeyLabel(combo) {
  if (!combo) return "（未设置）";
  return combo
    .split("+")
    .map((p) => {
      if (p === "ctrl") return "Ctrl";
      if (p === "alt") return "Alt";
      if (p === "shift") return "Shift";
      if (p === "win") return "Win";
      if (p === "space") return "空格";
      if (p.length === 1) return p.toUpperCase();
      return p.charAt(0).toUpperCase() + p.slice(1);
    })
    .join(" + ");
}

function conflictMessage(combo) {
  if (!combo) return { level: "ok", text: "快捷键已关闭，面板只能从节点上打开。" };
  const hit = checkHotkeyConflict(combo);
  if (hit) {
    const tag = hit.kind === "system" ? "系统/浏览器保留" : hit.kind === "comfy" ? "与 ComfyUI 冲突" : "容易误触";
    return { level: hit.kind === "risky" ? "warn" : "bad", text: `${tag}：${hit.why}` };
  }
  const warn = missingModifierWarning(combo);
  if (warn) return { level: "warn", text: warn };
  return { level: "ok", text: "这个组合可用，未发现冲突。" };
}

/** 设置界面里的小工具条，避免整段复用字符串拼接 */
function settingsField(label, hint) {
  return `
    <div style="margin-bottom:14px;">
      <div style="font-size:12px;color:#cfd4da;margin-bottom:4px;">${escapeHtml(label)}</div>
      ${hint ? `<div style="font-size:11px;color:#8b9199;margin-bottom:6px;line-height:1.5;">${hint}</div>` : ""}
    </div>`;
}

/* ------------------------------------------------------------------ *
 *  设置界面
 * ------------------------------------------------------------------ */

const LEVEL_COLOR = {
  ok: "#7fd18f",
  warn: "#ffd479",
  bad: "#ff7b7b",
};

function buildSettingsBody() {
  return `
<div class="wps-set">
  <h1>X-WIDE Preset Switch 设置 / Settings</h1>

  <!-- 作者放最前面：用户要求"把作者放到开头" -->
  <div class="sec first">
    <h2>作者 / Authors</h2>

    <div class="card">
      <img src="${escapeHtml(pluginAssetUrl(config.brandImage))}" alt="X-WIDE" />
      <div>
        <div class="who">X-WIDE（本版本 / This version）</div>
        <div class="what">
          在原作者作品基础上的<b>升级版本</b>：新增子模式、缺失节点提示、
          快捷键、清爽模式、参数值记录等，遵循 GPL-3.0 继续开源。
        </div>
        <div style="margin-top:6px;">
          <a href="${escapeHtml(config.brandUrl)}" target="_blank" rel="noopener noreferrer">打开作者主页 / Author Page &#8599;</a>
        </div>
        <div style="margin-top:4px;">
          <a href="${escapeHtml(config.repoUrl || PROJECT_REPO_URL)}" target="_blank" rel="noopener noreferrer">开源项目首页 / GitHub &#8599;</a>
          <span style="color:#6b7079;">&nbsp;·&nbsp;</span>
          <span style="color:#6b7079;">${escapeHtml(config.repoUrl || PROJECT_REPO_URL)}</span>
        </div>
      </div>
    </div>

    <div class="card">
      <div>
        <div class="who" style="color:#cfd4da;">${escapeHtml(ORIGINAL_AUTHOR.name)}（原作者 / Original author）</div>
        <div class="what">${escapeHtml(ORIGINAL_AUTHOR.project)}</div>
        <div class="what" style="margin-top:4px;">本项目的原始版本由 ${escapeHtml(ORIGINAL_AUTHOR.name)} 开发，版权归原作者所有。</div>
        <div style="margin-top:6px;">
          <a href="${escapeHtml(ORIGINAL_AUTHOR.url)}" target="_blank" rel="noopener noreferrer">查看原项目 / View Original &#8599;</a>
        </div>
      </div>
    </div>
  </div>

  <!--
    排除记录。用户 m06692 要的功能，也是他自己描述的那个真实痛点：
    「我的编辑模型里面载入了 6 张图，然后我切过去到文生图的时候，他之前可能
      只是载入了一张图，这会顶掉我之前在编辑模型下的载入的多张图」
  -->
  <div class="sec">
    <h2>排除记录 / Exclude from recording</h2>
    <p class="hint">
      预设默认会把<b>全部节点</b>的当前状态记下来 ——
      <b>包括 LoadImage 里载入的图片、模型加载器里选的模型、ControlNet 的参考图</b>。
      所以你在「图像编辑」里载入了 6 张图，切到「文生图」（那边只记了 1 张），
      那 6 张就会被顶掉。
    </p>
    <p class="hint">
      把不想被记录的节点排掉之后，它们就<b>完全交给你手动管</b>：
      不参与记录、切预设时不改写、也不会被「未记录节点策略」旁路掉。
      名单对整个工作流的所有预设生效。
    </p>
    <div class="btns">
      <button id="wps-ex-open" class="comfy-btn">📋 打开排除清单 / Open list</button>
    </div>
    <p class="hint" style="margin-top:10px;">
      更快的办法：在画布上<b>选中节点 → 右键 → 🚫 排除记录</b>，
      一次可以选好几个一起排。
    </p>
  </div>

  <!-- 帮助文档入口。用户要求放在两位作者后面。 -->
  <div class="sec">
    <h2>帮助文档 / Help</h2>
    <p class="hint">完整的功能说明、快捷键一览、以及常见问题的排查办法。</p>
    <div class="btns">
      <button id="wps-help-open" class="comfy-btn">📖 打开帮助文档 / Open Help</button>
    </div>
  </div>

  <div class="sec">
    <h2>快捷键 / Hotkey</h2>
    <p class="hint">点下面的方框，然后按下你想要的组合键。建议用 <b>Alt + 字母</b> 这类两键组合。</p>
    <input id="wps-hotkey-input" type="text" readonly value="${escapeHtml(hotkeyLabel(config.hotkey))}" />
    <div id="wps-hotkey-status" class="status"></div>
    <div class="btns">
      <button id="wps-hotkey-clear" class="comfy-btn">清除快捷键</button>
      <button id="wps-hotkey-reset" class="comfy-btn">恢复默认 (${escapeHtml(hotkeyLabel(CONFIG_DEFAULTS.hotkey))})</button>
    </div>

    <p class="hint" style="margin-top:16px;">快捷键做什么 / What it does</p>
    <div class="radios">
      <label><input type="radio" name="wps-hotkey-action" value="compact" ${config.hotkeyAction === "compact" || !config.hotkeyAction ? "checked" : ""} />
        <span>进入 / 退出<b>清爽模式</b> —— 收起工具栏，只留预设列表（推荐）</span></label>
      <label><input type="radio" name="wps-hotkey-action" value="collapse" ${config.hotkeyAction === "collapse" ? "checked" : ""} />
        <span>收起 / 展开<b>整个面板</b> —— 连预设列表一起收起来<br>
          <span style="font-size:0.9em;color:#8b9199;">（想一键腾出画布空间时用）</span></span></label>
    </div>
    <p class="hint" style="margin-top:12px;">
      不想用快捷键？把上面的键清空即可（点方框后按 Esc）。
    </p>
  </div>

  <div class="sec">
    <h2>跳转快捷键 / Jump to node</h2>
    <p class="hint">
      鼠标停在画布的哪块地方，按一下就把 Preset Switch 节点<b>搬到你鼠标底下</b>，<br>
      顺手选中它、闪一下边框告诉你"在这儿"——想挪到哪儿调就挪到哪儿。<br>
      鼠标不在画布上时（比如停在侧边栏），退回"把画面移到节点上"。
    </p>
    <input id="wps-jump-input" type="text" readonly value="${escapeHtml(hotkeyLabel(config.jumpHotkey))}" />
    <div id="wps-jump-status" class="status"></div>
    <div class="btns">
      <button id="wps-jump-clear" class="comfy-btn">清除快捷键</button>
      <button id="wps-jump-reset" class="comfy-btn">恢复默认 (${escapeHtml(hotkeyLabel(CONFIG_DEFAULTS.jumpHotkey))})</button>
    </div>
    <p class="hint" style="margin-top:12px;">
      一个工作流只允许有<b>一个</b>在用的预设开关。如果你不小心放了第二个，
      它会被自动停用（节点上会画一条提示），跳转永远跳到<b>在用的那一个</b>。
    </p>
  </div>

  <div class="sec">
    <h2>浮层缩放范围 / Overlay scale</h2>
    <p class="hint">工具栏、红点、开关跟随画布缩放，但夹在这个范围内。1.0 = 不缩放。</p>
    <div class="row">
      <label>最小</label>
      <input id="wps-scale-min" type="number" step="0.1" min="0.2" max="3" value="${config.scaleMin}" />
      <label>最大</label>
      <input id="wps-scale-max" type="number" step="0.1" min="0.2" max="3" value="${config.scaleMax}" />
    </div>
  </div>

  <div class="ver">
    X-WIDE Preset Switch Plus &nbsp;<b>v${escapeHtml(PLUGIN_VERSION)}</b><br>
    快捷键 ${escapeHtml(hotkeyLabel(config.hotkey))}${config.jumpHotkey ? ` · 跳转 ${escapeHtml(hotkeyLabel(config.jumpHotkey))}` : ""} · 基于 ${escapeHtml(ORIGINAL_AUTHOR.name)} 的作品升级 · GPL-3.0<br>
    设置保存在浏览器本地，所有工作流共用
  </div>
</div>
`;
}

function wireSettingsDialog(dialog, onChanged) {
  const root = dialog.textElement;
  const input = root.querySelector("#wps-hotkey-input");
  const status = root.querySelector("#wps-hotkey-status");
  const minInput = root.querySelector("#wps-scale-min");
  const maxInput = root.querySelector("#wps-scale-max");
  const brandInput = root.querySelector("#wps-brand-input");
  const brandUrlInput = root.querySelector("#wps-brandurl-input");
  const brandImageInput = root.querySelector("#wps-brandimage-input");
  const brandStatus = root.querySelector("#wps-brand-status");

  // 这两个按钮只是去开另一个窗口，本身不改任何设置值，所以不碰 onChanged
  const exOpen = root.querySelector("#wps-ex-open");
  if (exOpen) exOpen.onclick = () => showExclusionDialog();
  const helpOpen = root.querySelector("#wps-help-open");
  if (helpOpen) helpOpen.onclick = () => showHelpDialog();

  // 快捷键动作：清爽模式 / 整个面板收起
  const actionRadios = root.querySelectorAll
    ? Array.from(root.querySelectorAll('input[name="wps-hotkey-action"]'))
    : [];
  for (const radio of actionRadios) {
    radio.onchange = () => {
      if (!radio.checked) return;
      const v = radio.value;
      config.hotkeyAction = v === "collapse" ? "collapse" : "compact";
      saveConfig();
      onChanged?.();
    };
  }

  const paintStatus = (combo) => {
    if (!status) return;
    const { level, text } = conflictMessage(combo);
    status.style.color = LEVEL_COLOR[level] || "#8b9199";
    status.textContent = (level === "ok" ? "✓ " : level === "warn" ? "! " : "✕ ") + text;
  };

  paintStatus(config.hotkey);

  // 显式回填当前值，不依赖 HTML 属性
  if (input) input.value = hotkeyLabel(config.hotkey);
  if (minInput) minInput.value = config.scaleMin;
  if (maxInput) maxInput.value = config.scaleMax;

  if (input) {
    input.addEventListener("keydown", (event) => {
      event.preventDefault();
      event.stopPropagation();

      const { combo, modifierOnly } = normalizeKeyEvent(event);

      if (event.key === "Escape") {
        input.blur();
        return;
      }
      if (modifierOnly || !combo) {
        input.value = "按下组合键…";
        return;
      }

      config.hotkey = combo;
      input.value = hotkeyLabel(combo);
      paintStatus(combo);
      saveConfig();
      installHotkey();
      onChanged?.();
    });
  }

  const clearBtn = root.querySelector("#wps-hotkey-clear");
  if (clearBtn) {
    clearBtn.onclick = () => {
      config.hotkey = "";
      if (input) input.value = hotkeyLabel("");
      paintStatus("");
      saveConfig();
      installHotkey();
      onChanged?.();
    };
  }

  const resetBtn = root.querySelector("#wps-hotkey-reset");
  if (resetBtn) {
    resetBtn.onclick = () => {
      config.hotkey = CONFIG_DEFAULTS.hotkey;
      if (input) input.value = hotkeyLabel(config.hotkey);
      paintStatus(config.hotkey);
      saveConfig();
      installHotkey();
      onChanged?.();
    };
  }

  /*
   * 跳转快捷键。结构跟上面那个一样，但**状态与冲突提示各自独立**：
   * 一个键可用不代表另一个也可用，共用一个提示行会互相盖掉。
   */
  const jumpInput = root.querySelector("#wps-jump-input");
  const jumpStatus = root.querySelector("#wps-jump-status");

  const paintJumpStatus = (combo) => {
    if (!jumpStatus) return;
    if (combo && combo === config.hotkey) {
      jumpStatus.style.color = LEVEL_COLOR.warn || "#d9a441";
      jumpStatus.textContent = "! 和上面的主快捷键一样了，两个键会互相抢";
      return;
    }
    const { level, text } = conflictMessage(combo);
    jumpStatus.style.color = LEVEL_COLOR[level] || "#8b9199";
    jumpStatus.textContent = (level === "ok" ? "✓ " : level === "warn" ? "! " : "✕ ") + text;
  };

  if (jumpInput) jumpInput.value = hotkeyLabel(config.jumpHotkey);
  paintJumpStatus(config.jumpHotkey);

  if (jumpInput) {
    jumpInput.addEventListener("keydown", (event) => {
      event.preventDefault();
      event.stopPropagation();

      const { combo, modifierOnly } = normalizeKeyEvent(event);

      if (event.key === "Escape") {
        jumpInput.blur();
        return;
      }
      if (modifierOnly || !combo) {
        jumpInput.value = "按下组合键…";
        return;
      }

      config.jumpHotkey = combo;
      jumpInput.value = hotkeyLabel(combo);
      paintJumpStatus(combo);
      saveConfig();
      installJumpHotkey();
      onChanged?.();
    });
  }

  const jumpClear = root.querySelector("#wps-jump-clear");
  if (jumpClear) {
    jumpClear.onclick = () => {
      config.jumpHotkey = "";
      if (jumpInput) jumpInput.value = hotkeyLabel("");
      paintJumpStatus("");
      saveConfig();
      installJumpHotkey();
      onChanged?.();
    };
  }

  const jumpReset = root.querySelector("#wps-jump-reset");
  if (jumpReset) {
    jumpReset.onclick = () => {
      config.jumpHotkey = CONFIG_DEFAULTS.jumpHotkey;
      if (jumpInput) jumpInput.value = hotkeyLabel(config.jumpHotkey);
      paintJumpStatus(config.jumpHotkey);
      saveConfig();
      installJumpHotkey();
      onChanged?.();
    };
  }

  const commitScale = () => {    config.scaleMin = clampNumber(minInput?.value, 0.2, 3, CONFIG_DEFAULTS.scaleMin);
    config.scaleMax = clampNumber(maxInput?.value, 0.2, 3, CONFIG_DEFAULTS.scaleMax);
    if (config.scaleMax < config.scaleMin) {
      const swap = config.scaleMin;
      config.scaleMin = config.scaleMax;
      config.scaleMax = swap;
    }
    if (minInput) minInput.value = config.scaleMin;
    if (maxInput) maxInput.value = config.scaleMax;
    saveConfig();
    onChanged?.();
  };
  if (minInput) minInput.onchange = commitScale;
  if (maxInput) maxInput.onchange = commitScale;

  const commitBrand = () => {
    // 只更新真正存在的输入框，避免"取不到元素"时把配置写成空字符串，
    // 从而把默认的作者主页 / logo 路径清掉
    if (brandInput) config.brand = String(brandInput.value ?? "").trim();
    if (brandUrlInput) config.brandUrl = String(brandUrlInput.value ?? "").trim();
    if (brandImageInput) config.brandImage = String(brandImageInput.value ?? "").trim();

    if (!config.brand) config.brand = CONFIG_DEFAULTS.brand;
    if (!config.brandUrl) config.brandUrl = CONFIG_DEFAULTS.brandUrl;
    if (!config.brandImage) config.brandImage = CONFIG_DEFAULTS.brandImage;

    saveConfig();

    if (brandStatus) {
      const note = config.brandImage
        ? "，logo：" + config.brandImage
        : "，当前用文字显示";
      if (!config.brandUrl) {
        brandStatus.style.color = "#ffd479";
        brandStatus.textContent = "! 未填网址，徽章点了不会有反应" + note;
      } else if (!/^https?:\/\//i.test(config.brandUrl)) {
        brandStatus.style.color = "#ff7b7b";
        brandStatus.textContent = "✕ 只支持 http/https 开头的网址，点了不会打开" + note;
      } else {
        brandStatus.style.color = "#7fd18f";
        brandStatus.textContent = "✓ 点面板左下的署名就会打开这个网址" + note;
      }
    }

    onChanged?.();
  };

  if (brandInput) brandInput.onchange = commitBrand;
  if (brandUrlInput) brandUrlInput.onchange = commitBrand;
  if (brandImageInput) brandImageInput.onchange = commitBrand;
  commitBrand();
}

/*
 * 当前打开着的设置窗口。同一时刻只允许一个。
 *
 * v0.12.14 之前这里是 `let settingsDialog = null;`，存的是一个 ComfyDialog
 * 实例；现在存的是 buildSettingsWindow() 造出来的自建窗口（形状见那个函数）。
 * 变量名一起改掉，是为了让"这里已经不是 ComfyDialog 了"在任何一处都看得见 ——
 * 留个旧名字，下一个读代码的人会以为还能调 dialog.show()。
 */
let settingsWindow = null;

/**
 * 关掉并摘掉当前设置窗口。
 *
 * 不能只调 `dialog.close()` —— 它只做 `element.style.display = "none"`，
 * 节点还留在 document.body 里。反复开关就会往 body 里堆一串隐藏的
 * `.comfy-modal`，而 ComfyUI 判断"有没有弹窗挡着画布"用的
 * `hasVisibleLegacyModal()` 正是遍历这些节点，堆多了迟早出怪事。
 * 直接 remove() 最干净：下次打开会 new 一个全新的对话框。
 */
function closeSettingsDialog() {
  const dialog = settingsWindow;
  settingsWindow = null;
  uiLogEvent("settings-", dialog ? "关闭设置窗口" : "关了个寂寞（本来就没开）");
  if (!dialog) return;
  try {
    dialog.close?.();
  } catch (error) {
    /* 关不掉也要继续摘节点，不能因为这一步失败就把窗口留在屏幕上 */
  }
  try {
    dialog.element?.remove?.();
  } catch (error) {
    /* 节点可能已经不在文档里了 */
  }
}

/*
 * 让所有走 ComfyDialog 的对话框天然只存在一个。
 *
 * 用户实测（m04407）：「在打开设置面板的时候，你再重复点设置面板，它会开 N 个」。
 * 根因在前端里，不在我们的代码里 —— ComfyDialog 的构造函数是：
 *
 *   constructor(e=`div`, t=null) {
 *     super(),
 *     this.element = $el(e + `.comfy-modal`, { parent: document.body }, [...])
 *   }
 *
 * 每 new 一次就往 body 追加一个全新的 div.comfy-modal，自身完全不去重；
 * 而 `close()` 只是 `element.style.display = "none"`，节点永远留在文档里。
 * 于是点 N 次 = N 个弹窗叠着，关掉最上面那个，底下的还在。
 *
 * 这里包一层构造函数：造新窗口之前，先把场上所有遗留的 `.comfy-modal` 摘掉。
 * 放在构造函数这一层，是因为我们自己的每一个对话框（设置窗口、缺失节点弹窗）
 * 都走这条路，改一处就全治好了 —— 不必逐个调用点去补。
 */
function installDialogDedup() {
  if (!ComfyDialogClass || ComfyDialogClass.__wpsDedup) return false;
  const Original = ComfyDialogClass;
  const Wrapped = function (...args) {
    try {
      for (const stale of Array.from(document.querySelectorAll(".comfy-modal"))) {
        stale.remove?.();
      }
    } catch (error) {
      /*
       * 清理失败绝不能挡着开新窗口 —— 但也不能像以前那样"静默"：
       * 这个 catch 曾经把 `document.querySelectorAll is not a function`
       * 吞掉，导致去重看起来完全没生效。留一行 warn，下次一眼能看见。
       */
      console.warn(`[${EXTENSION_NAME}] 清理遗留弹窗失败（不影响开新窗口）`, error);
    }
    return new Original(...args);
  };
  Wrapped.prototype = Original.prototype;
  try {
    Object.setPrototypeOf(Wrapped, Original);
  } catch (error) {
    /* 拿不到静态属性也不影响 new */
  }
  Wrapped.__wpsDedup = true;
  Wrapped.__wpsOriginal = Original;
  ComfyDialogClass = Wrapped;
  return true;
}

/*
 * 设置窗口：**自己建 DOM**，不再用 ComfyUI 的 ComfyDialog。
 *
 * 【为什么换掉】
 * 用 ComfyDialog 换来的三件事全是坑，而且都是用户实机踩出来的：
 *
 *   1. 它会叠。`ComfyDialog` 的构造函数 `$el("div.comfy-modal", {parent: document.body})`
 *      每 new 一次就往 body 追加一个全新的窗口，自身不去重。用户实测点两次
 *      「⚙ 设置」就叠两个（m04407），以为是"弹开"。我给构造函数包了一层去重
 *      （`installDialogDedup()`），但那是**改别人类的行为**，只要有一条路没走到
 *      那层包装（比如 ComfyUI 前端升级换了导出、或者我们自己的 fallback 分支），
 *      叠窗就又回来了 —— 用户 m05646 说的"又出现了上面那个弹开的问题"就是它。
 *   2. 它被原生 CSS 裁。`.comfy-modal { max-height: 80vh; overflow: hidden }`，
 *      我们的设置内容比 80vh 高，于是下半截连关闭按钮一起被裁掉，还滚不动。
 *      靠加一条 `.wps-settings-modal` 覆盖去救，是"跟人家的样式抢"。
 *   3. 它不能拖宽窄。`position: fixed` + 固定 padding，尺寸完全不由我们定。
 *
 * 自己建就没有这三件事：**同一时刻世界上只可能有我们建的那一个窗口**
 * （`closeSettingsDialog()` 先拆旧的，`settingsWindow` 变量就是唯一真相），
 * 尺寸和滚动全由我们的 CSS 说了算。
 *
 * 【为什么接口要长得像 ComfyDialog】
 * `wireSettingsDialog(dialog, onChanged)` 只用到 `dialog.textElement`，
 * `closeSettingsDialog()` 只用到 `close()` 和 `element.remove()` —— 只要
 * 这三样对得上，换掉 ComfyDialog 就不必动那两处已经验证过的代码。
 */
/**
 * 自建弹窗的骨架：标题 + 可滚动正文 + 底栏（底栏里只有一个关闭按钮）。
 *
 * 设置窗口、排除清单、帮助文档三处共用这一份 —— 它们长得一样，行为
 * （点遮罩关闭、正文单独滚动、底栏常驻）也该一样。共用还顺带保证了
 * "一个窗口只有一个关闭按钮"这件事不用在三个地方各写一遍。
 */
function buildModalShell(titleText, { closeLabel = "关闭 / Close", onClose = null, wide = false } = {}) {
  const backdrop = document.createElement("div");
  backdrop.className = "wps-modal-backdrop";

  const box = document.createElement("div");
  box.className = wide ? "wps-modal wps-modal-wide" : "wps-modal";

  const title = document.createElement("div");
  title.className = "wps-modal-title";
  title.textContent = titleText;

  // 正文。滚动条长在这一层，标题和底栏因此永远留在视野里。
  const body = document.createElement("div");
  body.className = "wps-modal-body";

  const foot = document.createElement("div");
  foot.className = "wps-modal-foot";

  const close = document.createElement("button");
  close.type = "button";
  close.className = "wps-modal-close";
  close.textContent = closeLabel;
  close.onclick = () => {
    try {
      onClose?.();
    } catch (error) {
      /* 关窗失败不该再抛出去 */
    }
  };

  foot.appendChild(close);
  box.appendChild(title);
  box.appendChild(body);
  box.appendChild(foot);
  backdrop.appendChild(box);

  // 点遮罩空白处也关掉（窗口本体上的点击不冒到遮罩）
  backdrop.onclick = (event) => {
    if (event?.target !== backdrop) return;
    try {
      onClose?.();
    } catch (error) {
      /* 同上 */
    }
  };

  document.body.appendChild(backdrop);

  return {
    element: backdrop,
    box,
    textElement: body,
    foot,
    close() {
      try {
        backdrop.remove();
      } catch (error) {
        /* 已经不在文档里了 */
      }
    },
  };
}

function buildSettingsWindow() {
  const dialog = buildModalShell(`X-WIDE Preset Switch Plus  v${PLUGIN_VERSION}`, {
    onClose: () => closeSettingsDialog(),
  });
  uiLogEvent("settings+", "设置窗口挂到 body");
  return dialog;
}

async function showSettingsDialog(node) {
  const onChanged = () => {
    for (const target of getAllNodes()) {
      if (target?.type !== TARGET_NODE_NAME) continue;
      // 署名改了会影响标志区宽度，必须重建面板模型并重算节点高度
      refreshPresetWidgets(target);
      scheduleOverlaySync(target);
    }
    app.graph?.setDirtyCanvas(true, true);
  };

  try {
    /*
     * 设置窗口同一时刻只允许有一个 —— 而且这件事现在是**结构上保证**的：
     * 先把上一个拆干净，再造新的；变量 settingsWindow 就是唯一的那一个。
     * 不再依赖"包装别人的构造函数"。
     */
    closeSettingsDialog();

    installSettingsStyle();
    const dialog = buildSettingsWindow();
    settingsWindow = dialog;

    dialog.textElement.innerHTML = buildSettingsBody();
    wireSettingsDialog(dialog, onChanged);
  } catch (error) {
    console.warn(`[${EXTENSION_NAME}] settings dialog failed`, error);
  }
}

/* ------------------------------------------------------------------ *
 *  排除清单窗口
 *
 *  用户要的形态（m06692）：「你点一个地方弹出几个框，你哪几个是被排除的，
 *  然后滑块按钮，比如点亮是包含，再点一下就是排除」。
 *  所以每行一个开关：亮着的 = 参与记录，点一下 = 排除。
 * ------------------------------------------------------------------ */

let exclusionWindow = null;
let exclusionFilterText = "";
let exclusionOnlyExcluded = false;

function closeExclusionDialog() {
  const dialog = exclusionWindow;
  exclusionWindow = null;
  if (!dialog) return false;
  try {
    dialog.close();
  } catch (error) {
    /* 已经拆掉了 */
  }
  try {
    dialog.element?.remove?.();
  } catch (error) {
    /* 同上 */
  }
  return true;
}

/** 一行 = 一个节点 + 一个开关 */
function buildExclusionRow(node) {
  const id = numericNodeId(node);
  const excluded = isNodeExcluded(node);

  const row = document.createElement("div");
  row.className = excluded ? "wps-ex-row is-excluded" : "wps-ex-row";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = excluded ? "wps-ex-toggle is-off" : "wps-ex-toggle is-on";
  toggle.textContent = excluded ? "○ 排除" : "● 记录";
  toggle.title = excluded ? "点一下让它重新参与记录" : "点一下把它排除在记录之外";
  toggle.onclick = () => {
    setNodeExcluded(node, !isNodeExcluded(node));
    refreshAfterExclusionChange();
    refreshExclusionList();
  };

  const name = document.createElement("span");
  name.className = "wps-ex-name";
  name.textContent = String(node?.title || node?.type || `#${id}`);

  const type = document.createElement("span");
  type.className = "wps-ex-type";
  type.textContent = String(node?.type || "");

  const tag = document.createElement("span");
  tag.className = "wps-ex-id";
  tag.textContent = id === null ? "" : `#${id}`;

  row.appendChild(toggle);
  row.appendChild(name);
  row.appendChild(type);
  row.appendChild(tag);
  return row;
}

function refreshExclusionList() {
  const list = exclusionWindow?.element?.querySelector?.("#wps-ex-list");
  const summary = exclusionWindow?.element?.querySelector?.("#wps-ex-summary");
  if (!list) return;

  const needle = exclusionFilterText.trim().toLowerCase();
  const all = getAllNodes()
    .filter((node) => node && numericNodeId(node) !== null)
    .filter((node) => node.type !== TARGET_NODE_NAME)
    .sort((a, b) => Number(numericNodeId(a)) - Number(numericNodeId(b)));

  const excludedCount = all.filter((node) => isNodeExcluded(node)).length;

  const shown = all.filter((node) => {
    if (exclusionOnlyExcluded && !isNodeExcluded(node)) return false;
    if (!needle) return true;
    const hay = `${node.title || ""} ${node.type || ""} ${numericNodeId(node)}`.toLowerCase();
    return hay.includes(needle);
  });

  // 清空列表。用 while + firstChild 而不是 innerHTML，测试桩只实现了前者。
  while (list.firstChild) list.removeChild(list.firstChild);

  if (!shown.length) {
    const empty = document.createElement("div");
    empty.className = "wps-ex-empty";
    empty.textContent = all.length
      ? "没有匹配的节点。"
      : "画布上还没有可以被排除的节点。";
    list.appendChild(empty);
  } else {
    for (const node of shown) list.appendChild(buildExclusionRow(node));
  }

  if (summary) {
    summary.textContent = `已排除 ${excludedCount} 个 / 共 ${all.length} 个节点`;
  }
}

function showExclusionDialog() {
  try {
    closeExclusionDialog();
    installSettingsStyle();

    const dialog = buildModalShell("排除记录 / Excluded from recording", {
      closeLabel: "关闭 / Close",
      onClose: () => closeExclusionDialog(),
      wide: true,
    });
    exclusionWindow = dialog;

    const head = document.createElement("div");
    head.className = "wps-ex-head";

    const search = document.createElement("input");
    search.type = "text";
    search.id = "wps-ex-search";
    search.className = "wps-ex-search";
    search.placeholder = "搜索节点名 / 类型 / 编号…";
    search.value = exclusionFilterText;
    search.oninput = () => {
      exclusionFilterText = String(search.value || "");
      refreshExclusionList();
    };

    const only = document.createElement("label");
    only.className = "wps-ex-only";
    const onlyBox = document.createElement("input");
    onlyBox.type = "checkbox";
    onlyBox.id = "wps-ex-only";
    onlyBox.checked = exclusionOnlyExcluded;
    onlyBox.onchange = () => {
      exclusionOnlyExcluded = Boolean(onlyBox.checked);
      refreshExclusionList();
    };
    only.appendChild(onlyBox);
    only.appendChild(document.createTextNode(" 只看被排除的"));

    const clear = document.createElement("button");
    clear.type = "button";
    clear.id = "wps-ex-clear";
    clear.className = "wps-ex-clear";
    clear.textContent = "全部恢复记录";
    clear.onclick = () => {
      const removed = clearExclusions();
      if (removed) {
        refreshAfterExclusionChange();
        refreshExclusionList();
      }
      console.log(`[${EXTENSION_NAME}] 排除了的 ${removed} 个节点已全部恢复记录`);
    };

    head.appendChild(search);
    head.appendChild(only);
    head.appendChild(clear);

    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent =
      "亮着 = 参与记录；点一下 = 排除。被排除的节点不记录、切预设时不改写、" +
      "也不会被「未记录节点策略」旁路掉。名单对整个工作流的所有预设生效。";

    const summary = document.createElement("div");
    summary.id = "wps-ex-summary";
    summary.className = "wps-ex-summary";

    const list = document.createElement("div");
    list.id = "wps-ex-list";
    list.className = "wps-ex-list";

    dialog.textElement.appendChild(hint);
    dialog.textElement.appendChild(head);
    dialog.textElement.appendChild(summary);
    dialog.textElement.appendChild(list);

    refreshExclusionList();
    uiLogEvent("exclude+", "排除清单窗口");
  } catch (error) {
    console.warn(`[${EXTENSION_NAME}] exclusion dialog failed`, error);
  }
}

/* ------------------------------------------------------------------ *
 *  帮助文档窗口
 *
 *  用户要求（m06692）：「给他一个单独可以打开窗口，里面有更详细的帮助文档，
 *  类似于markdown文件」「在设置里面给他一个地方，可以打开看」。
 *
 *  文档本体是 web/help.html —— 它跟插件一起被打包（__init__.py 里
 *  WEB_DIRECTORY = "./web"），由 ComfyUI 直接以静态文件提供。
 *  用 iframe 而不是往当前页面塞 HTML：文档的样式跟 ComfyUI 的全局样式
 *  彻底隔离，再怎么改设置窗口的 CSS 也不会把文档弄花。
 * ------------------------------------------------------------------ */

let helpWindow = null;

function closeHelpDialog() {
  const dialog = helpWindow;
  helpWindow = null;
  if (!dialog) return false;
  try {
    dialog.close();
  } catch (error) {
    /* 已经拆掉了 */
  }
  try {
    dialog.element?.remove?.();
  } catch (error) {
    /* 同上 */
  }
  return true;
}

function helpDocUrl() {
  return pluginAssetUrl("help.html");
}

function showHelpDialog() {
  try {
    closeHelpDialog();
    installSettingsStyle();

    const dialog = buildModalShell("帮助文档 / Help", {
      closeLabel: "关闭 / Close",
      onClose: () => closeHelpDialog(),
      wide: true,
    });
    helpWindow = dialog;

    // 文档自己撑满正文区；外链按钮放在底栏，跟着常驻
    dialog.textElement.classList.add("wps-help-host");

    const frame = document.createElement("iframe");
    frame.className = "wps-help-frame";
    frame.setAttribute("title", "帮助文档 / Help");
    frame.src = helpDocUrl();
    dialog.textElement.appendChild(frame);

    const link = document.createElement("a");
    link.className = "wps-help-open";
    link.href = helpDocUrl();
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "在新标签页打开 / Open in a new tab ↗";
    dialog.foot.insertBefore(link, dialog.foot.firstChild);

    uiLogEvent("help+", "帮助文档窗口");
  } catch (error) {
    console.warn(`[${EXTENSION_NAME}] help dialog failed`, error);
  }
}

/* ------------------------------------------------------------------ *
 *  快捷键监听
 * ------------------------------------------------------------------ */

let hotkeyHandler = null;
let jumpHotkeyHandler = null;

function isTypingTarget(target) {
  if (!target) return false;
  const tag = String(target.tagName || "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return !!target.isContentEditable;
}

function installHotkey() {
  if (hotkeyHandler) {
    globalThis.removeEventListener?.("keydown", hotkeyHandler, true);
    hotkeyHandler = null;
  }

  if (!config.hotkey) return;

  hotkeyHandler = (event) => {
    // 正在输入框里打字时不抢键
    if (isTypingTarget(event.target)) return;

    const { combo } = normalizeKeyEvent(event);
    if (combo !== config.hotkey) return;

    event.preventDefault();
    event.stopPropagation();
    runHotkeyAction();
  };

  globalThis.addEventListener?.("keydown", hotkeyHandler, true);
}

/*
 * 跳转快捷键单独一个监听器。
 *
 * 为什么不并进上面那个：两个键要做的事不同，而且**用户可以把其中一个清空**
 * （config.hotkey 清空时 installHotkey 会直接 return）。合在一起写就得在
 * 函数体里到处判断"这一半是否启用"，还可能因为 return 的位置让另一个键失效。
 * 分开之后各自独立：清掉主键不影响跳转键，反之亦然。
 */
function installJumpHotkey() {
  if (jumpHotkeyHandler) {
    globalThis.removeEventListener?.("keydown", jumpHotkeyHandler, true);
    jumpHotkeyHandler = null;
  }

  /*
   * 在这里就挂上鼠标跟踪，不是等到第一次按键。
   *
   * 如果拖到按键那一刻才绑，第一次按的时候 `lastCanvasPointer` 还是 null，
   * 于是第一次永远是"居中"——用户会以为搬动功能根本没好。
   */
  trackCanvasPointer();

  if (!config.jumpHotkey) return;

  jumpHotkeyHandler = (event) => {
    if (isTypingTarget(event.target)) return;

    const { combo } = normalizeKeyEvent(event);
    if (combo !== config.jumpHotkey) return;

    event.preventDefault();
    event.stopPropagation();
    jumpToPresetNode();
  };

  globalThis.addEventListener?.("keydown", jumpHotkeyHandler, true);
}

/** 快捷键的总开关：在鼠标位置弹出/收起面板 */
/**
 * 切换清爽模式：隐藏整条工具栏，只留预设列表。
 * 面板右上角的开关按钮和快捷键走的都是这里。
 */
function toggleCompactMode(node) {
  const store = ensureStore();
  if (!store) return false;

  store.options.hideCrudButtons = !store.options.hideCrudButtons;
  applyCrudVisibility(node);
  refreshPresetWidgets(node);
  relayoutNode(node);
  app.graph?.setDirtyCanvas(true, true);

  console.log(
    `[${EXTENSION_NAME}] ${store.options.hideCrudButtons ? "已进入清爽模式（只留预设列表）" : "已退出清爽模式"}`
  );
  return true;
}

/**
 * 一个节点能不能算出数字 id。
 *
 * 单独写出来是因为 `Number(null)` 是 0、`Number("")` 也是 0，都"有限"，
 * 直接拿 `Number.isFinite(Number(x))` 判会把没有 id 的节点当成 id=0，
 * 于是它永远排在最前面、抢走"主节点"的位置。
 */
function numericNodeId(node) {
  const raw = node?.id;
  if (raw === null || raw === undefined || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * 本工作流**唯一在用的**那个 Preset Switch 节点。
 *
 * 【为什么要挑一个而不是用"列表里的第一个"】
 * `getAllNodes()` 返回的是 `graph._nodes`，而 litegraph 的"置顶"操作
 * （点一下节点就会 bringToFront）会把节点在数组里挪位置 —— 用"第一个"
 * 当主节点，用户点一下另一个节点，主节点就换人了，面板和按钮会跟着搬家。
 *
 * 【为什么按 id 最小】
 * 节点 id 是只增不减的，先放下的那个 id 一定更小，而且删掉别的节点、
 * 拖动、置顶都不会改变它 —— 这是画布上唯一稳定的"谁先来"。
 *
 * `extra` 用来把"还没进 graph 的节点"也算进来：ComfyUI 是先调
 * `onNodeCreated()`、再 `graph.add(node)`，在 onNodeCreated 里看 graph
 * 是看不到自己的。
 */
function primaryPresetNode(extra = null) {
  const pool = allPresetNodes().filter(Boolean);
  if (extra && extra.type === TARGET_NODE_NAME && !pool.includes(extra)) {
    pool.push(extra);
  }
  if (!pool.length) return null;

  const numbered = pool.filter((n) => numericNodeId(n) !== null);
  const list = numbered.length ? numbered : pool;

  let best = list[0];
  for (const n of list) {
    if (numericNodeId(n) !== null && numericNodeId(best) !== null) {
      if (numericNodeId(n) < numericNodeId(best)) best = n;
    }
  }
  return best;
}

function firstPresetNode() {
  // 全插件只有这一个"当前在用的节点"概念，全部走 primaryPresetNode。
  return primaryPresetNode();
}

/** 所有 Preset Switch 节点（只有"找出多余节点"这一个用途了） */
function allPresetNodes() {
  return getAllNodes().filter((n) => n?.type === TARGET_NODE_NAME);
}

/*
 * 跳转后高亮的时长。
 *
 * 900ms 是"够看见、又不碍事"的长度：短于 600ms 容易被当成没反应，
 * 长于 1.5s 会一直挂在那儿，反倒像是选中状态没退掉。
 */
const JUMP_HIGHLIGHT_MS = 900;

/** 某个节点当前是否该画跳转高亮 */
function jumpHighlightAlpha(node) {
  const at = Number(node?.__wpsJumpAt);
  if (!Number.isFinite(at)) return 0;
  const elapsed = Date.now() - at;
  if (elapsed < 0 || elapsed > JUMP_HIGHLIGHT_MS) return 0;
  // 线性淡出；起点不设 1，留一点透明免得盖住节点边框
  return 2.5 * (1 - elapsed / JUMP_HIGHLIGHT_MS) * 0.4;
}

/**
 * 把画面移到 Preset Switch 节点上，或者把它搬到鼠标底下。
 *
 * 【用户 m05344 的原话】
 * 「ALT+Z 的意思理解错了，不是快速对齐到这个节点，而是在你鼠标放的位置上
 *   打开这个页面，或者说把它挪到这个地方直接用」
 *
 * 所以他要么想在鼠标处**开一个浮层面板**，要么想把**节点本身**挪过去。
 * 这里实现的是后者，理由是前者试过并且整体失败：
 * v0.10.0 之前用 HTML 浮层（`ctx.canvas` + `getBoundingClientRect`）在真实
 * ComfyUI 里三次失效 —— 偏移约 104px、跑到画面左上角、整层不可见。
 * 原因是 `addCustomWidget` 的绘制原点在那个控件自己的画布元素上，而
 * `mouse(event, pos)` 的 `pos` 来自 `offsetX/offsetY`，两者坐标系不同源。
 * 搬节点只是往 `node.pos` 写两个数，不碰绘制链路，没有这类风险。
 *
 * 【为什么需要"新鲜度"判断】
 * `canvas.graph_mouse` 在构造时就初始化成 `[0, 0]`，鼠标从未进过画布时它
 * 也是"有限数"，照着搬会把节点直接扔到图的原点去。所以自己挂一个
 * `pointermove` 记下最后一次在画布上的图坐标与时刻，太旧就退回居中。
 */
const POINTER_FRESH_MS = 4000;

let lastCanvasPointer = null;
let pointerTrackerBound = null;

/** 记录"鼠标最后一次在画布上的图坐标"。绑在画布元素上，只绑一次。 */
function trackCanvasPointer() {
  const el = canvasElement();
  if (!el || pointerTrackerBound === el) return;
  pointerTrackerBound = el;
  const onMove = (event) => {
    const canvas = app?.canvas;
    let xy = null;
    try {
      // 用 litegraph 自己的换算，不手算 ds.offset/scale ——
      // 手算在缩放不是 1 或者高分屏上必然错位。
      if (typeof canvas?.convertEventToCanvasOffset === "function") {
        xy = canvas.convertEventToCanvasOffset(event);
      }
    } catch (error) {
      xy = null;
    }
    if (!Array.isArray(xy) || !Number.isFinite(xy[0]) || !Number.isFinite(xy[1])) {
      xy = Array.isArray(canvas?.graph_mouse) ? canvas.graph_mouse : null;
    }
    if (!Array.isArray(xy) || !Number.isFinite(xy[0]) || !Number.isFinite(xy[1])) return;
    lastCanvasPointer = { x: xy[0], y: xy[1], at: Date.now() };
  };
  try {
    el.addEventListener("pointermove", onMove, { passive: true });
    el.addEventListener("mousemove", onMove, { passive: true });
  } catch (error) {
    console.warn(`[${EXTENSION_NAME}] 鼠标位置跟踪没挂上，Alt+Z 会退回居中`, error);
  }
}

/** 画布那个 <canvas> 元素（不是容器 div）。 */
function canvasElement() {
  try {
    return app?.canvas?.canvas || document.querySelector("#graph-canvas") || null;
  } catch (error) {
    return null;
  }
}

/**
 * 当前视口在"图坐标"里覆盖的矩形；拿不到就返回 null。
 *
 * 与 `viewportCenter()` 同一套换算，只是这里要的是宽高而不是中心点。
 */
function viewportRect() {
  try {
    const canvas = app?.canvas;
    const ds = canvas?.ds;
    const el = canvas?.canvas;
    if (!ds || !el) return null;
    const scale = Number(ds.scale) || 1;
    const dpr = Number(globalThis?.devicePixelRatio) || 1;
    const width = (Number(el.width) || 0) / (scale * dpr);
    const height = (Number(el.height) || 0) / (scale * dpr);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    return { left: -ds.offset[0], top: -ds.offset[1], width, height };
  } catch (error) {
    return null;
  }
}

/**
 * 把节点搬到鼠标底下，顺便夹进可视范围。
 *
 * 夹取是为了"能在鼠标处直接用"：不夹的话，鼠标靠近画布右边或下边时
 * 节点会有一半留在屏幕外，看起来就像又出 bug 了。
 * 节点比可视区还大时**不夹**（那会把左上角推到负数、反而更糟）。
 */
function moveNodeToPointer(node, pointer) {
  const size = Array.isArray(node?.size) ? node.size : [480, 200];
  const nodeW = Number(size[0]) || 480;
  const nodeH = Number(size[1]) || 200;

  let x = Number(pointer.x);
  let y = Number(pointer.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;

  const view = viewportRect();
  if (view && view.width > nodeW + 16 && view.height > nodeH + 16) {
    const margin = 8;
    x = Math.min(Math.max(x, view.left + margin), view.left + view.width - nodeW - margin);
    y = Math.min(Math.max(y, view.top + margin), view.top + view.height - nodeH - margin);
  }

  try {
    node.pos = [x, y];
  } catch (error) {
    console.warn(`[${EXTENSION_NAME}] 搬动节点失败`, error);
    return false;
  }
  return true;
}

function jumpToPresetNode() {
  /*
   * 只认主节点。
   *
   * 以前是"在所有 Preset Switch 节点里挑离视口中心最近的那个"——那套逻辑
   * 是给多节点同步时代写的。现在全工作流只有一个节点在干活，多余的那些
   * 已经退休、连面板都被摘掉了，把画面搬到一个退休节点上毫无意义。
   */
  const target = primaryPresetNode();
  if (!target) {
    console.warn(`[${EXTENSION_NAME}] 当前工作流里没有 Preset Switch 节点，跳转快捷键无效`);
    return false;
  }

  const canvas = app?.canvas;
  if (!canvas) {
    console.warn(`[${EXTENSION_NAME}] 拿不到画布，无法跳转`);
    return false;
  }

  trackCanvasPointer();

  /*
   * 鼠标刚在画布上出现过 → 搬过去；否则退回居中。
   *
   * 退回这一支是必需的：鼠标停在侧边栏、对话框或者画布之外时，
   * 记下的坐标是旧的，照着搬会跑到用户没在看的地方。
   */
  const fresh =
    lastCanvasPointer && Date.now() - Number(lastCanvasPointer.at) <= POINTER_FRESH_MS;
  let moved = false;
  if (fresh) moved = moveNodeToPointer(target, lastCanvasPointer);

  if (!moved) {
    if (typeof canvas.centerOnNode !== "function") {
      console.warn(`[${EXTENSION_NAME}] 画布不支持 centerOnNode，也无法搬运节点`);
      return false;
    }
    try {
      canvas.centerOnNode(target);
    } catch (error) {
      console.warn(`[${EXTENSION_NAME}] centerOnNode 失败`, error);
      return false;
    }
  }

  // 选中它：用户接着多半就是要操作它，顺手选中省一次点击。
  // 用 `selectNodes` 而不是直接写 selected_nodes —— 后者得自己维护
  // canvas.current_node 和选中框，漏一步就是"看着选中了其实没选中"。
  try {
    const graph = getGraph();
    if (graph && typeof graph.selectNodes === "function") graph.selectNodes([target], false);
    else if (canvas) canvas.selectNodes?.([target], false);
  } catch (error) {
    /* 选中失败不影响跳转本身，别因此中断 */
  }

  target.__wpsJumpAt = Date.now();
  app.graph?.setDirtyCanvas(true, true);

  console.log(
    `[${EXTENSION_NAME}] ${moved ? "已把" : "已移到"} Preset Switch 节点 #${target.id ?? "?"} ` +
      `${moved ? "搬到鼠标处" : "（鼠标不在画布上，退回居中）"}`
  );
  return true;
}

/** 当前视口中心在"图坐标"里的位置；拿不到就退到 0,0（等于只比节点之间的距离） */
function viewportCenter() {
  try {
    const canvas = app?.canvas;
    const ds = canvas?.ds;
    const el = canvas?.canvas;
    if (!ds || !el) return [0, 0];
    const scale = Number(ds.scale) || 1;
    const dpr = Number(globalThis?.devicePixelRatio) || 1;
    const w = Number(el.width) || 0;
    const h = Number(el.height) || 0;
    // 与 LGraphCanvas.centerOnNode 同一套换算，反过来解出视口中心的图坐标
    return [-ds.offset[0] + w / 2 / (scale * dpr), -ds.offset[1] + h / 2 / (scale * dpr)];
  } catch (error) {
    return [0, 0];
  }
}

/** 把整个面板收起来，节点只剩标题栏（备用动作，默认不绑快捷键） */
function togglePanelCollapsed() {
  const node = firstPresetNode();
  if (!node) return false;

  const willHide = !node.__wpsPanelHidden;
  node.__wpsPanelHidden = willHide;

  if (willHide) {
    for (const [key, btn] of overlay.buttons) {
      if (key.startsWith(`${node.id ?? "?"}::`)) btn.style.display = "none";
    }
  } else {
    scheduleOverlaySync(node);
  }

  relayoutNode(node);
  console.log(
    `[${EXTENSION_NAME}] 面板${willHide ? "已收起（只留标题栏）" : "已展开"}`
  );
  return true;
}

/** 快捷键触发的动作：默认切清爽模式 */
function runHotkeyAction() {
  const node = firstPresetNode();
  if (!node) {
    console.warn(`[${EXTENSION_NAME}] 当前工作流里没有 Preset Switch 节点，快捷键无效`);
    return;
  }

  if (config.hotkeyAction === "collapse") {
    togglePanelCollapsed();
  } else {
    toggleCompactMode(node);
  }
}

/* ------------------------------------------------------------------ *
 *  面板绘制
 * ------------------------------------------------------------------ */

function buildPanelModel(node) {
  const activeKey = currentKeyOfNode(node);
  const activeRoot = rootKeyOf(activeKey);
  const hideCrud = !!ensureStore()?.options?.hideCrudButtons;

  const rows = [];
  let index = 0;

  for (const rootKey of listRootKeys()) {
    const children = listChildKeys(rootKey);
    const isActiveRoot = rootKey === activeRoot;
    // 展开状态按"每一条预设各自记"，不是只有当前生效的那条才展开。
    // 否则点「新增预设」之后，之前展开的子模式会整片消失，看着像"全被关掉了"。
    const isExpanded = !!(node.__wpsExpanded || {})[rootKey];

    rows.push({
      kind: "preset",
      key: rootKey,
      label: getPresetName(rootKey),
      selected: rootKey === activeKey,
      activeRoot: isActiveRoot,
      hasChildren: children.length > 0,
      expanded: isExpanded,
      state: computePresetState(rootKey),
      missing: Array.isArray(ensureStore()?.presets?.[rootKey]?.missing_nodes)
        ? ensureStore().presets[rootKey].missing_nodes.length
        : 0,
      band: index % 2 === 0,
    });
    index += 1;

    if (isExpanded) {
      for (const childKey of children) {
        rows.push({
          kind: "preset",
          key: childKey,
          label: getPresetName(childKey),
          selected: childKey === activeKey,
          activeRoot: false,
          hasChildren: false,
          expanded: false,
          state: computePresetState(childKey),
          missing: Array.isArray(ensureStore()?.presets?.[childKey]?.missing_nodes)
            ? ensureStore().presets[childKey].missing_nodes.length
            : 0,
          child: true,
          band: index % 2 === 0,
        });
        index += 1;
      }
    }
  }

  // 面板右上角的小开关 + 分隔线
  rows.push({ kind: "divider" });
  rows.push({
    kind: "header",
    activeKey,
    hideCrud,
    state: computePresetState(activeKey),
    activeMissing: Array.isArray(ensureStore()?.presets?.[activeKey]?.missing_nodes)
      ? ensureStore().presets[activeKey].missing_nodes.length
      : 0,
  });

  // 清爽模式开关：圆形按钮，放在整条列表的下方、原生按钮的上方。
  // 表头那条不再放它 —— 位置太靠上不好点，也把状态文字挤窄了。
  rows.push({
    kind: "toolbar",
    hideCrud,
    hotkey: config.hotkey,
  });

  return rows;
}

function buildPanelSignature(node, rows) {
  const parts = rows.map((row) => {
    if (row.kind === "preset") {
      return `${row.key}|${row.label}|${row.selected ? 1 : 0}|${row.hasChildren ? 1 : 0}` +
        `|${row.expanded ? 1 : 0}|${row.missing}|${row.child ? 1 : 0}|${row.state}`;
    }
    if (row.kind === "header") {
      return `H|${row.activeKey}|${row.hideCrud ? 1 : 0}|${row.activeMissing}` +
        `|${row.state}`;
    }
    if (row.kind === "toolbar") {
      return `T|${row.hideCrud ? 1 : 0}|${row.hotkey || ""}`;
    }
    return "D";
  });
  return parts.join("::");
}

function panelRowHeight(row) {
  if (row.kind === "divider") return DIVIDER_HEIGHT;
  if (row.kind === "header") return HEADER_HEIGHT;
  if (row.kind === "toolbar") return TOOLBAR_HEIGHT;
  return ROW_HEIGHT;
}

function panelHeightOf(rows) {
  let h = PANEL_PADDING * 2;
  for (const row of rows) h += panelRowHeight(row);
  return h;
}

function drawPanel(ctx, node, widgetWidth, y, rows) {
  node.__wpsLastPanelDrawY = y;

  const x = 10;
  const width = Math.max(180, widgetWidth - 20);
  const hideCrud = !!ensureStore()?.options?.hideCrudButtons;

  const listHeight = panelHeightOf(rows);
  const totalHeight = listHeight;

  // 真实绘制时的事实，体检报告要用 —— 这些值只有在真机上才拿得到
  node.__wpsLastDrawFacts = {
    widgetWidth,
    panelWidth: width,
    drawY: y,
    panelHeight: totalHeight,
    nodeSize: Array.isArray(node.size) ? [...node.size] : node.size,
    widgetCount: node.widgets?.length,
    hideCrud,
    at: Date.now(),
  };

  // 画布的当前变换矩阵：`drawY` 到底是节点内坐标还是已经带了平移，
  // 光看代码分不清（两种写法都能自圆其说）。这里直接把矩阵记下来，
  // 配合"控件自己的 y"就能判定面板内容有没有整体偏移。
  try {
    const tm = ctx.getTransform ? ctx.getTransform() : null;
    if (tm) {
      node.__wpsLastDrawFacts.transform = {
        a: +tm.a.toFixed(4),
        d: +tm.d.toFixed(4),
        e: +tm.e.toFixed(2),
        f: +tm.f.toFixed(2),
      };
      const cvs = ctx.canvas;
      const el = nodeWidgetCanvasEl || cvs;
      node.__wpsLastDrawFacts.canvas = cvs ? { w: cvs.width, h: cvs.height } : null;
      node.__wpsLastDrawFacts.canvasElem = el
        ? { w: Math.round(el.clientWidth || 0), h: Math.round(el.clientHeight || 0) }
        : null;
      // 面板左上角（本地坐标 y）落在画布上的真实像素位置：
      // 两者差得多，就说明面板内容相对控件框整体偏了。
      node.__wpsLastDrawFacts.canvasPixelOfPanelTop = tm.f + y * tm.d;
    }
  } catch (error) {
    node.__wpsLastDrawFacts.transform = `（读不到：${String(error)}）`;
  }

  const dotCx = x + width - 20;

  ctx.save();

  ctx.beginPath();
  ctx.rect(x - 4, y - 4, width + 8, totalHeight + 8);
  ctx.clip();

  // 外框
  ctx.fillStyle = "#1e1e1e";
  ctx.strokeStyle = "#3a3a3a";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x, y, width, totalHeight, 6);
  ctx.fill();
  ctx.stroke();

  const dragState = node.__wpsPanelDragState || null;

  // 几何统一从 panelGeomOf 取（同一份数据也供命中使用），这里只做绘制
  const geom = panelGeomOf(node, y);

  let cy = y + PANEL_PADDING;

  for (const row of rows) {
    const h = panelRowHeight(row);
    const rowY = cy;
    cy += h;

    if (row.kind === "divider") {
      ctx.strokeStyle = "#3a3a3a";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 8, rowY + Math.floor(h / 2) + 0.5);
      ctx.lineTo(x + width - 8, rowY + Math.floor(h / 2) + 0.5);
      ctx.stroke();
      continue;
    }

    if (row.kind === "header") {
      ctx.font = "11px Arial";
      ctx.textBaseline = "alphabetic";

      // 左侧：状态点 + 状态文字（未记录 / 待记录 / 已记录）
      const sc = STATE_COLORS[row.state] || STATE_COLORS[STATE_UNRECORDED];
      const statusDotX = x + 14;

      ctx.beginPath();
      ctx.arc(statusDotX, rowY + h / 2, 4, 0, Math.PI * 2);
      ctx.fillStyle = sc.dot;
      ctx.fill();

      ctx.font = "12px Arial";
      ctx.fillStyle = sc.text;
      const stateLabel = `${sc.label} · 当前 ${row.activeKey}`;
      ctx.fillText(stateLabel, statusDotX + 10, rowY + h * 0.66);
      const stateTextW = ctx.measureText(stateLabel).width;

      // 右侧：版本号（清爽切换按钮已移到下方工具栏，这里空间留给状态文字）
      ctx.font = "9px Arial";
      const versionLabel = `v${PLUGIN_VERSION}`;
      const versionW = ctx.measureText(versionLabel).width;
      const versionRight = x + width - 8;
      if (versionRight - versionW - (statusDotX + 10 + stateTextW) > 12) {
        ctx.fillStyle = "#5f656d";
        ctx.fillText(versionLabel, versionRight - versionW, rowY + h * 0.62);
      }
      continue;
    }

    /*
     * 只画真正的预设行。
     *
     * 这里必须显式挡一道：`divider` 行没有 `key`/`label`，一旦漏下来，
     * 下面 `String(row.key)` 会得到字符串 "undefined"，
     * 于是"序号"和"名字"两段都画出 `undefined` 八个字母 ——
     * 而且正好落在底部圆形开关上面一行，看起来就是"多出来一块、字叠在一起"。
     */
    if (row.kind !== "preset") continue;

    // 普通预设行
    const isDraggingRow = !!dragState?.active && row.key === dragState.fromKey;
    const isDropTarget = !!dragState?.active && row.key === dragState.overKey;

    if (row.selected) {
      ctx.fillStyle = "#9aa0a8";
      ctx.fillRect(x + 6, rowY + 2, width - 12, h - 4);
    } else if (isDraggingRow) {
      ctx.fillStyle = "#3a4350";
      ctx.fillRect(x + 6, rowY + 2, width - 12, h - 4);
    } else if (row.band) {
      ctx.fillStyle = "#232323";
      ctx.fillRect(x + 6, rowY + 2, width - 12, h - 4);
    }

    if (isDropTarget && dragState.fromKey !== dragState.overKey) {
      ctx.strokeStyle = "#79a9ff";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x + 6, rowY + 2, width - 12, h - 4);
    }

    // 展开箭头（只给有子模式的父模式）
    if (row.hasChildren) {
      ctx.fillStyle = row.selected ? "#111111" : "#c9ced4";
      ctx.font = "11px Arial";
      ctx.fillText(row.expanded ? "▼" : "▶", x + 11, rowY + h * 0.68);
    }

    // 行文字：行首保留序号（0 / 0.1 / 1 …），便于和 preset_index 对照
    ctx.font = "13px Arial";
    if (row.selected) {
      ctx.fillStyle = "#111111";
    } else if (isDraggingRow) {
      ctx.fillStyle = "#e9edf5";
    } else if (row.child) {
      ctx.fillStyle = "#c3c8ce";
    } else {
      ctx.fillStyle = "#dfdfdf";
    }

    const prefix = row.child ? "└ " : "";
    const textX = row.hasChildren ? x + 26 : row.child ? x + 20 : x + 12;

    // 序号单独一段：等宽字体，颜色比名字淡一档
    const indexLabel = String(row.key);
    ctx.font = "bold 13px Consolas, monospace";
    const indexWidth = ctx.measureText(indexLabel).width;
    const indexColor = row.selected ? "#333333" : row.child ? "#8f959c" : "#a8aeb5";
    const nameX = textX + indexWidth + 8;

    // 行尾右侧：状态点在最右；有缺失节点时，缺失标记在它左边
    const hasMissing = row.missing > 0;
    const statusDotX = x + width - 20;
    const missingX = x + width - 46;
    // 文字右边界只看**画出来**的圆，不看点击区 —— 点击区是可以比圆大一圈的，
    // 但文字不该为它让位置（DOT_HIT 一放大，名字就被白白截短一截）
    const rightEdge = hasMissing ? missingX - DOT_RADIUS - 4 : statusDotX - 10;
    const available = rightEdge - nameX;

    ctx.font = "13px Arial";
    let text = `${prefix}${row.label}`;
    if (ctx.measureText(text).width > available) {
      let cut = text;
      while (cut.length > 1 && ctx.measureText(`${cut}…`).width > available) {
        cut = cut.slice(0, -1);
      }
      text = `${cut}…`;
    }

    // 空间够就"序号 + 名字"两段画，太窄则退回只画名字
    if (available > 24) {
      ctx.font = "bold 13px Consolas, monospace";
      ctx.fillStyle = indexColor;
      ctx.fillText(indexLabel, textX, rowY + h * 0.68);

      ctx.font = "13px Arial";
      if (row.selected) {
        ctx.fillStyle = "#111111";
      } else if (isDraggingRow) {
        ctx.fillStyle = "#e9edf5";
      } else if (row.child) {
        ctx.fillStyle = "#c3c8ce";
      } else {
        ctx.fillStyle = "#dfdfdf";
      }
      ctx.fillText(text, nameX, rowY + h * 0.68);
    } else {
      ctx.fillText(text, textX, rowY + h * 0.68);
    }

    // 状态点：暗红=未记录 / 黄=待记录 / 绿=已记录
    const sc = STATE_COLORS[row.state] || STATE_COLORS[STATE_UNRECORDED];
    ctx.beginPath();
    ctx.arc(statusDotX, rowY + h / 2, 4, 0, Math.PI * 2);
    // 选中行也保持状态本色（之前被改成灰色，看起来像"没有状态"）
    ctx.fillStyle = sc.dot;
    ctx.fill();

    // 缺失节点标记：暗红点 + 感叹号，点它打开"缺了什么"的窗口
    if (hasMissing) {
      ctx.beginPath();
      ctx.arc(missingX, rowY + h / 2, DOT_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = "#b3352f";
      ctx.fill();
      ctx.strokeStyle = "#ff8a80";
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = "#ffe3e0";
      ctx.font = "bold 11px Arial";
      // 有多个缺失时显示数量，比单纯感叹号信息量大
      const markLabel = row.missing > 1 ? String(row.missing) : "!";
      ctx.fillText(markLabel, missingX - (markLabel.length > 1 ? 5 : 2), rowY + h * 0.63);
    }
  }

  // 底部那条：圆形清爽 / 完整模式开关（表头不再放，位置太高不好点）
  if (geom.toolbar) {
    const tr = geom.toolbar;
    const on = !!hideCrud; // true = 当前是清爽模式
    const rowIsLast = rows.length > 0 && rows[rows.length - 1].kind === "toolbar";
    if (rowIsLast) {
      ctx.strokeStyle = "#3a3a3a";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 8, tr.y + 0.5);
      ctx.lineTo(x + width - 8, tr.y + 0.5);
      ctx.stroke();
    }

    // 圆：清爽=实心绿，完整=空心灰
    ctx.beginPath();
    ctx.arc(tr.cx, tr.cy, tr.r, 0, Math.PI * 2);
    ctx.fillStyle = on ? "#3f6f4a" : "#2f3339";
    ctx.fill();
    ctx.strokeStyle = on ? "#7fd396" : "#5a6068";
    ctx.lineWidth = on ? 2 : 1.5;
    ctx.stroke();

    // 圆里画状态符号：清爽模式一个"▣"，完整模式一个"⤢"
    ctx.fillStyle = on ? "#e8f5ec" : "#c3c8ce";
    ctx.font = "bold 12px Arial";
    ctx.textAlign = "center";
    ctx.fillText(on ? "▣" : "⤢", tr.cx, tr.cy + 4);
    ctx.textAlign = "left";

    // 圆右边：说明文字 + 快捷键提示。
    // 文字一律经过"放得下才画"的判断，否则窄节点上会盖到圆上（以前就是这样）。
    // 画字前把对齐和字体都显式设一遍：这里是复用外部传进来的 ctx，
    // 不能假设上一段绘制留下的状态（曾经因此画出一团重叠的字）。
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    const labelX = tr.cx + tr.r + 12;
    const textRight = x + width - 10;
    const keyLabel = hotkeyLabel(config.hotkey);

    // 先量快捷键提示，量完再决定说明文字能用多少宽度
    let keyW = 0;
    if (keyLabel) {
      ctx.font = "10px Consolas, monospace";
      keyW = ctx.measureText(keyLabel).width;
    }

    ctx.font = "12px Arial";
    const compactLabel = on ? "清爽模式 · 点它展开工具栏" : "完整模式 · 点它收起工具栏";
    let labelW = ctx.measureText(compactLabel).width;
    const labelBudget = textRight - labelX - (keyW ? keyW + 10 : 0);

    // 把这一段真正画了什么记下来：实机上"文字糊成一团"时，
    // 光看截图分不清是字号、对齐、还是画了两遍 —— 这里留铁证。
    const tint = {
      labelX,
      textRight,
      labelBudget,
      keyW,
      labelW,
      chosen: null,
      drawn: [],
    };

    // 文字的"禁区"：左边不能让给圆（圆占 x..labelX），右边不能出面板，
    // 上下各留 4px 不越过这一行。越界的一律裁掉。
    const textClip = {
      x: labelX - 4,
      y: tr.y + 3,
      w: Math.max(0, textRight - labelX + 4),
      h: Math.max(1, tr.h - 6),
    };
    const tintDraw = (text, font, align, fill, tx, ty) => {
      // 每一笔都关在自己的矩形里。以前只靠"量出来的宽度够不够"来判断，
      // 只要有一处量错（字体没生效、变换不是 1:1、系统缺字回退字形变宽），
      // 文字就会越界盖到圆上，实机看到的就是"两个字叠在一起"。
      // 裁一下子，越界部分直接不画 —— 这是最后一道保险。
      ctx.save();
      ctx.beginPath();
      ctx.rect(textClip.x, textClip.y, textClip.w, textClip.h);
      ctx.clip();
      ctx.font = font;
      ctx.textAlign = align;
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = fill;
      ctx.fillText(text, tx, ty);
      ctx.restore();
      tint.drawn.push({ text, font, align, x: Math.round(tx), y: Math.round(ty) });
    };
    node.__wpsLastToolbarText = tint;

    if (labelW <= labelBudget) {
      tint.chosen = "full";
      tintDraw(compactLabel, "12px Arial", "left", on ? "#9fdcae" : "#c3c8ce", labelX, tr.cy + 4);
    } else {
      // 放不下完整说明就退到短文案；再放不下就只留圆本身
      const shortLabel = on ? "清爽模式" : "完整模式";
      labelW = ctx.measureText(shortLabel).width;
      if (labelW <= labelBudget) {
        tint.chosen = "short";
        tintDraw(shortLabel, "12px Arial", "left", on ? "#9fdcae" : "#c3c8ce", labelX, tr.cy + 4);
      } else {
        tint.chosen = "none";
      }
    }

    if (keyLabel && labelW > 0) {
      const keyX = labelX + labelW + 10;
      if (keyX + keyW <= textRight) {
        tintDraw(keyLabel, "10px Consolas, monospace", "left", "#5f656d", keyX, tr.cy + 4);
      }
    }

    // 交还给外部绘制前恢复成默认值
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
  }

  // 把这份布局信息交给浮层同步使用（画布坐标，未经变换）
  node.__wpsPanelLayout = {
    panelTop: y,
    panelHeight: totalHeight,
    listHeight,
    panelX: x,
    panelWidth: width,
    dotCanvasX: dotCx,
  };


  ctx.restore();
}

/* ------------------------------------------------------------------ *
 *  面板交互
 * ------------------------------------------------------------------ */

/**
 * 面板几何的唯一来源。
 *
 * 绘制和命中都从这里取坐标，所以不存在"画在 A、判定在 B"的问题，
 * 也不依赖绘制时机 —— 哪怕这一帧还没重绘，命中区照样算得出来。
 * baseY = 面板顶边在目标坐标系里的 y（画布绘制时传 y，命中时传 0）。
 */
function panelGeomOf(node, baseY = 0) {
  const rows = node.__wpsPanelRows || [];
  const widgetWidth = node.size?.[0] ?? 300;
  const x = 10;
  const width = Math.max(180, widgetWidth - 20);

  const geom = {
    x,
    width,
    baseY,
    panelHeight: panelHeightOf(rows),
    rowRects: {},       // 整行（点它切换预设）
    expanderRects: {},  // 展开箭头
    missingRects: {},   // 缺失节点红点（点它开窗口）
    statusDotRects: {}, // 行尾状态点
    header: null,
    toolbar: null,
    compactRect: null,  // 圆形清爽开关
  };

  let cy = baseY + PANEL_PADDING;

  for (const row of rows) {
    const h = panelRowHeight(row);
    const rowY = cy;
    cy += h;

    if (row.kind === "header") {
      geom.header = {
        y: rowY,
        h,
        stateDotX: x + 14,
        stateDotY: rowY + h / 2,
      };
      continue;
    }
    if (row.kind === "toolbar") {
      // 圆形清爽开关：靠左，坐在"新增预设"按钮的正上方
      const r = 11;
      const cx0 = x + 22;
      const cy0 = rowY + h / 2;
      geom.toolbar = { y: rowY, h, cx: cx0, cy: cy0, r };
      geom.compactRect = {
        x: cx0 - r - 5,
        y: cy0 - r - 5,
        w: (r + 5) * 2,
        h: (r + 5) * 2,
      };
      continue;
    }
    if (row.kind !== "preset") continue;

    const statusDotX = x + width - 20;
    const missingX = x + width - 46;

    geom.rowRects[row.key] = { x: x + 6, y: rowY, w: width - 12, h };
    // 状态点是只读的（没有点击行为），这里保持 20px 的小框，
    // 免得和右边放大到 DOT_HIT 的缺失红点命中区叠在一起
    geom.statusDotRects[row.key] = {
      x: statusDotX - 10,
      y: rowY + (h - 20) / 2,
      w: 20,
      h: 20,
    };

    if (row.hasChildren) {
      geom.expanderRects[row.key] = { x: x + 8, y: rowY, w: 16, h };
    }
    if (row.missing > 0) {
      /*
       * 点击区比画出来的点大一大圈（40 vs 直径 16），手感宽松些。
       *
       * 必须建在这里、不能只靠 hitTestLenient：hitTestLocal 的 rowRects
       * 横跨整行，只要 x 落在行里就一定先返回 "row"，宽松命中那条路
       * 实际上永远走不到。
       */
      geom.missingRects[row.key] = {
        x: missingX - DOT_HIT / 2,
        y: rowY + (h - DOT_HIT) / 2,
        w: DOT_HIT,
        h: DOT_HIT,
      };
    }
  }

  return geom;
}

/** 兼容旧调用：只要行命中区 */
function buildRowRects(node) {
  return panelGeomOf(node, 0).rowRects;
}

function hitTest(node, pos) {
  const drawY = node.__wpsLastPanelDrawY;
  if (typeof drawY !== "number") return null;

  // drawPanel 用"面板局部坐标"（从 0 起算），但 mouse 回调给的坐标在不同
  // ComfyUI 版本里可能是控件画布内部坐标（多了 drawY 偏移）。与其猜，
  // 不如让两种解释各自算一遍，谁落在面板实际高度内就信谁。
  const panelH = panelHeightOf(node.__wpsPanelRows || []);
  const candidates = [];
  const shifted = pos[1] - drawY;
  const raw = pos[1];

  // 优先选"落在面板范围内"的那种解释
  const shiftedOk = shifted >= -2 && shifted <= panelH + 2;
  const rawOk = raw >= -2 && raw <= panelH + 2;

  if (shiftedOk && !rawOk) candidates.push(shifted);
  else if (rawOk && !shiftedOk) candidates.push(raw);
  else if (shiftedOk && rawOk) candidates.push(shifted, raw);
  else candidates.push(shifted, raw); // 都不在范围内也试一遍，交给宽松命中兜底

  for (const localY of candidates) {
    const hit = hitTestLocal(node, pos[0], localY);
    if (hit) return hit;
  }

  // 兜底：整行右侧区域也算点到缺失标记
  for (const localY of candidates) {
    const hit = hitTestLenient(node, pos[0], localY);
    if (hit) return hit;
  }

  return null;
}

/** 宽松命中：点在行尾那一带（状态点 / 缺失红点附近）时也算点了红点 */
function hitTestLenient(node, x, localY) {
  const geom = panelGeomOf(node, 0);
  const rows = node.__wpsPanelRows || [];

  for (const row of rows) {
    if (row.kind !== "preset" || !(row.missing > 0)) continue;
    const rect = geom.rowRects[row.key];
    if (!rect) continue;
    if (localY < rect.y || localY >= rect.y + rect.h) continue;
    // 缺失红点画在 x + width - 46 处。严格命中已经覆盖它左右各 DOT_HIT/2，
    // 这里再往外放 10px 当保险 —— 用户 m06099 报过"点不上"。
    // 行尾那一带本来也没有别的用途（状态点是只读的），放宽不会抢走别的操作。
    const dotX = geom.x + geom.width - 46;
    const slack = DOT_HIT / 2 + 10;
    if (x < dotX - slack || x > dotX + slack) continue;
    return { kind: "missing", key: row.key };
  }
  return null;
}

function hitTestLocal(node, xIn, localY) {
  const x = xIn;
  const rows = node.__wpsPanelRows || [];

  const inside = (rect) =>
    !!rect && x >= rect.x && x <= rect.x + rect.w && localY >= rect.y && localY <= rect.y + rect.h;

  // 全部几何从模型实时算，不再读绘制时留下的缓存 —— 这就是"时灵时不灵"的根因
  const geom = panelGeomOf(node, 0);

  // 圆形清爽开关（现在画在列表下方那一行）
  if (inside(geom.compactRect)) return { kind: "compact" };

  // 缺失节点标记优先（它在最右边那一带，和状态点挨着）
  for (const [key, rect] of Object.entries(geom.missingRects)) {
    if (inside(rect)) return { kind: "missing", key };
  }

  // 展开箭头
  for (const [key, rect] of Object.entries(geom.expanderRects)) {
    if (inside(rect)) return { kind: "expander", key };
  }

  // 普通行（点行切换预设）
  for (const row of rows) {
    if (row.kind !== "preset") continue;
    const rect = geom.rowRects[row.key];
    if (!rect) continue;
    if (localY >= rect.y && localY < rect.y + rect.h) {
      return { kind: "row", key: row.key, row };
    }
  }
  return null;
}

function handlePanelMouse(node, event, pos) {
  const rows = node.__wpsPanelRows || [];
  if (!rows.length) return false;

  const isDown = event?.type === "pointerdown" || event?.type === "mousedown";
  const isMove = event?.type === "pointermove" || event?.type === "mousemove";
  const isUp = event?.type === "pointerup" || event?.type === "mouseup";
  if (!isDown && !isMove && !isUp) return false;

  const hit = hitTest(node, pos);

  if (isMove) {
    const dragState = node.__wpsPanelDragState;
    if (dragState?.active && hit?.kind === "row") {
      dragState.overKey = hit.key;
      dragState.moved = dragState.moved || dragState.overKey !== dragState.fromKey;
      app.graph?.setDirtyCanvas(true, true);
      return true;
    }
    return false;
  }

  if (isDown) {
    if (hit?.kind === "compact") return true; // 抬手时切换
    if (hit?.kind === "missing") return true; // 抬手时弹窗
    if (hit?.kind === "expander") return true;

    if (hit?.kind === "row") {
      node.__wpsPanelDragState = {
        active: true,
        fromKey: hit.key,
        overKey: hit.key,
        moved: false,
      };
      return true;
    }
    return false;
  }

  // pointerup
  const dragState = node.__wpsPanelDragState;

  if (dragState?.active) {
    const fromKey = dragState.fromKey;
    const overKey = dragState.overKey;
    const moved = dragState.moved && overKey && overKey !== fromKey;
    node.__wpsPanelDragState = null;

    if (moved) {
      const ok = movePresetIndex(fromKey, overKey);
      if (!ok) {
        refreshPresetWidgets(node);
        return true;
      }
      switchPreset(node, overKey);
      return true;
    }
  }

  if (hit?.kind === "compact") {
    toggleCompactMode(node);
    return true;
  }

  if (hit?.kind === "missing") {
    showMissingNodesDialog(node, hit.key);
    return true;
  }

  // 三角：只负责展开/收起，不改变当前生效的模式
  if (hit?.kind === "expander") {
    const key = hit.key;
    const root = rootKeyOf(key);
    node.__wpsExpanded = node.__wpsExpanded || {};
    node.__wpsExpanded[root] = !node.__wpsExpanded[root];

    refreshPresetWidgets(node);
    app.graph?.setDirtyCanvas(true, true);
    return true;
  }

  if (hit?.kind === "row") {
    const key = hit.key;
    const now = Date.now();
    const lastAt = node.__wpsPanelLastClickAt || 0;
    const lastKey = node.__wpsPanelLastClickKey;
    const isDoubleClick = lastKey === key && now - lastAt <= 320;

    node.__wpsPanelLastClickAt = now;
    node.__wpsPanelLastClickKey = key;

    if (isDoubleClick) {
      promptRenamePreset(node, key, event);
      return true;
    }

    // 点父模式行的文字：切到该模式，并顺带展开它的子模式
    if (!isChildKey(key) && listChildKeys(key).length) {
      node.__wpsExpanded = node.__wpsExpanded || {};
      node.__wpsExpanded[key] = true;
    }

    switchPreset(node, key);
    return true;
  }

  return false;
}

/* ------------------------------------------------------------------ *
 *  切换 / 刷新
 * ------------------------------------------------------------------ */

function promptRenamePreset(node, key = null, triggerEvent = null) {
  const target = key == null ? currentKeyOfNode(node) : String(key);
  if (!ensureStore()?.presets?.[target]) {
    console.warn(`[${EXTENSION_NAME}] preset ${target} not found, cannot rename`);
    return false;
  }

  const currentName = getPresetName(target);
  const canvas = app.canvas;
  if (typeof canvas?.prompt !== "function") {
    console.warn(`[${EXTENSION_NAME}] canvas.prompt unavailable, rename aborted`);
    return false;
  }

  uiLogEvent("rename+", `preset=${target} 打开重命名输入框`);
  canvas.prompt(
    "Rename Preset 重命名预设",
    currentName,
    (value) => {
      if (!setPresetName(target, value)) return;
      refreshPresetWidgets(node);
    },
    triggerEvent
  );

  return true;
}

function switchPreset(node, key) {
  const target = String(key);

  if (!isPresetInputLinked(node)) {
    setIndexWidgetValue(node, normalizeIndex(rootKeyOf(target)));
  }

  const { missing } = applyPresetHierarchy(target);

  syncActiveKey(node, target);
  node.__wpsLastAppliedIndex = normalizeIndex(rootKeyOf(target));

  if (isChildKey(target)) {
    node.__wpsExpanded = node.__wpsExpanded || {};
    node.__wpsExpanded[rootKeyOf(target)] = true;
  }

  if (missing.length) {
    console.warn(
      `[${EXTENSION_NAME}] preset ${target} is missing ${missing.length} node(s):`,
      missing
    );
  }

  refreshPresetWidgets(node);
}

/* ------------------------------------------------------------------ *
 *  界面清爽模式
 *
 *  工具栏的六个按钮现在是 HTML 浮层，清爽模式只是让浮层不再渲染它们，
 *  同时把容器高度收掉工具栏那一块。
 * ------------------------------------------------------------------ */

/**
 * 布局自检：照着 ComfyUI 的 _arrangeWidgets 算一遍，看会不会算出 NaN。
 *
 * 起因：面板控件的 computeSize 以前写成 `width - 20`，而 ComfyUI 调的是
 * computeSize()（不传宽度）→ 宽度那一项算出 NaN。测试里因为传了宽度参数，
 * 一直没发现。
 *
 * 这里只做算术，不依赖画布，返回问题清单（空数组 = 正常）。
 */
function layoutCheck(node) {
  const problems = [];
  const widgets = Array.isArray(node?.widgets) ? node.widgets : [];

  let cursor = 0;
  for (const widget of widgets) {
    if (!widget) continue;

    // 隐藏的控件不参与布局
    if (widget.type === "hidden" && widget.computeSize) {
      const h = widget.computeSize(480)?.[1];
      if (!Number.isFinite(h)) problems.push(`${widget.name || widget.type}: 隐藏控件高度不是有限数`);
      continue;
    }
    if (widget.type === "hidden") continue;

    let h;
    if (typeof widget.computeSize === "function") {
      // 关键：和 ComfyUI 一样不传参数调一次，这正是当初出错的地方
      const bare = widget.computeSize();
      if (!Array.isArray(bare) || !Number.isFinite(bare[0]) || !Number.isFinite(bare[1])) {
        problems.push(
          `${widget.name || widget.type}: computeSize() 不传宽度时返回 ${JSON.stringify(bare)}（宽/高必须是有限数）`
        );
        continue;
      }
      h = bare[1];
    } else {
      h = 20; // NODE_WIDGET_HEIGHT 的近似值，只用于走查
    }

    cursor += h + 4; // _arrangeWidgets 里每次 +4
    if (!Number.isFinite(cursor)) {
      problems.push(`${widget.name || widget.type}: 累加后的控件 y 变成非有限数`);
      break;
    }
  }

  return problems;
}

/**
 * 运行时体检：把面板和每个控件按钮的真实布局状态打出来。
 *
 * 用途：实机上"按钮看不见"这类问题，只有真实运行环境的数据能定位。
 * 加载后会自动跑一次，报告同时存进 globalThis.__wpsLastReport；
 * 想手动再跑一次就在控制台执行 __wpsDiag()。
 */
function diagnose(node) {
  // 不传参数时自己找：先看有没有编辑器里选中/已注入按钮的节点，最后再看 store 里记的
  const target =
    node ||
    (getAllNodes() || []).find((n) => n && n.type === TARGET_NODE_NAME && n.__wpsButtonsInjected) ||
    (getAllNodes() || []).find((n) => n && n.type === TARGET_NODE_NAME);

  if (!target) {
    const msg = "没找到 Preset Switch 节点 —— 先在画布上放一个，再执行 __wpsDiag()";
    console.log(`[${EXTENSION_NAME}] ${msg}`);
    globalThis.__wpsLastReport = msg;
    return msg;
  }

  // 收成一份纯文本报告：console.table 截图看不清，整段复制也方便
  const lines = [];
  /*
   * 报告里要打一堆对象，`String(obj)` 只会得到 "[object Object]" —— 用户贴回来
   * 的关键信息就全丢了（工具栏文字实测、几何、注入记录都是对象）。
   * 所以统一走 JSON，且必须容错：这些对象里可能有循环引用。
   */
  const dump = (value) => {
    if (value === undefined) return "（无）";
    if (value === null || typeof value !== "object") return String(value);
    try {
      return JSON.stringify(value);
    } catch (error) {
      return `（无法序列化：${String(error)}）`;
    }
  };
  const say = (...parts) => lines.push(parts.map((p) => dump(p)).join(" "));

  const rows = target.__wpsPanelRows || [];
  const panel = target.__wpsPresetPanelWidget;
  const store = ensureStore();

  say(`[${EXTENSION_NAME}] ===== 布局体检 v${PLUGIN_VERSION} =====`);
  say("节点 id:", target.id, " size:", target.size, " 选中:", !!target.is_selected);
  say("清爽模式 hideCrudButtons:", !!store?.options?.hideCrudButtons);
  say("面板收起 __wpsPanelHidden:", !!target.__wpsPanelHidden);
  say("行数:", rows.length, " 行类型:", rows.map((r) => r.kind).join(" > "));
  say("行高明细:", rows.map((r) => `${r.kind}:${panelRowHeight(r)}`).join(" "));
  say("面板高 panelHeightOf:", panelHeightOf(rows));
  say("面板 computeSize() [宽,高]:", panel?.computeSize ? panel.computeSize() : "（没有面板控件）");
  say("上次真实绘制:", target.__wpsLastDrawFacts || "（还没画过 —— 面板没被绘制！）");
  say("布局兜底是否触发过:", target.__wpsLastHeal || "（没触发，布局是自洽的）");
  say("按钮补齐记录:", target.__wpsLastInjectReport || "（还没跑过）");
  say("注入/刷新异常:", target.__wpsLastInjectError || "（没有，注入链是干净的）");

  // 按钮数量核对：少了就直接点名，不用再靠截图数
  const wantIds = WIDGET_BUTTONS.map((s) => s.id);
  const haveIds = (target.widgets || [])
    .filter((w) => w && w.__wpsControlButton)
    .map((w) => w.__wpsControlButton);
  const missingIds = wantIds.filter((id) => !haveIds.includes(id));
  say(`按钮数量: 应有 ${wantIds.length} 个，实际 ${haveIds.length} 个`);
  if (missingIds.length) {
    say(`  缺少: ${missingIds.join(", ")}`);
    say(`  节点上全部控件名: ${(target.widgets || []).map((w) => w?.name).join(" | ")}`);
  }

  say("布局自检告警:", layoutCheck(target));

  say("--- 控件列表 ---");
  for (const [i, w] of (target.widgets || []).entries()) {
    say(
      `  ${i}. ${String(w.name || "").slice(0, 26)} | id=${w.__wpsControlButton || "-"} | type=${w.type} | ` +
        `hidden=${!!w.hidden} | y=${w.y} | h=${w.computedHeight}`
    );
  }

  say("--- 面板几何 ---");
  try {
    const geom = panelGeomOf(target, 0);
    say("  宽:", geom.width, " 面板高:", geom.panelHeight, " baseY:", geom.baseY);
    say("  行矩形:", geom.rowRects);
    say("  圆形开关矩形:", geom.compactRect);
    say("  表头:", geom.header, " 底部条:", geom.toolbar);
    // 工具栏文字到底画在哪、画了什么 —— 实机上"文字糊成一团"的唯一铁证
    say("  工具栏文字实测:", target.__wpsLastToolbarText || "（这一段还没画过）");
  } catch (error) {
    say("  取几何失败:", String(error));
  }

  const problems = layoutCheck(target);

  /*
   * --- 上色通道探针 ---
   *
   * 结论（前端 1.53.6，已由 bundle 源码证实）：
   * 按钮的底色读 `this.background_color`、文字读 `this.text_color`、
   * 边框调 `this.getOutlineColor()` —— 而这三样在 BaseWidget 原型上
   * **全是只读取值器**，返回 `litegraph()` 里的常量（#222 / #DDD / #666）。
   * 写 `widget.color` / `bgcolor` / `fillStyle` 一点用都没有（没人读）。
   * 唯一有效的办法是在实例上盖同名取值器，见 paintWidget()。
   *
   * 这里保留探针，是因为"哪个字段才真正控制按钮外观"是**版本相关**的：
   * 升级 ComfyUI 之后跑一次 __wpsDiag，就能看出通道有没有变。
   */
  const recordWidget = (target.widgets || []).find((w) => w?.__wpsControlButton === "record");
  if (recordWidget) {
    const own = [];
    const keys = [
      "name", "label", "type", "value",
      "color", "bgcolor", "fillStyle",
      "background_color", "text_color", "outline_color", "getOutlineColor",
    ];
    for (const key of keys) {
      let owner = "(自身)";
      let shape = "(数据属性)";
      let writable = "-";
      let current;
      let cursor = recordWidget;
      let depth = 0;
      let found = false;
      while (cursor && depth < 8) {
        const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
        if (descriptor) {
          owner = depth === 0 ? "(自身)" : `原型${depth}`;
          if (descriptor.get || descriptor.set) {
            shape = `getter=${!!descriptor.get} setter=${!!descriptor.set}`;
            writable = descriptor.set ? "可写" : "只读(getter-only)";
          } else {
            shape = "(数据属性)";
            writable = descriptor.writable ? "可写" : "只读(writable:false)";
          }
          try {
            current = cursor[key];
          } catch (error) {
            current = `(读取抛错 ${String(error).slice(0, 40)})`;
          }
          found = true;
          break;
        }
        cursor = Object.getPrototypeOf(cursor);
        depth += 1;
      }
      if (!found) {
        owner = "(不存在)";
        writable = "-";
        current = undefined;
      }
      own.push(`${key}: ${dump(current)} @ ${owner} ${shape} ${writable}`);
    }
    say("--- 上色通道探针（记录按钮）---");
    for (const line of own) say("  " + line);
    say("  我们自己盖上去的颜色(__wpsPaint):", recordWidget.__wpsPaint || "（没盖过）");
    say("  记录按钮当前文案:", recordWidget.name, " 状态:", recordWidget.__wpsState);
  }

  if (!Array.isArray(target.widgets) || target.widgets.length < 2) {
    problems.push(`控件数量异常：只有 ${target.widgets?.length ?? 0} 个（应为 8 个：面板 + 7 按钮）`);
  }
  const answer = problems.length ? `发现 ${problems.length} 个问题：${problems.join("；")}` : "布局自检通过";
  say(`[${EXTENSION_NAME}] ===== 体检结束：${answer} =====`);

  const report = lines.join("\n");
  console.log(report);
  globalThis.__wpsLastReport = report;
  return answer;
}

function applyCrudVisibility(node) {
  if (!Array.isArray(node?.widgets)) return;
  const hide = !!ensureStore()?.options?.hideCrudButtons;
  for (const widget of node.widgets) {
    if (!widget?.__wpsControlButton) continue;
    // 设置按钮永远显示 —— 否则进入清爽模式后就没有任何出口
    const keep = !hide || widget.__wpsControlButton === "settings";
    if (widget.__wpsOriginalType === undefined) widget.__wpsOriginalType = widget.type;

    if (keep) {
      if (widget.type !== widget.__wpsOriginalType) widget.type = widget.__wpsOriginalType;
      // 隐藏期间清掉的可见性标记，恢复时必须一起还回来
      if (widget.__wpsHiddenSize) {
        widget.hidden = false;
        widget.computedDisabled = false;
        // 恢复时必须有原来的 computeSize，不能一律 delete ——
        // 万一这个控件原本自带 computeSize，删掉就等于把它的尺寸函数弄丢了。
        if (widget.__wpsSavedComputeSize) widget.computeSize = widget.__wpsSavedComputeSize;
        else delete widget.computeSize;
        delete widget.__wpsSavedComputeSize;
        // ComfyUI 的 _arrangeWidgets 会把高度缓存在 computedHeight 上，
        // 隐藏期间它是 0；不清掉的话恢复后仍然按 0 高布局（按钮叠在一起/看不见）。
        delete widget.computedHeight;
        widget.y = undefined;
        widget.last_y = undefined;
        widget.__wpsHiddenSize = false;
      }
    } else {
      // 只记一次，避免把"隐藏用的 computeSize"当成原始实现存下来
      if (!widget.__wpsHiddenSize) {
        widget.__wpsSavedComputeSize = widget.computeSize;
        widget.__wpsHiddenSize = true;
      }
      /*
       * 这里**不能**写 widget.type = "hidden"。
       *
       * 前端 1.53.6 的绘制链是：
       *   drawWidgets → isWidgetVisible(w)  → !(collapsed || w.hidden || ...)
       *              → toConcreteWidget(w, node, false)?.drawWidget(...)
       * 也就是说：真正的可见性判据是 **widget.hidden**，而不是 type。
       * 而 instantiateConcreteWidget 的 switch 没有 default 分支，未知 type
       * 返回 undefined —— 走 `?.` 短路确实不会报错，但一旦哪天它变成有
       * default 的实现，未知 type 就会被当成能画的东西画出来。
       *
       * 更糟的是 type 被改掉之后，控件再也回不到 "button"：
       * 原生按钮的多行文字排版、按下态都挂在那个 type 上。
       * 所以隐藏改用前端自己的开关，type 保持原样。
       */
      widget.hidden = true;
      widget.computedDisabled = true;
      // 高度压成负数：_arrangeWidgets 里每次 +4，净效果刚好是 0
      widget.computeSize = () => [0, -4];
    }
  }

  node.__wpsPresetPanelSignature = null;
  node.__wpsPanelRowsChanged = true;
}

/* ------------------------------------------------------------------ *
 *  面板挂载
 *
 *  节点上只保留一个自绘容器 widget：上半是预设列表，下半是工具栏区域。
 *  列表的行点击 / 拖拽由 canvas 处理；红点、清爽模式开关、工具栏按钮
 *  都是浮在画布上的 HTML 元素，避免坐标系与缩放带来的问题。
 * ------------------------------------------------------------------ */

function panelWidgetHeight(node, width) {
  // 被快捷键收起时，节点只剩标题栏
  if (node?.__wpsPanelHidden) return 0;

  const rows = node.__wpsPanelRows || [];
  return panelHeightOf(rows);
}

function ensurePresetPanelWidget(node) {
  if (node.__wpsPresetPanelWidget) return;

  node.__wpsPresetPanelWidget = node.addCustomWidget({
    type: "wps_preset_panel",
    name: "Preset Browser 预设浏览器",
    __wpsPresetPanel: true,
    options: { serialize: false },
    // 重要：ComfyUI 的 _arrangeWidgets 调用的是 computeSize()，**不传 width**。
    // 以前这里直接用 width - 20，拿到 undefined 会算出 NaN，进而让
    // computedHeight 变 NaN、控件 y 全变 NaN（按钮整排消失、节点留大片空白）。
    // 所以宽度必须自己从 node.size 兜底，返回值也必须是有限数。
    computeSize(width) {
      const w = Number.isFinite(width) ? width : (Number.isFinite(node?.size?.[0]) ? node.size[0] : 300);
      const finalWidth = Math.max(180, w - 20);
      if (node.__wpsPanelHidden) return [finalWidth, 0];
      const h = panelWidgetHeight(node, w);
      return [finalWidth, Number.isFinite(h) ? h : 0];
    },
    draw(ctx, _node, widgetWidth, y) {
      // 记录本控件自己的画布元素：浮层定位以它为原点，不能用节点坐标
      if (ctx && ctx.canvas) nodeWidgetCanvasEl = ctx.canvas;

      // 收起状态下不绘制任何内容，节点只剩标题栏
      if (node.__wpsPanelHidden) {
        node.__wpsPanelLayout = null;
        return;
      }
      drawPanel(ctx, node, widgetWidth, y, node.__wpsPanelRows || []);
    },
    mouse(event, pos) {
      return handlePanelMouse(node, event, pos);
    },
  });
}

/**
 * 布局兜底（自愈）。
 *
 * 背景：ComfyUI 的 _arrangeWidgets 先算一遍控件高度，再按累加值决定节点尺寸。
 * 节点尺寸一变，下一帧可用高度就变了，需要重算一次才能自洽。正常情况两三帧内
 * 就稳定，但一旦某一帧控件的 y 落到非有限数、或控件被挤出节点高度之外，
 * 表现就是"面板正常、下面那排按钮全不见" —— 而且不会自己恢复。
 *
 * 这里每帧之后核对一次：只要发现按钮被挤出去（或 y 不是有限数），就强制重排一次，
 * 并且把"到底怎么坏的"记进 __wpsLastHeal，用 __wpsDiag() 能看到。
 */
function layoutNeedsHeal(node) {
  const panelIndex = (node.widgets || []).findIndex((w) => w && w.__wpsPresetPanel);
  if (panelIndex < 0) return null;

  const panel = node.widgets[panelIndex];
  // 还没被 ComfyUI 的 arrange 走过一遍时，computedHeight 本来就是空的。
  // 这时候别急着判断（否则开机第一帧必然误报），等下一轮再看。
  if (panel.computedHeight === undefined) return null;

  const nodeHeight = Number.isFinite(node.size?.[1]) ? node.size[1] : null;
  const panelHeight = Number.isFinite(panel.computedHeight) ? panel.computedHeight : null;

  /*
   * 判据：控件的**底边**（y + 高度）有没有超出节点总高度。
   *
   * 这里曾经写成 `widget.y >= bodyHeight - 4`，其中 bodyHeight 取的是
   * node.getMinHeight()（= 节点高 − 标题栏）。看着对，其实是错的：
   * `widget.y` 和 ComfyUI 自己命中测试用的 `last_y` 一样，都是**从节点头顶
   * 算起**（第一个控件 y≈30，正好是标题栏高度），而 node.getMinHeight() 是
   * 标题栏**以下**的净高。拿"从头顶算"的 y 去比"不含标题栏"的高度，等于
   * 把可用高度少算了整整一个标题栏 —— 最下面那个按钮永远"超出"。
   *
   * 实机代价（用户 v0.12.16 报告）：那条日志在 40 多秒里刷了 40 多次，
   * 而且每次数字都一模一样（`⚙ 设置 / Settings: y=439 已经超出可用高度 441`，
   * 节点高 471）。既然每次都一样，说明布局本来就是好的，是判据在误报。
   * 每误报一次就 clear 掉全部控件的 y / last_y 再强行重排 + setDirtyCanvas，
   * 于是：画面每 0.25 秒跳一下（"多出一块又回去了"）；而 ComfyUI 的
   * getWidgetOnPos() 第一句就是 `if (e.last_y !== void 0 && …)`，
   * last_y 刚被清掉的那一瞬**任何控件点击都会被丢掉** ——
   * 这就是用户说的"界面延迟点没有反应，忽然刷新又好了"。
   */
  const suspects = [];
  for (const widget of node.widgets.slice(panelIndex + 1)) {
    if (!widget || widget.type === "hidden" || widget.hidden) continue;
    if (!Number.isFinite(widget.y)) {
      suspects.push(`${widget.name || widget.type}: y 不是有限数（${widget.y}）`);
      continue;
    }
    if (nodeHeight === null) continue;

    const widgetHeight = widgetHeightOf(widget, node);
    const bottom = widget.y + widgetHeight;
    if (bottom > nodeHeight + LAYOUT_HEAL_SLACK) {
      suspects.push(
        `${widget.name || widget.type}: 底边 ${Math.round(bottom)} 已经超出节点高度 ${Math.round(nodeHeight)}`
      );
    }
  }

  // 面板高度算不出来，说明面板控件自己就坏了，优先报这个
  if (panelHeight === null && !node.__wpsPanelHidden) {
    suspects.unshift("面板控件的 computedHeight 不是有限数");
  }

  return suspects.length ? { suspects, nodeHeight, panelHeight } : null;
}

/** 一个控件当前有多高：优先用 arrange 写好的 computedHeight，其次问 computeSize。 */
function widgetHeightOf(widget, node) {
  if (Number.isFinite(widget?.computedHeight)) return widget.computedHeight;

  if (typeof widget?.computeSize === "function") {
    try {
      const size = widget.computeSize(Number.isFinite(node?.size?.[0]) ? node.size[0] : undefined);
      if (Array.isArray(size) && Number.isFinite(size[1])) return size[1];
    } catch (error) {
      /* 控件自己的 computeSize 崩了，退回默认高度 */
    }
  }
  return 26;
}

function healNodeLayout(node) {
  if (!node || node.__wpsPanelHidden) return;
  const problem = layoutNeedsHeal(node);
  if (!problem) return;

  /*
   * 保险丝：同一个节点 1 秒内最多自愈一次。
   *
   * 判据修好之后正常情况根本走不到这里；真坏了（控件真的被挤出节点）
   * 一次重排也够把它拉回来。这条限流是防止判据再被现实打脸时退化成
   * "每 250ms 无条件重排" —— 那正是把用户点击全吃掉的那个故障。
   */
  const lastAt = Number(node.__wpsLastHealAt) || 0;
  if (Date.now() - lastAt < HEAL_MIN_INTERVAL_MS) {
    node.__wpsLastHealSkipped = (Number(node.__wpsLastHealSkipped) || 0) + 1;
    return;
  }
  node.__wpsLastHealAt = Date.now();

  node.__wpsLastHeal = { ...problem, at: Date.now() };
  console.warn(
    `[${EXTENSION_NAME}] 检测到控件被挤出节点，已强制重排：`,
    problem.suspects.join("；"),
    `（节点高 ${problem.nodeHeight}，面板高 ${problem.panelHeight}）—— 详情见 __wpsLastHeal / __wpsDiag()`
  );

  // 清掉 ComfyUI 缓存的布局结果，再让节点按自己的 computeSize 重新定尺寸
  for (const widget of node.widgets || []) {
    delete widget.computedHeight;
    widget.y = undefined;
    widget.last_y = undefined;
  }
  relayoutNode(node);
}

function refreshPresetWidgets(node) {
  if (!node || !node.__wpsPresetPanelWidget) return;

  // 先核对缺失节点，再建行模型 —— 否则行模型拿到的是上一轮的缺失信息，
  // 行尾的暗红点会晚一拍甚至不出现。
  const missingChanged = previewMissingNodes(node);

  const rows = buildPanelModel(node);
  const signature = buildPanelSignature(node, rows);

  // 行数/签名变化就是"面板突然多出一块又回去"的第一嫌疑人，钉下来
  watchPanelRows(node, rows, signature);

  // 行数 / 清爽模式变化都会影响容器高度，节点尺寸要跟着调整
  const previousSignature = node.__wpsPresetPanelSignature;
  if (previousSignature !== signature) {
    node.__wpsPresetPanelSignature = signature;
    node.__wpsPanelRows = rows;
    node.__wpsPanelRowsChanged = true;
    uiLogEvent("panel", `#${numericNodeId(node)} 行模型变了 ${rows.length} 行 ${sizeTag(node)}`);
    app.graph?.setDirtyCanvas(true, true);
  }

  if (node.__wpsPanelRowsChanged) {
    node.__wpsPanelRowsChanged = false;
    relayoutNode(node);
  }

  // 缺失集合刚发生变化时，行模型是在变化之前建的，需要再建一次
  if (missingChanged) {
    const nextRows = buildPanelModel(node);
    node.__wpsPanelRows = nextRows;
    node.__wpsPresetPanelSignature = buildPanelSignature(node, nextRows);
    app.graph?.setDirtyCanvas(true, true);
  }

  // 分组底色每轮都补一次：换成 defineProperty 之后必须幂等，
  // 否则节点被复制/粘贴（新控件对象）之后颜色就再也回不来了。
  paintControlButtons(node);
  updateRecordButton(node);
  // 兜底放在最后：此时控件高度和 y 都已经由这一帧的 arrange 写好，正好能核对
  healNodeLayout(node);
  // 再兜一层：把节点底部不该有的空白收掉（正在拖拽/固定的节点会自动跳过）
  fitNodeToContent(node);
  scheduleOverlaySync(node);
}

/**
 * 轻量核对：每个预设记录过的节点，现在还在不在画布里。
 *
 * 以前只在"套用预设"时检测，所以打开工作流后面板拿不到缺失信息，
 * 行尾的暗红点也不会出现。这里在每次刷新时顺带核对一次，
 * 只做 id 存在性判断，开销很小。
 */
function previewMissingNodes(node) {
  const store = ensureStore();
  if (!store) return false;

  let changed = false;

  for (const [key, preset] of Object.entries(store.presets || {})) {
    if (!preset?.updated_at || !preset.nodes) continue;

    const missing = [];
    const excludedIds = excludedIdSet();
    for (const nodeId of Object.keys(preset.nodes)) {
      // 被排除的节点不该冒红点：它不在记录范围内，缺了也不是"缺失节点"
      if (excludedIds.has(String(nodeId))) continue;
      if (app.graph?.getNodeById?.(Number(nodeId))) continue;
      const rec = preset.nodes[nodeId] || {};
      // 存下"记录那一刻"的节点名：节点已经从画布上删掉，
      // 只有快照里的名字能告诉用户删的是哪一个
      missing.push({
        id: String(nodeId),
        type: String(rec.type || "?"),
        title: String(rec.title || rec.type || "?"),
      });
    }

    const prev = Array.isArray(preset.missing_nodes) ? preset.missing_nodes : [];
    const same = missingFingerprintOf(prev) === missingFingerprintOf(missing);
    if (same) {
      // 名单没变，但旧数据只有 "Type#id"、没名字，顺手升级
      if (prev.length && typeof prev[0] === "string" && missing.length) {
        preset.missing_nodes = missing;
        changed = true;
      }
      continue;
    }

    if (missing.length) {
      preset.missing_nodes = missing;
      store.child_ack[key] = "pending";
    } else {
      delete preset.missing_nodes;
      delete store.child_ack[key];
    }
    changed = true;
  }

  return changed;
}

/**
 * 往控件上写样式属性，**永不抛错**。
 *
 * 【为什么必须要这个】
 * ComfyUI 前端 1.53.6 的控件上，`text_color` 这类字段是**原型上的 getter-only 属性**。
 * ES module 天然是严格模式，所以 `widget.text_color = "x"` 不会静默失败，
 * 而是抛 `TypeError: setting getter-only property "text_color"`；
 * `refreshPresetWidgets()` 从 `updateRecordButton()` 那一行断掉，
 * 后面所有刷新（包括面板重绘）全部不执行 —— 每 250ms 抛一次，控制台刷屏。
 * 而且它断在"刷新"里，表现是"面板文字偶尔不更新"这种莫名其妙的现象，
 * 极难从截图或读码看出来。所以样式写入一律走这里。
 */
function safeSet(target, key, value) {
  if (!target) return false;
  try {
    if (target[key] === value) return true;
    target[key] = value;
    return true;
  } catch (error) {
    return false; // 只读 / getter-only：跳过，绝不让它中断调用方
  }
}

/**
 * 给节点原生按钮上色 —— 唯一的正确通道是「在实例上盖一个同名取值器」。
 *
 * 前端 1.53.6 画按钮用的是（settingStore-DDHzGrHr.js @114397）：
 *
 *   ButtonWidget.drawWidget(e,{width:t,showText:n=!0}){
 *     ...
 *     e.fillStyle = this.background_color,           // ← 底色
 *     ... e.strokeStyle = this.getOutlineColor(),    // ← 边框
 *     n && this.drawLabel(e, t*.5)                   // ← 文字用 this.text_color
 *   }
 *
 * 而 BaseWidget 原型上写的是：
 *
 *   get background_color(){ return litegraph().WIDGET_BGCOLOR }   // 常量 #222
 *   get text_color(){ return litegraph().WIDGET_TEXT_COLOR }      // 常量 #DDD
 *   getOutlineColor(){ return litegraph().WIDGET_OUTLINE_COLOR }  // 常量 #666
 *
 * 全是**只读取值器**；而且 BaseWidget 的构造函数还特意把 options 里的
 * `background_color` / `text_color` / `outline_color` 解构扔掉、根本不往实例上放。
 *
 * 所以以前写的 `widget.color` / `widget.bgcolor` / `widget.fillStyle` 是
 * **完全没有视觉效果**的 —— 那三个字段是我们自己造出来的，前端从来不读。
 * 这就是「记录改动的高亮一直没出现」的真因；也意味着分组配色从加上那天起
 * 就没显示过。之前排查时看到的 `TypeError: setting getter-only property`
 * 只是同一件事的另一面：写 `text_color` 会抛，写 `color` 不抛但没人看。
 *
 * 正确做法：在**实例自己身上** defineProperty 一个同名取值器盖住原型上的。
 * 取值器可以盖取值器，defineProperty 也不受「没有 setter」的限制；
 * 必须 configurable: true，否则第二次改色会被直接拒绝。
 *
 * 边框要注意：`outline_color` 是个属性取值器，但 drawWidget 直接调的是
 * **方法** `this.getOutlineColor()`，所以写属性没用，得把整个方法盖掉。
 * 不发光时要把这个覆盖删掉，让原型上的方法回来，否则边框色会一直留着。
 *
 * @param {{fill?:string|Function, text?:string, outline?:string}} paint
 *        fill 传函数的话就是实时取值：画布每次重绘都按当下这一帧算颜色。
 */
function paintWidget(widget, { fill, text, outline } = {}) {
  if (!widget) return false;
  let ok = false;

  const paint = (key, value) => {
    if (!value) return;
    const get = typeof value === "function" ? value : () => value;
    try {
      Object.defineProperty(widget, key, {
        get,
        configurable: true,
        enumerable: false,
      });
      ok = true;
    } catch (error) {
      console.warn(`[${EXTENSION_NAME}] 给按钮上色失败：${key}`, error);
    }
  };

  paint("background_color", fill);
  paint("text_color", text);

  if (outline) {
    try {
      Object.defineProperty(widget, "getOutlineColor", {
        value: () => (typeof outline === "function" ? outline() : outline),
        configurable: true,
        writable: true,
        enumerable: false,
      });
      ok = true;
    } catch (error) {
      console.warn(`[${EXTENSION_NAME}] 给按钮上边框色失败`, error);
    }
  } else if (Object.prototype.hasOwnProperty.call(widget, "getOutlineColor")) {
    try {
      delete widget.getOutlineColor; // 让原型上的方法回来
    } catch (error) {
      /* 删不掉也只是边框颜色留旧值，不影响功能 */
    }
  }

  if (ok) {
    const flat = (value) => (typeof value === "function" ? value() : value || null);
    widget.__wpsPaint = {
      fill: flat(fill),
      text: flat(text),
      outline: outline ? flat(outline) : null,
      at: Date.now(),
    };
  }
  return ok;
}

/**
 * 「记录当前」按钮随状态变文案与颜色：
 *   未记录 暗红 ● 记录当前 / Record
 *   待记录 黄   ● 记录改动 / Record Changes
 *   已记录 绿   ● 覆盖 / Overwrite
 */
function updateRecordButton(node) {
  if (!Array.isArray(node?.widgets)) return;

  const widget = node.widgets.find((w) => w.__wpsControlButton === "record");
  if (!widget) return;

  const state = computePresetState(currentKeyOfNode(node));
  const spec = RECORD_BUTTON_STATES[state] || RECORD_BUTTON_STATES[STATE_UNRECORDED];

  /*
   * 需要用户动手的状态（有改动 / 缺节点）让底色呼吸起来，提醒人来点。
   * 底色只在这里算一次，下面所有上色通道都用同一个值，免得通道之间颜色不一致。
   */
  const fill = glowingRecordColor(state, spec.color);

  /*
   * 上色一律走 paintWidget()。
   *
   * 直接写 widget.color / widget.bgcolor / fillStyle 在前端 1.53.6 上
   * 没有任何视觉效果（ButtonWidget 画底色读的是 this.background_color），
   * 详见 paintWidget 的注释。
   *
   * 呼吸色传的是**函数**而不是算好的常量：取值器在画布每次重绘时才求值，
   * 于是颜色永远对应"当下这一帧"，比每 250ms 换一次常量色平滑得多，
   * 而且不需要额外开动画循环。
   *
   * 边框也跟着变色（需要用户动手的状态才加），这是用户点名要的
   * 「变颜色 / 亮度 / 边框之类的提醒人点」里最醒目的那一条。
   */
  paintWidget(widget, {
    fill: () => glowingRecordColor(state, spec.color),
    text: spec.textColor,
    outline: RECORD_GLOW[state] ? () => glowingRecordColor(state, spec.color) : null,
  });

  if (widget.name !== spec.name) safeSet(widget, "name", spec.name);
  safeSet(widget, "label", spec.name);

  // 这些是我们自己的字段，永远可写
  widget.__wpsState = state;
  widget.__wpsFill = fill;

  /*
   * 呼吸效果需要持续重绘：只在颜色真的变了的时候弄脏画布，
   * 否则每 250ms 的轮询会变成无脑重绘，大工作流上白白吃 CPU。
   */
  if (widget.__wpsPulsedFill !== fill) {
    widget.__wpsPulsedFill = fill;
    if (RECORD_GLOW[state]) app.graph?.setDirtyCanvas?.(true, false);
  }
}

function activeParentKey(node) {
  const all = listAllKeys();
  const active = currentKeyOfNode(node);
  const root = rootKeyOf(active);

  if (active !== root && all.includes(active)) return root;
  if (all.includes(root)) return root;
  return all.length ? all[0] : null;
}

/**
 * 把一个"多余的" Preset Switch 节点停用。
 *
 * 【为什么只能有一个】
 * 预设数据本来就全工作流共用一份（存在 `graph.extra[STORE_KEY]`），多个开关节点
 * 只是同一份数据的多个视图，没有"各自独立"这回事；而两套面板同时改同一份数据
 * 就得靠同步去兜，同步一旦慢一拍，用户看到的就是"两个节点动作不一致"。
 * 用户实测后拍板：「改为强制只有一个」（m05646 第 4 条）。
 *
 * 【为什么是"停用"而不是"删掉"】
 * 自动删除会静默改掉用户载入的工作流 —— 打开一个旧文件就少一个节点，
 * 这比"多一个不工作的节点"可怕得多。所以只摘掉我们自己注入的东西，
 * 节点原样留着，用户自己决定删不删。
 *
 * 【为什么保留 preset_index】
 * 它是 `widgets_values[0]`，位置被后面的按钮引用着；连它一起摘会改变
 * 序列化位置，把用户存下来的工作流搅乱。它留着也不会有任何副作用：
 * 停用节点的值没人读。
 */
function retireExtraPresetNode(node, primary) {
  if (!node || node.type !== TARGET_NODE_NAME) return false;

  const primaryId = numericNodeId(primary);
  const primaryLabel = primaryId === null ? "另一个节点" : `#${primaryId}`;

  // 已经按同一个"主节点"停用过了，不必每 250ms 重做一遍
  if (node.__wpsRetired === true && node.__wpsRetiredFor === primaryLabel) return false;

  // 摘掉我们自己注入的面板与按钮（只可能在它曾经当过主节点时存在）
  let removed = 0;
  if (Array.isArray(node.widgets)) {
    node.widgets = node.widgets.filter((w) => {
      if (w && (w.__wpsPresetPanel || w.__wpsControlButton)) {
        removed += 1;
        return false;
      }
      return true;
    });
  }

  node.__wpsButtonsInjected = false;
  node.__wpsRetired = true;
  node.__wpsRetiredFor = primaryLabel;
  node.__wpsPresetPanelSignature = null;

  console.warn(
    `[${EXTENSION_NAME}] 一个工作流只允许有一个预设开关：节点 #${node.id} 已停用` +
      `（在用的是 ${primaryLabel}${removed ? `，已摘掉它身上 ${removed} 个我们注入的控件` : ""}）。` +
      `它现在只是个普通节点，删掉即可。`
  );
  return true;
}

/** 停用过的节点又变回主节点（比如原来是主节点的那个被删了）→ 复活它 */
function revivePresetNode(node) {
  if (!node) return false;
  if (node.__wpsRetired !== true) return false;
  delete node.__wpsRetired;
  delete node.__wpsRetiredFor;
  console.log(`[${EXTENSION_NAME}] 节点 #${node.id} 重新成为唯一的预设开关，正在恢复面板与按钮`);
  return true;
}

/**
 * 按钮一律用节点自带的控件按钮（addWidget）。
 *
 * 这是刻意的选择：HTML 浮层按钮在真实 ComfyUI 里的定位依赖 DOM 测量，
 * 一旦失配就整排消失、连出口都没有。控件按钮由 ComfyUI 自己布局绘制，
 * 不依赖任何坐标换算，永远显示、永远可点。
 *
 * 全部追加在末尾，保证 preset_index 仍是 widgets_values[0]，不影响老工作流。
 */
function injectNodeButtons(node) {
  if (!node || node.__wpsButtonsInjected) return;

  /*
   * 先判"这个节点有没有资格当那个唯一的开关"。
   *
   * 必须把 node 自己传进候选池：ComfyUI 建节点的顺序是
   * `onNodeCreated()` → `graph.add(node)`，在这一刻 graph 里还没有它。
   */
  const winner = primaryPresetNode(node);
  if (winner && winner !== node) {
    retireExtraPresetNode(node, winner);
    return;
  }
  revivePresetNode(node);

  node.__wpsLastAppliedIndex = null;
  node.__wpsPresetPanelSignature = null;

  // 先把节点宽度撑到可读宽度，再建面板。
  // 宽度按"最长的双语按钮名"算，否则两行渲染的中英标签会互相挤压。
  const needWidth = WIDGET_BUTTONS.reduce((w, s) => Math.max(w, labelMinWidth(s.name)), 0);
  const targetWidth = Math.max(NODE_WIDTH, needWidth);
  if (Array.isArray(node.size) && node.size[0] < targetWidth) {
    node.size[0] = targetWidth;
  }

  ensurePresetPanelWidget(node);

  // 注意顺序：先建面板再打标记，否则面板会被快照过滤掉
  node.__wpsButtonsInjected = true;

  /*
   * 这一步以前是裸调用，实机上报"只加上了第一个按钮"就是这么来的：
   * addWidget → addCustomWidget → expandToFitContent → node.computeSize()
   * 这条链会把**每一个**控件（包括自绘面板）的 computeSize 都跑一遍，
   * 其中任意一环抛错，整个函数就在这里中断，后面的 applyCrudVisibility /
   * refreshPresetWidgets 全都不会执行。
   *
   * 现在把整段包住并把错误记进 __wpsLastInjectError：
   * 实机再出问题，体检报告里能直接看到异常，不用再靠猜。
   */
  try {
    addMissingControlButtons(node);
    applyCrudVisibility(node);
    refreshPresetWidgets(node);
    node.__wpsLastInjectError = null;
  } catch (error) {
    node.__wpsLastInjectError = {
      message: (error && error.message) || String(error),
      stack: (error && error.stack) || null,
      at: new Date().toISOString(),
    };
    console.warn(`[${EXTENSION_NAME}] 注入按钮/刷新面板时出错（已记录到 __wpsLastInjectError）`, error);
  }
}

/**
 * 补齐缺失的控件按钮。
 *
 * 这里以前是"for 循环一口气加七个"，实机上出现过只加上第一个就没了的情况
 * （体检报告显示节点上只剩 preset_index + 面板 + 新增预设），
 * 而循环里任何一次 addWidget 抛错都会让后面的一起丢 —— 因为
 * addWidget → addCustomWidget → expandToFitContent → node.computeSize()
 * 这条链上任何一环出错都会中断整个 for。
 *
 * 所以改成：逐个加、逐个 try，哪一个失败就单独记下来，剩下的继续加。
 * 并且每次调用都按 id 补齐缺的那些，坏掉了下一帧自己就会修回来。
 */
function addMissingControlButtons(node) {
  if (!Array.isArray(node?.widgets)) return [];

  const wanted = WIDGET_BUTTONS.map((spec) => spec.id);
  const have = new Set(
    node.widgets.filter((w) => w && w.__wpsControlButton).map((w) => w.__wpsControlButton)
  );

  // 已经按 id 全都在了，不用动
  if (wanted.every((id) => have.has(id))) {
    node.__wpsLastInjectReport = { wanted: wanted.length, added: 0, failed: [] };
    return [];
  }

  const failed = [];
  let added = 0;

  for (const spec of WIDGET_BUTTONS) {
    if (have.has(spec.id)) continue;

    let widget = null;
    try {
      widget = node.addWidget("button", spec.name, null, () => {
        try {
          spec.run(node);
        } catch (error) {
          console.error(`[${EXTENSION_NAME}] 按钮「${spec.name}」执行失败`, error);
        }
      });
    } catch (error) {
      failed.push(`${spec.id}: ${(error && error.message) || String(error)}`);
      console.error(`[${EXTENSION_NAME}] 添加按钮「${spec.name}」失败`, error);
      continue; // 关键：不让一个按钮拖垮后面全部
    }

    if (!widget) {
      failed.push(`${spec.id}: addWidget 返回空`);
      continue;
    }

    widget.__wpsControlButton = spec.id;
    if (spec.group) widget.__wpsGroup = spec.group;

    /*
     * 分组底色 —— 必须走 paintWidget()。
     *
     * 以前这里是 `widget.color = spec.color` 那一套，实测**完全没有视觉效果**：
     * ButtonWidget.drawWidget 的底色读的是 `this.background_color`，
     * 而那是原型上一个返回常量 `litegraph().WIDGET_BGCOLOR` 的只读取值器。
     * 写 `text_color` 更糟：严格模式下直接抛
     *   TypeError: setting getter-only property "text_color"
     * 而这句在 `injectNodeButtons()` 中间，一抛就把整条注入链打断：
     * 按钮加上去了、颜色没上成，自动轮询每 250ms 再抛一次。
     * 详见 paintWidget 的注释。
     */
    paintWidget(widget, { fill: spec.color, text: spec.textColor, outline: null });
    safeSet(widget, "label", spec.name);

    added += 1;
  }

  node.__wpsLastInjectReport = { wanted: wanted.length, added, failed };
  if (failed.length) {
    console.warn(
      `[${EXTENSION_NAME}] 有 ${failed.length} 个按钮没能加上：${failed.join("；")}`
    );
  }
  return failed;
}

/**
 * 分组底色的**幂等补齐**。
 *
 * 为什么不能只在 addMissingControlButtons() 里上一次色：
 * 那个函数只在按钮"还缺着"的时候才动手，七个按钮齐了之后它直接 return。
 * 而底色的实现是"在控件实例上盖一个取值器"，**属性是挂在实例上的** ——
 * 节点被复制粘贴、控件对象被重建之后颜色就没了，而且再也不会回来。
 * 放进 refreshPresetWidgets()（每 250ms 一次）就自愈了。
 *
 * `record` 按钮跳过：它的颜色归 updateRecordButton() 管（随状态变，还会呼吸），
 * 这里插一脚会把它按回静态分组色。
 */
function paintControlButtons(node) {
  if (!Array.isArray(node?.widgets)) return 0;
  let painted = 0;
  for (const widget of node.widgets) {
    const id = widget?.__wpsControlButton;
    if (!id || id === "record") continue;
    const spec = WIDGET_BUTTONS.find((item) => item.id === id);
    if (!spec) continue;

    // 已经上过同样的色就别再 defineProperty 一遍（省掉每 250ms 的重复分配）
    const done = widget.__wpsPaint;
    if (done && done.fill === (spec.color || null) && done.text === (spec.textColor || null)) continue;

    paintWidget(widget, { fill: spec.color, text: spec.textColor, outline: null });
    safeSet(widget, "label", spec.name);
    painted += 1;
  }
  return painted;
}

/* ------------------------------------------------------------------ *
 *  定时同步
 * ------------------------------------------------------------------ */

function autoApplyByIndexChange() {
  /*
   * 每轮先定出"唯一在用的那个节点"，再让其余的全部退休。
   *
   * 这件事必须在这里做，不能只在 onNodeCreated 里做：载入一个旧工作流时
   * 节点是被反序列化出来的，而且"谁主谁次"会因为删节点而改变，只有
   * 每拍重算一次才能自愈。
   */
  const primary = primaryPresetNode();

  for (const node of getAllNodes()) {
    if (!node || node.type !== TARGET_NODE_NAME) continue;

    // 尺寸监视放在最前面：退休/注入都可能改尺寸，先记下改之前的值
    if (node === primary) watchNodeSize(node);

    if (node !== primary) {
      retireExtraPresetNode(node, primary);
      continue;
    }

    if (!node.__wpsButtonsInjected) {
      injectNodeButtons(node);
    } else {
      // 已经注入过也要每轮核对一次：按钮如果因为任何原因掉了，这里补回来。
      // 实机上出现过"只剩新增预设"的情况，靠的就是这条兜底。
      addMissingControlButtons(node);
    }

    const rootIndex = getPresetIndexFromNode(node);
    const activeKey = currentKeyOfNode(node);
    const storedIndex = normalizeIndex(rootKeyOf(activeKey));

    // 外部改了 preset_index（或从连线传入），切到对应父模式
    if (node.__wpsLastAppliedIndex !== rootIndex && storedIndex !== rootIndex) {
      const rootKey = String(rootIndex);
      if (ensureStore()?.presets?.[rootKey]) {
        const { missing } = applyPresetState(rootKey);
        syncActiveKey(node, rootKey, rootIndex);
        if (missing.length) {
          console.warn(
            `[${EXTENSION_NAME}] preset ${rootKey} is missing ${missing.length} node(s):`,
            missing
          );
        }
      }
      node.__wpsLastAppliedIndex = rootIndex;
    }

    refreshPresetWidgets(node);
  }
}

/*
 * ------------------------------------------------------------------ *
 *  多节点同步：**已整体删除**（v0.12.14）
 *
 *  这里原来有 `sharedPresetKey` + `syncPresetNodes()` 一整套单向收敛机制，
 *  用来让多个 Preset Switch 节点的选择保持一致。现在删掉了，原因按重要性排：
 *
 *  1. 它服务的前提没了。用户实测后拍板「改为强制只有一个」（m05646 第 4 条），
 *     一个工作流只留一个在用的节点，同步没有对象可同步。
 *  2. 它从来就没有真正生效过。判据是"谁的 `__wpsActiveKey` 和记号对不上，
 *     谁就是刚被切过的那个"，而轮询里恰好有一句无条件把记号抹平 —— 于是它
 *     每一拍看到的都是一个"没人变过"的画布。这条是照真实时序写测试才抓出来的，
 *     在此之前所有同步测试都是"手工造出差异再调它"，只证明了"给差异它能收敛"。
 *  3. 它自身很难证明是对的。收敛不了时的补救（重新 find 一遍改记号）是为了绕开
 *     "两个节点互指"的死循环，那种代码只能靠跑时序验证，而时序里混着浏览器的
 *     250ms 定时器和用户操作，回归测试测到的一直是"谁跑赢了竞速"。
 *
 *  删掉它同时带走了 `__wpsLastSyncKey` 这个字段。留这一段注释是因为
 *  "为什么不要同步"本身就是个决定，以后别有人又把它加回来。
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 *  控制台 / 测试用的自省入口
 *
 *  【为什么必须放在文件最末尾】
 *  这一段以前在文件 260 行附近，而它读取的 `WIDGET_BUTTONS` 是文件 872 行的
 *  `const`。const 绑定有 TDZ：在同一模块里只要"执行到读取那一句"的时刻早于
 *  "声明那一句求值"的时刻，就会抛
 *      ReferenceError: Cannot access 'WIDGET_BUTTONS' before initialization
 *
 *  以前这里整体套在 try/catch 里、catch 又是空的，于是这个错误被静默吞掉：
 *  `__wpsLib` 整个对象挂不上，实机上 `__wpsOverlay` / `__wpsDiag` 看着有、
 *  一用 `__wpsLib` 就说没有 —— 排查"按钮去哪了"时被这件事误导了很久。
 *
 *  现在的规矩：
 *    1. 这段代码放在所有 const / function 声明之后，TDZ 不可能再发生；
 *    2. catch 不再静默，出错必须 console.warn 出来。
 * ------------------------------------------------------------------ */
try {
  globalThis.__wpsOverlay = overlay;
  globalThis.__wpsOverlay.info = () => {
    const node = getAllNodes().find((n) => n?.type === TARGET_NODE_NAME);
    const anchor = panelAnchor();
    const layer = overlay.layer;
    const layerRect = layer?.getBoundingClientRect?.();
    const el = nodeWidgetCanvasEl;
    const widgetRect = el?.getBoundingClientRect?.();

    const report = {
      version: PLUGIN_VERSION,
      scale: canvasScale(),
      anchor,
      rejectedWidgetRect: overlay.lastReject || null,
      layerOffsetInViewport: layerRect ? { left: Math.round(layerRect.left), top: Math.round(layerRect.top) } : null,
      widgetCanvasEl: el
        ? {
            width: el.width,
            height: el.height,
            rect: widgetRect
              ? { left: Math.round(widgetRect.left), top: Math.round(widgetRect.top), w: Math.round(widgetRect.width), h: Math.round(widgetRect.height) }
              : null,
          }
        : null,
      nodePos: node?.pos ? { x: Math.round(node.pos[0]), y: Math.round(node.pos[1]) } : null,
      panelLayout: node?.__wpsPanelLayout || null,
      buttons: [...overlay.buttons.entries()].map(([k, b]) => ({
        key: k,
        left: b.style.left,
        top: b.style.top,
        display: b.style.display,
      })),
    };
    console.log(`[${EXTENSION_NAME}] 浮层自检 v${PLUGIN_VERSION}`, report);
    return report;
  };

  // 内省入口：面板几何现在是"唯一来源"，命中判定与绘制都从它取。
  // 测试脚本 import() 之后拿不到模块内的函数声明，所以显式挂出来。
  globalThis.__wpsGeom = panelGeomOf;
  /*
   * 界面事件日志（排障用，见 uiLogEvent 的注释）。
   *
   * 用户看到"突然多出一块又回去了"时，让他在这里敲 `__wpsUILogDump()`：
   * 如果那几秒里一条记录都没有，那就不是这个插件干的 —— 这份日志的价值
   * 有一半在于能证明清白。
   */
  globalThis.__wpsUILog = () => uiLog.map((e) => ({ ...e }));
  globalThis.__wpsUILogDump = () => {
    if (!uiLog.length) {
      console.log("[comfyui.preset_switch_plus] 界面事件日志是空的（这段时间插件没动过界面）");
      return [];
    }
    const rows = uiLog.map((e) => ({ 时间: e.t, 事件: e.kind, 说明: e.detail }));
    try {
      console.table(rows);
    } catch (_) {
      for (const r of rows) console.log(`${r.时间}  ${r.事件}  ${r.说明}`);
    }
    return rows;
  };
  globalThis.__wpsPlan = buildPanelModel;
  globalThis.__wpsHeight = panelHeightOf;
  globalThis.__wpsHit = hitTest;
  globalThis.__wpsLayoutCheck = layoutCheck;
  globalThis.__wpsDiag = diagnose;
  globalThis.__wpsLib = {
    listRootKeys,
    computePresetState,
    snapshotPresetGraph,
    nodeInfoOf,
    missingLabelOf,
    buildMissingDialogBody,
    panelRowHeight,
    panelGeomOf,
    uiLogEvent,
    watchPanelRows,
    watchNodeSize,
    buildPanelModel,
    hitTest,
    layoutCheck,
    layoutNeedsHeal,
    widgetHeightOf,
    healNodeLayout,
    ensureStore,
    poolPresetWidgets,
    pruneWidgetPool,
    stateWidgets,
    hashWidgetJson,
    recordPreset,
    deletePreset,
    applyStateToNode,
    nodeMatchesSnapshot,
    fitNodeToContent,
    diagnose,
    applyCrudVisibility,
    addMissingControlButtons,
    paintControlButtons,
    updateRecordButton,
    refreshPresetWidgets,
    currentKeyOfNode,
    switchPreset,
    injectNodeButtons,
    autoApplyByIndexChange,
    applyUntrackedNodePolicy,
    captureNodeState,
    // 排除记录：名单管理 + 右键菜单 + 清单窗口
    excludedMap,
    exclusionKeyOf,
    isNodeExcluded,
    excludedIdSet,
    setNodeExcluded,
    clearExclusions,
    excludedNodeList,
    exclusionMenuTargets,
    installExclusionContextMenu,
    showExclusionDialog,
    closeExclusionDialog,
    buildModalShell,
    showHelpDialog,
    closeHelpDialog,
    helpDocUrl,
    jumpToPresetNode,
    jumpHighlightAlpha,
    allPresetNodes,
    primaryPresetNode,
    numericNodeId,
    retireExtraPresetNode,
    revivePresetNode,
    viewportCenter,
    viewportRect,
    moveNodeToPointer,
    trackCanvasPointer,
    installJumpHotkey,
    RECORD_BUTTON_STATES,
    RECORD_GLOW,
    glowingRecordColor,
    mixHex,
    WIDGET_BUTTONS,
    /*
     * 我们用 getter 暴露对话框类，而不是当时那个值。
     *
     * `ComfyDialogClass` 是在模块顶层异步 import 之后才赋值的，而且
     * installDialogDedup() 还会把它替换成包了一层的版本。测试如果直接
     * `import(".../scripts/ui.js")` 拿原始类，得到的是**另一个模块实例**上的
     * 类对象（Node 的模块缓存会保留第一次加载的那份），测出来的东西和插件
     * 真正在用的那个根本不是同一个 —— 这个坑我踩过一次，别再踩第二次。
     */
    get ComfyDialogClass() {
      return ComfyDialogClass;
    },
    get installDialogDedup() {
      return installDialogDedup;
    },
    get closeSettingsDialog() {
      return closeSettingsDialog;
    },
    get showSettingsDialog() {
      return showSettingsDialog;
    },
    /*
     * 也把"当前那个窗口"本身暴露出去。
     *
     * 设置窗口已经不走 ComfyDialog 了，测试再也拿不到 `__lastDialog` 那种
     * 旁路证据；"同一时刻只有一个"这件事只能靠这个变量来查。用 getter
     * 是因为它在开关窗口时会被替换成别的对象，导出当时那个值只会永远停在
     * 第一个窗口上（而且那个窗口早被 remove 掉了，测出来是假绿）。
     */
    get settingsWindow() {
      return settingsWindow;
    },
    // 同理：这两个窗口也是开一次换一个对象，导出值会永远停在第一个
    get exclusionWindow() {
      return exclusionWindow;
    },
    get helpWindow() {
      return helpWindow;
    },
  };
  console.log(
    `[${EXTENSION_NAME}] 内省入口已挂上 v${PLUGIN_VERSION}:`,
    Object.keys(globalThis.__wpsLib).join(", ")
  );
} catch (error) {
  // 静默吞错是上一版最大的教训：挂不上就必须喊出来
  console.warn(`[${EXTENSION_NAME}] 内省入口挂载失败`, error);
}

app.registerExtension({
  name: EXTENSION_NAME,

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== TARGET_NODE_NAME) return;

    // 右键菜单：设置 + 打开作者主页（ComfyUI 原生机制，一定可点）
    const getExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function getExtraMenuOptionsPatched(...args) {
      const result = getExtraMenuOptions?.apply(this, args);
      const options = args?.[1];
      if (Array.isArray(options)) {
        /*
         * 停用的节点只给一条"删掉我"。
         *
         * 不这么做的话，右键菜单里那个「⚙ 设置」会把用户带进一个
         * 改了也不会生效的设置窗口 —— 比没有这个菜单更糟。
         */
        if (this.__wpsRetired === true) {
          const primary = primaryPresetNode();
          const primaryId = numericNodeId(primary);
          options.push(
            {
              content: `⚠ 已被停用：在用的是 ${primaryId === null ? "另一个节点" : `#${primaryId}`}`,
              callback: () => jumpToPresetNode(),
            },
            {
              content: "🗑 删掉这个多余的开关 / Delete this",
              callback: () => {
                try {
                  app?.graph?.remove?.(this);
                } catch (error) {
                  console.warn(`[${EXTENSION_NAME}] 删除节点失败`, error);
                }
              },
            }
          );
          return result;
        }

        /*
         * 缺失节点的保底入口。
         *
         * 画布上那个红点（!）理论上点一下就能看缺了什么，但用户 m06099
         * 报过"小感叹号点不上" —— 画布缩放、节点被挪到屏幕外、手抖，
         * 都会让那几十像素落空。右键菜单是 ComfyUI 自己的 DOM 菜单，
         * 不受画布缩放和命中测试影响，一定点得中，所以这里留一条退路。
         *
         * 只列真正缺节点的预设，最多 5 条 —— 菜单长了反而找不到。
         */
        const missStore = ensureStore();
        const missKeys = Object.keys(missStore?.presets || {}).filter((k) => {
          const list = missStore.presets[k]?.missing_nodes;
          return Array.isArray(list) && list.length > 0;
        });
        for (const k of missKeys.slice(0, 5)) {
          const count = missStore.presets[k].missing_nodes.length;
          options.push({
            content: `⚠ 预设「${getPresetName(k)}」缺 ${count} 个节点 / Missing`,
            callback: () => showMissingNodesDialog(this, k),
          });
        }

        options.push(
          { content: "⚙ 设置 / Settings", callback: () => showSettingsDialog(this) },
          {
            content: "ℹ 打开作者主页 / Author Page",
            callback: () => openExternalLink(config.brandUrl),
          },
          {
            content: "ℹ 开源项目首页 / GitHub",
            callback: () => openExternalLink(config.repoUrl || PROJECT_REPO_URL),
          },
          {
            content: `ℹ 关于 / About  v${PLUGIN_VERSION}`,
            callback: () => showSettingsDialog(this),
          }
        );
      }
      return result;
    };

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function onNodeCreatedPatched(...args) {
      const result = onNodeCreated?.apply(this, args);
      try {
        injectNodeButtons(this);
      } catch (error) {
        console.error(`[${EXTENSION_NAME}] inject widgets failed`, error);
      }
      return result;
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function onRemovedPatched(...args) {
      try {
        disposeOverlayButtons(this);
      } catch (error) {
        console.warn(`[${EXTENSION_NAME}] overlay cleanup failed`, error);
      }
      return onRemoved?.apply(this, args);
    };

    /*
     * 跳转之后闪一下边框。
     *
     * 为什么要有这个：`centerOnNode()` 只是把画面移过去，如果画布上节点很密，
     * 移过去之后仍然要自己找是哪一个。闪一下就是明确回答"在这儿"。
     *
     * 画在 onDrawForeground 里而不是改节点颜色：改 color/bgcolor 会跟着
     * 工作流一起被序列化（那两个字段在 litegraph 的序列化白名单里），
     * 等于为了一个 900ms 的视觉效果污染用户存下来的工作流。
     */
    const onDrawForeground = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function onDrawForegroundPatched(ctx, ...rest) {
      const result = onDrawForeground?.apply(this, [ctx, ...rest]);

      /*
       * 停用节点上的警示横幅。
       *
       * 同样画在这里而不是改节点颜色：`color` / `bgcolor` / `boxcolor` 三个
       * 字段都在 litegraph 的节点序列化白名单里，为了让一个警告"看起来红一点"
       * 就往用户的工作流里写颜色，是不划算的。
       *
       * 而且这里画的字是**临时的**：用户把多余的节点删掉，
       * 画布上就一点痕迹都不留。
       */
      try {
        if (this.__wpsRetired === true && ctx) {
          const w = Array.isArray(this.size) ? this.size[0] : 0;
          const h = Array.isArray(this.size) ? this.size[1] : 0;
          if (w > 0 && h > 0) {
            const lines = [
              "⚠ 一个工作流只允许有一个预设开关",
              `这个已经被停用，在用的是 ${this.__wpsRetiredFor || "另一个节点"}`,
              "选中我按 Delete 删掉即可",
            ];
            ctx.save();
            // 压一层暗红底，让"这个不作数"一眼可辨
            ctx.fillStyle = "rgba(74, 32, 32, 0.78)";
            ctx.fillRect(0, 0, w, h);
            ctx.fillStyle = "#ffd0cc";
            ctx.font = "bold 14px Arial";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            const step = 22;
            let ty = h / 2 - ((lines.length - 1) * step) / 2;
            for (const line of lines) {
              ctx.fillText(line, w / 2, ty);
              ty += step;
            }
            ctx.restore();
          }
        }
      } catch (error) {
        /* 警示画失败绝不能影响节点本身的绘制 */
      }

      try {
        const alpha = jumpHighlightAlpha(this);
        if (alpha > 0 && ctx) {
          const w = Array.isArray(this.size) ? this.size[0] : 0;
          const h = Array.isArray(this.size) ? this.size[1] : 0;
          if (w > 0 && h > 0) {
            ctx.save();
            ctx.globalAlpha = Math.min(1, alpha);
            ctx.strokeStyle = "#ffd479";
            ctx.lineWidth = 3;
            ctx.strokeRect(-2, -2, w + 4, h + 4);
            ctx.restore();
          }
          // 淡出期间让 ComfyUI 继续出帧，否则只有开头那一帧边框，看着像闪了下噪点
          setTimeout(() => {
            try {
              app?.graph?.setDirtyCanvas?.(true, false);
            } catch (error) {
              /* 拿不到画布就算了，不值得为一次高亮抛错 */
            }
          }, 60);
        }
      } catch (error) {
        /* 高亮画失败绝不能影响节点本身的绘制 */
      }
      return result;
    };
  },

  async setup() {
    loadConfig();
    saveConfig(); // 把默认值落盘，便于排查与迁移
    ensureStore();

    try {
      installSettingsStyle();
      installOverlayStyle();
      ensureOverlayLayer();
    } catch (error) {
      console.warn(`[${EXTENSION_NAME}] overlay init failed`, error);
    }

    try {
      installHotkey();
      installJumpHotkey();
    } catch (error) {
      console.warn(`[${EXTENSION_NAME}] hotkey install failed`, error);
    }

    // 给画布上**任意**节点挂「排除记录」右键菜单（用户 m06692 要的入口）
    try {
      installExclusionContextMenu();
    } catch (error) {
      console.warn(`[${EXTENSION_NAME}] 排除菜单安装失败`, error);
    }

    setInterval(autoApplyByIndexChange, 250);

    // 开机后自检：控件链一旦有 NaN，整排按钮会集体消失，肉眼只能看到"按钮不见了"。
    // 这里主动把真实布局打一份报告出来，省得每次都靠猜。
    // 打两次：3 秒时布局刚稳定，8 秒时节点已经过一轮 arrange，两份对比能看出是不是布局在抖。
    for (const delay of [3000, 8000]) {
      setTimeout(() => {
        try {
          const target = (getAllNodes() || []).find((n) => n && n.type === TARGET_NODE_NAME);
          if (!target) return;
          const answer = diagnose(target);
          if (String(answer).startsWith("发现")) {
            console.warn(`[${EXTENSION_NAME}] 布局自检：${answer}`);
          }
          console.log(
            `[${EXTENSION_NAME}] 布局体检报告已存到 __wpsLastReport（复制粘贴即可），` +
              `也可以再执行 __wpsDiag() 重跑`
          );
        } catch (error) {
          console.warn(`[${EXTENSION_NAME}] 布局自检失败`, error);
        }
      }, delay);
    }

    console.log(
      `[${EXTENSION_NAME}] loaded${config.hotkey ? ` — 快捷键 ${hotkeyLabel(config.hotkey)}` : " — 快捷键未启用"}`
    );
  },
});
