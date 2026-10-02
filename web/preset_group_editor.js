import { app } from "../../../scripts/app.js";

const EXTENSION_NAME = "comfyui.preset_group_editor";
const TARGET_NODE_NAME = "PresetGroupEditor";

const MODE_ENABLE = LiteGraph.ALWAYS;
const MODE_BYPASS = 4;
const MODE_DISABLE = LiteGraph.NEVER;

const PROPERTY_MATCH_COLORS = "matchColors";
const PROPERTY_MATCH_TITLE = "matchTitle";
const PROPERTY_SHOW_NAV = "showNav";
const PROPERTY_SHOW_ALL_GRAPHS = "showAllGraphs";
const PROPERTY_SORT = "sort";
const PROPERTY_SORT_CUSTOM_ALPHA = "customSortAlphabet";
const PROPERTY_MANUAL_ORDER = "manualOrder";
const PROPERTY_RESTRICTION = "toggleRestriction";

const DRAG_HANDLE_WIDTH = 18;
const DRAG_ACTIVATE_DISTANCE = 4;

function normalizeHexColor(color) {
  if (!color) return "";
  let c = String(color).trim().toLowerCase();
  if (LGraphCanvas.node_colors?.[c]?.groupcolor) {
    c = LGraphCanvas.node_colors[c].groupcolor;
  }
  c = c.replace("#", "");
  if (c.length === 3) c = c.replace(/(.)(.)(.)/, "$1$1$2$2$3$3");
  return c ? `#${c}` : "";
}

function getGroupNodes(group) {
  if (!group) return [];
  if (typeof group.recomputeInsideNodes === "function") {
    try {
      group.recomputeInsideNodes();
    } catch (_) {}
  }
  if (group._children instanceof Set) {
    return Array.from(group._children).filter((n) => n instanceof LGraphNode);
  }
  return (group.nodes || []).filter((n) => n instanceof LGraphNode);
}

function getNodeModeState(nodes) {
  if (!nodes.length) return "disable";
  const allEnable = nodes.every((n) => n.mode === MODE_ENABLE);
  const allBypass = nodes.every((n) => n.mode === MODE_BYPASS);
  const allDisable = nodes.every((n) => n.mode === MODE_DISABLE);
  if (allEnable) return "enable";
  if (allBypass) return "bypass";
  if (allDisable) return "disable";
  return "mixed";
}

function getGraphs(showAllGraphs) {
  const current = app.canvas?.getCurrentGraph?.() || app.graph;
  if (!current) return [];
  if (!showAllGraphs) return [current];
  const graphs = [current];
  const subgraphs = current.subgraphs?.values?.();
  if (subgraphs) {
    let g;
    while ((g = subgraphs.next().value)) graphs.push(g);
  }
  return graphs;
}

function getGroupsFromNode(node) {
  const props = node.properties || {};
  const sort = props[PROPERTY_SORT] || "position";
  let groups = [];
  const graphs = getGraphs(props[PROPERTY_SHOW_ALL_GRAPHS] !== false);
  for (const graph of graphs) {
    groups.push(...(graph?._groups || []));
  }

  const matchColors = String(props[PROPERTY_MATCH_COLORS] || "")
    .split(",")
    .map((s) => normalizeHexColor(s))
    .filter(Boolean);

  const matchTitle = String(props[PROPERTY_MATCH_TITLE] || "").trim();
  let titleRegex = null;
  if (matchTitle) {
    try {
      titleRegex = new RegExp(matchTitle, "i");
    } catch (e) {
      titleRegex = null;
    }
  }

  groups = groups.filter((group) => {
    if (matchColors.length) {
      const gc = normalizeHexColor(group?.color || "");
      if (!gc || !matchColors.includes(gc)) return false;
    }
    if (titleRegex && !titleRegex.test(group?.title || "")) return false;
    return true;
  });

  if (sort === "alphanumeric") {
    groups.sort((a, b) => String(a?.title || "").localeCompare(String(b?.title || "")));
  } else if (sort === "custom alphabet") {
    const customAlphaStr = String(props[PROPERTY_SORT_CUSTOM_ALPHA] || "").replace(/\n/g, "").trim();
    const customAlphabet = customAlphaStr
      ? (customAlphaStr.includes(",")
          ? customAlphaStr.toLowerCase().split(",")
          : customAlphaStr.toLowerCase().split(""))
      : null;
    if (!customAlphabet?.length) {
      groups.sort((a, b) => String(a?.title || "").localeCompare(String(b?.title || "")));
    } else {
      groups.sort((a, b) => {
        const at = String(a?.title || "").toLowerCase();
        const bt = String(b?.title || "").toLowerCase();
        let aIndex = -1;
        let bIndex = -1;
        for (const [i, alpha] of customAlphabet.entries()) {
          if (aIndex < 0 && at.startsWith(alpha)) aIndex = i;
          if (bIndex < 0 && bt.startsWith(alpha)) bIndex = i;
          if (aIndex > -1 && bIndex > -1) break;
        }
        if (aIndex > -1 && bIndex > -1) {
          if (aIndex === bIndex) return at.localeCompare(bt);
          return aIndex - bIndex;
        }
        if (aIndex > -1) return -1;
        if (bIndex > -1) return 1;
        return at.localeCompare(bt);
      });
    }
  } else {
    groups.sort((a, b) => {
      const ay = Math.floor((a?._pos?.[1] || 0) / 30);
      const by = Math.floor((b?._pos?.[1] || 0) / 30);
      if (ay !== by) return ay - by;
      const ax = Math.floor((a?._pos?.[0] || 0) / 30);
      const bx = Math.floor((b?._pos?.[0] || 0) / 30);
      return ax - bx;
    });
  }

  return groups;
}

function setNodesMode(nodes, mode) {
  for (const node of nodes) {
    node.mode = mode;
  }
}

function getRows(node) {
  return (node.widgets || []).filter((w) => w?.__fgmGroupRow);
}

function applyState(node, targetRow, state) {
  const restriction = String(node?.properties?.[PROPERTY_RESTRICTION] || "default");
  const rows = getRows(node);
  const enableRows = rows.filter((r) => r.value === "enable");

  if (state === "enable" && restriction.includes("one")) {
    for (const row of rows) {
      if (row !== targetRow) {
        setNodesMode(getGroupNodes(row.__group), MODE_DISABLE);
        row.value = "disable";
      }
    }
  }

  if (state !== "enable" && restriction === "always one") {
    const onlyOneEnable = enableRows.length <= 1 && targetRow.value === "enable";
    if (onlyOneEnable) return;
  }

  const mode =
    state === "enable" ? MODE_ENABLE : state === "bypass" ? MODE_BYPASS : MODE_DISABLE;
  setNodesMode(getGroupNodes(targetRow.__group), mode);
  targetRow.value = state;
  targetRow.__state = state;

  app.graph?.setDirtyCanvas(true, true);
}

function drawCircle(ctx, x, y, r, color, active) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = active ? color : "#2a2a2a";
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  ctx.fill();
  ctx.stroke();
}

function drawRoundedRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) * 0.5));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function getControlLayout(width, showNav) {
  const margin = 10;
  const minNameWidth = 76;
  const minColWidth = 42;
  const maxColWidth = 72;
  const minNavWidth = 52;
  const maxNavWidth = 86;

  const safeWidth = Math.max(200, Number(width) || 0);
  const outerLeft = margin;
  const outerRight = safeWidth - margin;
  const innerWidth = Math.max(120, outerRight - outerLeft);

  // 当宽度不足时，优先压缩列宽，避免标题与按钮区域互相覆盖
  const controlsMax = maxColWidth * 3 + (showNav ? maxNavWidth : 0);
  const controlsMin = minColWidth * 3 + (showNav ? minNavWidth : 0);
  const availableControls = Math.max(controlsMin, innerWidth - minNameWidth - 8);
  const controlsWidth = Math.min(controlsMax, availableControls);

  const lerpRange = Math.max(1, controlsMax - controlsMin);
  const t = Math.max(0, Math.min(1, (controlsWidth - controlsMin) / lerpRange));

  const colWidth = minColWidth + (maxColWidth - minColWidth) * t;
  const navWidth = showNav ? minNavWidth + (maxNavWidth - minNavWidth) * t : 0;
  const right = outerRight;

  const navLeft = right - navWidth;
  const disableLeft = navLeft - colWidth;
  const bypassLeft = disableLeft - colWidth;
  const enableLeft = bypassLeft - colWidth;
  const nameLeft = outerLeft + 10;
  const nameRight = enableLeft - 8;

  const enableX = enableLeft + colWidth * 0.5;
  const bypassX = bypassLeft + colWidth * 0.5;
  const disableX = disableLeft + colWidth * 0.5;
  const navX = showNav ? navLeft + navWidth * 0.5 : null;

  return {
    margin,
    colWidth,
    navWidth,
    nameLeft,
    nameRight,
    enableLeft,
    bypassLeft,
    disableLeft,
    navLeft,
    enableX,
    bypassX,
    disableX,
    navX,
    separators: [nameRight, bypassLeft, disableLeft, navLeft],
  };
}

function fitLabel(ctx, label, maxWidth) {
  if (ctx.measureText(label).width <= maxWidth) return label;
  let s = label;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > maxWidth) {
    s = s.slice(0, -1);
  }
  return `${s}…`;
}

function renameGroupWithPrompt(node, row, triggerEvent = null) {
  const group = row?.__group;
  if (!group) return false;

  const currentTitle = String(group?.title || "");
  const applyRename = (nextTitleRaw) => {
    if (nextTitleRaw == null) return false;
    const nextTitle = String(nextTitleRaw).trim();
    if (!nextTitle || nextTitle === currentTitle) return false;

    group.title = nextTitle;
    row.name = `Group ${nextTitle}`;
    refreshGroupWidgets(node);
    app.graph?.setDirtyCanvas(true, true);
    return true;
  };

  // 使用 ComfyUI/LiteGraph 原生弹窗，而非浏览器 window.prompt
  const canvas = app.canvas;
  if (typeof canvas?.prompt === "function") {
    canvas.prompt("Rename Group 重命名分组", currentTitle, (value) => {
      applyRename(value);
    }, triggerEvent);
    return true;
  }

  console.warn(`[${EXTENSION_NAME}] canvas.prompt unavailable, rename aborted`);
  return false;
}

function applyManualOrder(groups, manualOrder) {
  if (!Array.isArray(groups) || !groups.length) return [];
  if (!Array.isArray(manualOrder) || !manualOrder.length) return groups;

  const ordered = [];
  const set = new Set(groups);
  for (const g of manualOrder) {
    if (set.has(g)) {
      ordered.push(g);
      set.delete(g);
    }
  }
  for (const g of groups) {
    if (set.has(g)) {
      ordered.push(g);
      set.delete(g);
    }
  }
  return ordered;
}

function moveArrayItem(arr, from, to) {
  const next = [...arr];
  const max = Math.max(0, next.length - 1);
  const f = Math.max(0, Math.min(max, from));
  const t = Math.max(0, Math.min(max, to));
  if (f === t) return next;
  const [item] = next.splice(f, 1);
  next.splice(t, 0, item);
  return next;
}

function getGroupKey(group) {
  const title = String(group?.title || "").trim().toLowerCase();
  const color = normalizeHexColor(group?.color || "");
  const x = Math.round((group?._pos?.[0] || 0) / 10) * 10;
  const y = Math.round((group?._pos?.[1] || 0) / 10) * 10;
  const w = Math.round((group?._size?.[0] || 0) / 10) * 10;
  const h = Math.round((group?._size?.[1] || 0) / 10) * 10;
  return `t:${title}|c:${color}|x:${x}|y:${y}|w:${w}|h:${h}`;
}

function parseManualOrderKeys(node) {
  const raw = node?.properties?.[PROPERTY_MANUAL_ORDER];
  if (!raw) return [];
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed.map((x) => String(x || "")).filter(Boolean) : [];
  } catch (_) {
    return [];
  }
}

function applyManualOrderByKeys(groups, keyOrder) {
  if (!Array.isArray(groups) || !groups.length) return [];
  if (!Array.isArray(keyOrder) || !keyOrder.length) return groups;

  const buckets = new Map();
  for (const g of groups) {
    const key = getGroupKey(g);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(g);
  }

  const ordered = [];
  for (const key of keyOrder) {
    const queue = buckets.get(key);
    if (queue?.length) ordered.push(queue.shift());
  }

  for (const g of groups) {
    if (!ordered.includes(g)) ordered.push(g);
  }
  return ordered;
}

function persistManualOrder(node, groups) {
  const keys = (groups || []).map((g) => getGroupKey(g)).filter(Boolean);
  node.properties[PROPERTY_MANUAL_ORDER] = JSON.stringify(keys);
}

function findRowByPos(node, pos, areaName) {
  if (!Array.isArray(pos)) return null;
  const [x, y] = pos;
  for (const row of getRows(node)) {
    const area = row?.__hitAreas?.[areaName];
    if (!area) continue;
    if (x >= area.x && x <= area.x + area.w && y >= area.y && y <= area.y + area.h) {
      return row;
    }
  }
  return null;
}

function getDropIndexByY(node, y) {
  const rows = getRows(node);
  if (!rows.length) return 0;
  for (const row of rows) {
    const rect = row?.__rowRect;
    if (!rect) continue;
    const centerY = rect.y + rect.h * 0.5;
    if (y < centerY) return row.__rowIndex || 0;
  }
  return rows.length - 1;
}

function handleDragMouseDown(node, event, pos) {
  if (event?.button != null && event.button !== 0) return false;
  const row = findRowByPos(node, pos, "dragHandle");
  if (!row) return false;

  node.__fgmDragState = {
    row,
    sourceIndex: row.__rowIndex || 0,
    targetIndex: row.__rowIndex || 0,
    startPos: [pos[0], pos[1]],
    lastPos: [pos[0], pos[1]],
    active: false,
  };
  node.setDirtyCanvas?.(true, true);
  return true;
}

function beginDragForRow(node, row, pos) {
  if (!node || !row || !Array.isArray(pos)) return false;
  const idx = typeof row.__rowIndex === "number" ? row.__rowIndex : 0;
  node.__fgmDragState = {
    row,
    sourceIndex: idx,
    targetIndex: idx,
    startPos: [pos[0], pos[1]],
    lastPos: [pos[0], pos[1]],
    active: false,
  };
  node.setDirtyCanvas?.(true, true);
  return true;
}

function handleDragMouseMove(node, _event, pos) {
  const state = node.__fgmDragState;
  if (!state || !Array.isArray(pos)) return false;
  state.lastPos = [pos[0], pos[1]];

  if (!state.active) {
    const dx = Math.abs(pos[0] - state.startPos[0]);
    const dy = Math.abs(pos[1] - state.startPos[1]);
    if (Math.max(dx, dy) >= DRAG_ACTIVATE_DISTANCE) {
      state.active = true;
    } else {
      return true;
    }
  }

  state.targetIndex = getDropIndexByY(node, pos[1]);
  node.setDirtyCanvas?.(true, true);
  return true;
}

function handleDragMouseUp(node) {
  const state = node.__fgmDragState;
  if (!state) return false;
  node.__fgmDragState = null;

  if (!state.active) {
    node.setDirtyCanvas?.(true, true);
    return true;
  }

  const rows = getRows(node);
  const groups = rows.map((r) => r.__group).filter(Boolean);
  const reordered = moveArrayItem(groups, state.sourceIndex, state.targetIndex);

  const changed = reordered.length === groups.length && reordered.some((g, i) => g !== groups[i]);
  if (changed) {
    node.__fgmManualOrder = reordered;
    node.properties[PROPERTY_SORT] = "manual";
    persistManualOrder(node, reordered);
    refreshGroupWidgets(node);
  } else {
    node.setDirtyCanvas?.(true, true);
  }
  return true;
}

function stabilizeByCurrentRows(node, groups) {
  const rows = getRows(node);
  if (!rows.length) return groups;

  const set = new Set(groups);
  const ordered = [];
  for (const row of rows) {
    const group = row?.__group;
    if (set.has(group)) {
      ordered.push(group);
      set.delete(group);
    }
  }
  for (const g of groups) {
    if (set.has(g)) {
      ordered.push(g);
      set.delete(g);
    }
  }
  return ordered;
}

function createGroupHeaderWidget(node) {
  return {
    type: "fgm_group_header",
    name: "Group Header",
    options: { serialize: false },
    __fgmHeader: true,
    computeSize(width) {
      return [Math.max(240, width - 20), 22];
    },
    draw(ctx, _node, width, y, h) {
      const showNav = node?.properties?.[PROPERTY_SHOW_NAV] !== false;
      const layout = getControlLayout(width, showNav);
      const margin = 6;

      drawRoundedRectPath(ctx, margin, y + 1, width - margin * 2, h - 2, 4);
      ctx.fillStyle = "#2a2f36";
      ctx.fill();
      ctx.strokeStyle = "#4a5568";
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.strokeStyle = "#4a5568";
      ctx.lineWidth = 1;
      for (const x of layout.separators) {
        if (!showNav && x === layout.navLeft) continue;
        ctx.beginPath();
        ctx.moveTo(x, y + 2);
        ctx.lineTo(x, y + h - 2);
        ctx.stroke();
      }

      ctx.font = "bold 11px Arial";
      ctx.fillStyle = "#cfd6e6";
      ctx.textAlign = "left";
      ctx.fillText("Group Name 分组", layout.nameLeft, y + h * 0.68);

      ctx.font = "11px Arial";
      ctx.textAlign = "center";
      const colTextMax = Math.max(24, layout.colWidth - 8);
      ctx.fillStyle = "#7ee08f";
      ctx.fillText(fitLabel(ctx, "Enable 启用", colTextMax), layout.enableX, y + h * 0.68);
      ctx.fillStyle = "#f6d272";
      ctx.fillText(fitLabel(ctx, "Bypass 绕过", colTextMax), layout.bypassX, y + h * 0.68);
      ctx.fillStyle = "#e88585";
      ctx.fillText(fitLabel(ctx, "Muted 停用", colTextMax), layout.disableX, y + h * 0.68);
      if (showNav) {
        const navTextMax = Math.max(28, layout.navWidth - 8);
        ctx.fillStyle = "#9ab3dd";
        ctx.fillText(fitLabel(ctx, "Navigate 定位", navTextMax), layout.navX, y + h * 0.68);
      }
    },
  };
}

function createGroupRowWidget(node, group) {
  const row = {
    type: "fgm_group_row",
    name: `Group ${group?.title || ""}`,
    options: { serialize: false },
    value: "mixed",
    __fgmGroupRow: true,
    __group: group,
    __state: "mixed",
    __hitAreas: null,
    computeSize(width) {
      return [Math.max(240, width - 20), 24];
    },
    draw(ctx, _node, width, y, h) {
      const centerY = y + h * 0.5;
      const r = 5;
      const showNav = node?.properties?.[PROPERTY_SHOW_NAV] !== false;
      const layout = getControlLayout(width, showNav);
      const dragState = node?.__fgmDragState;
      const isDraggedRow = dragState?.active && dragState?.row === row;
      const isDropTarget =
        dragState?.active && typeof row.__rowIndex === "number" && dragState.targetIndex === row.__rowIndex;

      drawRoundedRectPath(ctx, 6, y + 2, width - 12, h - 4, 6);
      ctx.fillStyle = isDraggedRow ? "#2d3642" : "#252a31";
      ctx.fill();
      ctx.strokeStyle = "#3d4656";
      ctx.lineWidth = 1;
      ctx.stroke();

      if (isDropTarget) {
        ctx.strokeStyle = "#6ea8ff";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(8, y + h - 3);
        ctx.lineTo(width - 8, y + h - 3);
        ctx.stroke();
      }

      ctx.strokeStyle = "#3d4656";
      ctx.lineWidth = 1;
      for (const x of layout.separators) {
        if (!showNav && x === layout.navLeft) continue;
        ctx.beginPath();
        ctx.moveTo(x, y + 3);
        ctx.lineTo(x, y + h - 3);
        ctx.stroke();
      }

      const navHit = showNav
        ? { x: layout.navLeft, y: y + 2, w: layout.navWidth, h: h - 4 }
        : null;

      if (showNav) {
        ctx.fillStyle = "#8aa2cc";
        ctx.beginPath();
        ctx.moveTo(layout.navX - 6, centerY - 5);
        ctx.lineTo(layout.navX + 2, centerY);
        ctx.lineTo(layout.navX - 6, centerY + 5);
        ctx.closePath();
        ctx.fill();
      }

      const { enableX, bypassX, disableX } = layout;
      drawCircle(ctx, enableX, centerY, r, "#53d26a", row.__state === "enable");
      drawCircle(ctx, bypassX, centerY, r, "#f1c24d", row.__state === "bypass");
      drawCircle(ctx, disableX, centerY, r, "#cf5e5e", row.__state === "disable");

      const handleLeft = layout.nameLeft;
      const handleW = DRAG_HANDLE_WIDTH;
      const handleX = handleLeft + handleW * 0.5;

      ctx.fillStyle = "#93a3bc";
      ctx.font = "11px Arial";
      ctx.textAlign = "center";
      ctx.fillText("⋮⋮", handleX, y + h * 0.68);

      const label = String(group?.title || "Untitled Group 未命名分组");
      const nameTextLeft = layout.nameLeft + handleW + 4;
      const maxWidth = Math.max(40, layout.nameRight - nameTextLeft - 8);
      ctx.fillStyle = "#ddd";
      ctx.font = "12px Arial";
      ctx.textAlign = "left";
      ctx.fillText(fitLabel(ctx, label, maxWidth), nameTextLeft, y + h * 0.68);

      row.__rowRect = { x: 6, y: y + 2, w: width - 12, h: h - 4 };

      row.__hitAreas = {
        name: {
          x: layout.nameLeft + handleW + 2,
          y: y + 2,
          w: Math.max(12, layout.nameRight - layout.nameLeft - handleW - 2),
          h: h - 4,
        },
        dragHandle: {
          x: layout.nameLeft,
          y: y + 2,
          w: handleW,
          h: h - 4,
        },
        enable: { x: enableX - r - 2, y: centerY - r - 2, w: r * 2 + 4, h: r * 2 + 4 },
        bypass: { x: bypassX - r - 2, y: centerY - r - 2, w: r * 2 + 4, h: r * 2 + 4 },
        disable: { x: disableX - r - 2, y: centerY - r - 2, w: r * 2 + 4, h: r * 2 + 4 },
        nav: navHit,
      };
    },
    mouse(event, pos) {
      const eventType = event?.type;
      const isDown = eventType === "pointerdown" || eventType === "mousedown";
      const isMove = eventType === "pointermove" || eventType === "mousemove";
      const isUp = eventType === "pointerup" || eventType === "mouseup";
      const isDblByEvent = eventType === "dblclick" || Number(event?.detail || 0) >= 2;
      if (!isDown && !isDblByEvent && !isMove && !isUp) return false;

      const hit = row.__hitAreas;
      if (!hit) return false;

      // 优先处理已开始的拖拽，避免事件被 row 层吞掉后节点层收不到
      if (node?.__fgmDragState) {
        if (isMove) return handleDragMouseMove(node, event, pos);
        if (isUp) return handleDragMouseUp(node);
      }

      const inside = (rect) =>
        !!rect && pos[0] >= rect.x && pos[0] <= rect.x + rect.w && pos[1] >= rect.y && pos[1] <= rect.y + rect.h;

      if (inside(hit.dragHandle)) {
        if (isDown) {
          // 在 widget 层直接启动拖拽，避免节点级 onMouseDown 被提前消费
          return beginDragForRow(node, row, pos) || handleDragMouseDown(node, event, pos);
        }
        if (isMove && node?.__fgmDragState) {
          return handleDragMouseMove(node, event, pos);
        }
        if (isUp && node?.__fgmDragState) {
          return handleDragMouseUp(node);
        }
        return true;
      }

      // 胶囊拖拽：除功能按钮区域外，整行都可按下拖拽
      const rowRect = row.__rowRect;
      const inCapsule =
        !!rowRect &&
        pos[0] >= rowRect.x &&
        pos[0] <= rowRect.x + rowRect.w &&
        pos[1] >= rowRect.y &&
        pos[1] <= rowRect.y + rowRect.h;

      if (inCapsule) {
        const inControlArea =
          inside(hit.name) ||
          inside(hit.enable) ||
          inside(hit.bypass) ||
          inside(hit.disable) ||
          inside(hit.nav);

        if (!inControlArea && isDown) {
          return beginDragForRow(node, row, pos);
        }
        if (!inControlArea && isMove && node?.__fgmDragState) {
          return handleDragMouseMove(node, event, pos);
        }
        if (!inControlArea && isUp && node?.__fgmDragState) {
          return handleDragMouseUp(node);
        }
      }

      if (inside(hit.enable)) {
        applyState(node, row, "enable");
        return true;
      }
      if (inside(hit.bypass)) {
        applyState(node, row, "bypass");
        return true;
      }
      if (inside(hit.disable)) {
        applyState(node, row, "disable");
        return true;
      }

      if (inside(hit.name)) {
        // 双击触发重命名：优先事件双击，其次时间窗兜底（避免某些环境没有 dblclick 事件）
        const now = Date.now();
        const last = row.__lastNameClickAt || 0;
        const lastPos = row.__lastNameClickPos || pos;
        const closeEnough = Math.abs((pos?.[0] || 0) - (lastPos?.[0] || 0)) < 10 && Math.abs((pos?.[1] || 0) - (lastPos?.[1] || 0)) < 10;
        const isDblByTime = isDown && now - last < 320 && closeEnough;
        row.__lastNameClickAt = now;
        row.__lastNameClickPos = [pos?.[0] || 0, pos?.[1] || 0];

        if (isDblByEvent || isDblByTime) {
          return renameGroupWithPrompt(node, row, event);
        }
        return true;
      }

      if (inside(hit.nav) && node?.properties?.[PROPERTY_SHOW_NAV] !== false) {
        const canvas = app.canvas;
        if (canvas && row.__group) {
          canvas.centerOnNode(row.__group);
          canvas.setDirty(true, true);
        }
        return true;
      }
      return false;
    },
  };

  return row;
}

function ensureProperties(node) {
  node.properties = node.properties || {};
  const defaults = {
    [PROPERTY_MATCH_COLORS]: "",
    [PROPERTY_MATCH_TITLE]: "",
    [PROPERTY_SHOW_NAV]: true,
    [PROPERTY_SHOW_ALL_GRAPHS]: true,
    [PROPERTY_SORT]: "position",
    [PROPERTY_SORT_CUSTOM_ALPHA]: "",
    [PROPERTY_MANUAL_ORDER]: "",
    [PROPERTY_RESTRICTION]: "default",
  };
  for (const [k, v] of Object.entries(defaults)) {
    if (node.properties[k] == null) node.properties[k] = v;
  }

  if (!node.__fgmPropertiesAdded && typeof node.addProperty === "function") {
    node.__fgmPropertiesAdded = true;
    try {
      node.addProperty(PROPERTY_MATCH_COLORS, node.properties[PROPERTY_MATCH_COLORS], "string");
      node.addProperty(PROPERTY_MATCH_TITLE, node.properties[PROPERTY_MATCH_TITLE], "string");
      node.addProperty(PROPERTY_SHOW_NAV, node.properties[PROPERTY_SHOW_NAV], "boolean");
      node.addProperty(PROPERTY_SHOW_ALL_GRAPHS, node.properties[PROPERTY_SHOW_ALL_GRAPHS], "boolean");
      node.addProperty(PROPERTY_SORT, node.properties[PROPERTY_SORT], "string");
      node.addProperty(
        PROPERTY_SORT_CUSTOM_ALPHA,
        node.properties[PROPERTY_SORT_CUSTOM_ALPHA],
        "string",
      );
      node.addProperty(PROPERTY_MANUAL_ORDER, node.properties[PROPERTY_MANUAL_ORDER], "string");
      node.addProperty(PROPERTY_RESTRICTION, node.properties[PROPERTY_RESTRICTION], "string");
    } catch (_) {}
  }
}

function setBatchState(node, state) {
  const rows = getRows(node);
  if (!rows.length) return;
  if (state === "enable") {
    const restriction = String(node?.properties?.[PROPERTY_RESTRICTION] || "default");
    if (restriction.includes("one")) {
      applyState(node, rows[0], "enable");
      return;
    }
  }
  for (const row of rows) applyState(node, row, state);
}

function refreshGroupWidgets(node) {
  if (!node || node.type !== TARGET_NODE_NAME) return;
  ensureProperties(node);

  const computedGroups = getGroupsFromNode(node);
  let groups = computedGroups;
  const sortMode = String(node?.properties?.[PROPERTY_SORT] || "position").toLowerCase();
  if (sortMode === "manual") {
    if (!Array.isArray(node.__fgmManualOrder) || !node.__fgmManualOrder.length) {
      const keyOrder = parseManualOrderKeys(node);
      if (keyOrder.length) {
        node.__fgmManualOrder = applyManualOrderByKeys(computedGroups, keyOrder);
      }
    }
    if (Array.isArray(node.__fgmManualOrder) && node.__fgmManualOrder.length) {
      groups = applyManualOrder(computedGroups, node.__fgmManualOrder);
    }
  } else {
    groups = stabilizeByCurrentRows(node, computedGroups);
  }

  const currentRows = getRows(node);
  const existingMap = new Map(currentRows.map((w) => [w.__group, w]));

  // 移除不再存在的行
  for (let i = node.widgets.length - 1; i >= 0; i--) {
    const w = node.widgets[i];
    if (w?.__fgmGroupRow && !groups.includes(w.__group)) {
      node.widgets.splice(i, 1);
    }
  }

  // 追加/重排
  const fixedWidgets = (node.widgets || []).filter((w) => !w?.__fgmGroupRow && !w?.__fgmHeader);
  const existingHeader = (node.widgets || []).find((w) => w?.__fgmHeader);
  const headerWidget = existingHeader || createGroupHeaderWidget(node);

  const groupWidgets = [];
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    let row = existingMap.get(group);
    if (!row) {
      row = createGroupRowWidget(node, group);
    }
    row.value = getNodeModeState(getGroupNodes(group));
    row.__state = row.value;
    row.__rowIndex = i;
    groupWidgets.push(row);
  }
  node.widgets = [...fixedWidgets, headerWidget, ...groupWidgets];
  node.__fgmManualOrder = groupWidgets.map((w) => w.__group).filter(Boolean);
  if (sortMode === "manual") {
    persistManualOrder(node, node.__fgmManualOrder);
  }
  node.setDirtyCanvas?.(true, true);
}

function injectNodeUI(node) {
  if (!node || node.__fgmInjected) return;
  node.__fgmInjected = true;
  
  // 设置节点最小尺寸，避免拖拽缩放后表头/列区域重叠
  const getMinWidth = () => (node?.properties?.[PROPERTY_SHOW_NAV] === false ? 300 : 360);
  const enforceMinNodeSize = () => {
    const minWidth = getMinWidth();
    const minHeight = 100;
    const nextW = Math.max(minWidth, node.size?.[0] || 0);
    const nextH = Math.max(minHeight, node.size?.[1] || 0);
    if (nextW !== node.size?.[0] || nextH !== node.size?.[1]) {
      node.size = [nextW, nextH];
    }
  };

  node.minSize = [getMinWidth(), 100];
  enforceMinNodeSize();

  if (!node.__fgmPatchedResize) {
    node.__fgmPatchedResize = true;
    const onResize = node.onResize;
    node.onResize = function onResizePatched(...args) {
      const result = onResize?.apply(this, args);
      this.minSize = [this?.properties?.[PROPERTY_SHOW_NAV] === false ? 300 : 360, 100];
      const minWidth = this.minSize[0];
      const minHeight = this.minSize[1];
      const nextW = Math.max(minWidth, this.size?.[0] || 0);
      const nextH = Math.max(minHeight, this.size?.[1] || 0);
      if (nextW !== this.size?.[0] || nextH !== this.size?.[1]) {
        this.size = [nextW, nextH];
      }
      this.setDirtyCanvas?.(true, true);
      return result;
    };
  }

  if (!node.__fgmPatchedDnD) {
    node.__fgmPatchedDnD = true;
    const onMouseDown = node.onMouseDown;
    const onMouseMove = node.onMouseMove;
    const onMouseUp = node.onMouseUp;

    node.onMouseDown = function onMouseDownPatched(event, pos, ...args) {
      if (handleDragMouseDown(this, event, pos)) return true;
      return onMouseDown?.call(this, event, pos, ...args);
    };

    node.onMouseMove = function onMouseMovePatched(event, pos, ...args) {
      if (handleDragMouseMove(this, event, pos)) return true;
      return onMouseMove?.call(this, event, pos, ...args);
    };

    node.onMouseUp = function onMouseUpPatched(event, pos, ...args) {
      if (handleDragMouseUp(this, event, pos)) return true;
      return onMouseUp?.call(this, event, pos, ...args);
    };
  }

  ensureProperties(node);

  if (!Array.isArray(node.outputs) || !node.outputs.length) {
    const out = node.addOutput?.("OPT_CONNECTION", "*");
    if (out && typeof out === "object") out.hidden = true;
  }

  for (const out of node.outputs || []) {
    if (out?.name === "OPT_CONNECTION") {
      out.hidden = true;
    }
  }

  node.addWidget?.("button", "Enable All 全部启用", null, () => setBatchState(node, "enable"));
  node.addWidget?.("button", "Bypass All 全部绕过", null, () => setBatchState(node, "bypass"));
  node.addWidget?.("button", "Muted All 全部停用", null, () => setBatchState(node, "disable"));
  node.addWidget?.("button", "Refresh Groups 刷新分组", null, () => refreshGroupWidgets(node));

  refreshGroupWidgets(node);
}

function autoRefreshManagers() {
  const graph = app.graph;
  if (!graph?._nodes?.length) return;
  for (const node of graph._nodes) {
    if (node?.type !== TARGET_NODE_NAME) continue;
    if (node?.__fgmDragState?.active) continue;
    injectNodeUI(node);
    refreshGroupWidgets(node);
  }
}

app.registerExtension({
  name: EXTENSION_NAME,
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== TARGET_NODE_NAME) return;
    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function onNodeCreatedPatched(...args) {
      const result = onNodeCreated?.apply(this, args);
      try {
        injectNodeUI(this);
      } catch (error) {
        console.error(`[${EXTENSION_NAME}] inject ui failed`, error);
      }
      return result;
    };
  },
  async setup() {
    setInterval(autoRefreshManagers, 500);
    console.log(`[${EXTENSION_NAME}] loaded`);
  },
});
