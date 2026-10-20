"""tailmeta —— PNG 元数据后置（修复 XnView 类看图软件浏览 ComfyUI 出图卡顿）

勾选前端设置项后，标准 SaveImage 存完 PNG 会把 tEXt/zTXt/iTXt 元数据块
重排到像素数据（IDAT）之后、IEND 之前。内容一字不改、不压缩；PNG 规范允许
文本块位于像素之后。看图器解完像素即出图、不再解析大段 JSON；
ComfyUI 拖图是整文件扫描，工作流照常完整恢复。

开关存在本目录 tailmeta_config.json（缺省 = 开启）。
只动插件自己的文件，不修改 ComfyUI 本体。
"""

import json
import os
import struct

import nodes
from server import PromptServer
from aiohttp import web

_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(_DIR, "tailmeta_config.json")
LOG_PATH = os.path.join(_DIR, "tailmeta_log.txt")


def _log(msg):
    """追加一行诊断日志（同目录 tailmeta_log.txt），失败静默。"""
    try:
        import datetime
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write("[%s] %s\n" % (datetime.datetime.now().strftime("%m-%d %H:%M:%S"), msg))
    except Exception:
        pass
_SIG = b"\x89PNG\r\n\x1a\n"
_META = {b"tEXt", b"zTXt", b"iTXt"}


def enabled():
    """读开关；配置文件不存在/坏掉时按默认=开启。"""
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return bool(json.load(f).get("enabled", True))
    except Exception:
        return True


def reorder_png(path):
    """把 PNG 里的元数据文本块移到 IDAT 之后、IEND 之前。原地重写，块字节原样搬运。
    返回 True = 真的重排过；False = 无需处理/跳过。"""
    if not path.lower().endswith(".png"):
        return False
    with open(path, "rb") as f:
        data = f.read()
    if data[:8] != _SIG:
        return False
    chunks = []
    i = 8
    while i + 8 <= len(data):
        ln = struct.unpack(">I", data[i:i + 4])[0]
        typ = data[i + 4:i + 8]
        end = i + 12 + ln
        if end > len(data):
            return False  # 结构异常：不动它
        chunks.append((typ, data[i:end]))
        if typ == b"IEND":
            break
        i = end
    meta_idx = [n for n, c in enumerate(chunks) if c[0] in _META]
    if not meta_idx:
        return False
    first_idat = next((n for n, c in enumerate(chunks) if c[0] == b"IDAT"), None)
    if first_idat is not None and all(n > first_idat for n in meta_idx):
        return False  # 已经在像素后面，无需重排
    head = [c for c in chunks if c[0] not in _META and c[0] != b"IEND"]
    meta = [c for c in chunks if c[0] in _META]
    tail = [c for c in chunks if c[0] == b"IEND"]
    new = _SIG + b"".join(c[1] for c in (head + meta + tail))
    tmp = path + ".tailmeta.tmp"
    with open(tmp, "wb") as f:
        f.write(new)
    os.replace(tmp, path)
    return True


# 本机 ComfyUI 版本：SaveImage.save_images 是实例方法
#   def save_images(self, images, filename_prefix="ComfyUI", prompt=None, extra_pnginfo=None)
# 落盘目录来自 self.output_dir，results 里 type == self.type（正式图 "output"，预览 "temp"）。
_orig_save_images = nodes.SaveImage.save_images


def _save_images(self, images, filename_prefix="ComfyUI", prompt=None, extra_pnginfo=None):
    result = _orig_save_images(self, images, filename_prefix=filename_prefix,
                               prompt=prompt, extra_pnginfo=extra_pnginfo)
    try:
        on = enabled()
        _log("save 触发；开关=%s" % on)
        if on:
            for item in (result.get("ui", {}).get("images") or []):
                if item.get("type") != "output":  # 只处理正式保存的图；PreviewImage 的 temp 跳过
                    continue
                fn = item.get("filename") or ""
                if fn.lower().endswith(".png"):
                    p = os.path.join(self.output_dir, item.get("subfolder", ""), fn)
                    reorder_png(p)
                    _log("已重排 -> %s" % p)
    except Exception as e:  # 后处理永远不许影响出图
        import traceback
        _log("后处理异常：%r\n%s" % (e, traceback.format_exc()))
        print(f"[PresetSwitchPlus/tailmeta] 后处理跳过：{e}")
    return result


_save_images._tailmeta_patched = True

if not getattr(nodes.SaveImage.save_images, "_tailmeta_patched", False):
    nodes.SaveImage.save_images = _save_images


# ---- v4：SaveImageAdvanced（comfy_extras 新版保存节点，自己的代码路径写文件）----
import folder_paths as _folder_paths
from comfy_extras import nodes_images as _nodes_images

_orig_adv_execute = _nodes_images.SaveImageAdvanced.execute  # 已绑定的 classmethod


def _save_advanced(*args, **kwargs):
    if args and args[0] is _nodes_images.SaveImageAdvanced:
        args = args[1:]  # 位置调用时剥掉 cls，绑定 classmethod 不需要
    result = _orig_adv_execute(*args, **kwargs)
    try:
        on = enabled()
        items = (getattr(result, "ui", None) or {}).get("images") or []
        _log("save-advanced 触发；开关=%s；ui 条目=%d" % (on, len(items)))
        if on:
            out_dir = _folder_paths.get_output_directory()
            for item in items:
                if item.get("type") != "output":
                    continue
                fn = item.get("filename") or ""
                if fn.lower().endswith(".png"):
                    p = os.path.join(out_dir, item.get("subfolder", ""), fn)
                    reorder_png(p)
                    _log("已重排(adv) -> %s" % p)
    except Exception as e:  # 后处理永远不许影响出图
        import traceback
        _log("adv 后处理异常：%r\n%s" % (e, traceback.format_exc()))
        print(f"[PresetSwitchPlus/tailmeta] Advanced 后处理跳过：{e}")
    return result


_save_advanced._tailmeta_patched = True

if not getattr(_nodes_images.SaveImageAdvanced.execute, "_tailmeta_patched", False):
    _nodes_images.SaveImageAdvanced.execute = _save_advanced


# ---- v5：输出目录监视器（文件级兜底）----
# 不管哪个节点、哪个插件、云端同步——任何 PNG 落进输出目录，几秒内自动重排。
# 首轮扫描只「标记」已有旧文件为已处理，绝不批量改动旧图。
import threading
import time as _time

_WATCH_ROOTS = []
_seen = {}
_watcher_started = False


def _watch_roots():
    """监视目录 = ComfyUI 输出目录 + 配置文件 extra_roots 里的额外路径。"""
    roots = [_folder_paths.get_output_directory()]
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            for r in (json.load(f).get("extra_roots") or []):
                r = str(r).strip()
                if r and os.path.isdir(r) and r not in roots:
                    roots.append(r)
    except Exception:
        pass
    return roots


STATE_PATH = os.path.join(_DIR, "tailmeta_state.json")


def _load_watermark():
    """水位线：此时刻之前落盘的文件视为已处理（开机不翻旧账）。"""
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as f:
            return float(json.load(f).get("watermark", 0))
    except Exception:
        return 0.0


def _save_watermark(ts):
    try:
        with open(STATE_PATH, "w", encoding="utf-8") as f:
            json.dump({"watermark": ts}, f)
    except Exception:
        pass


def _all_pngs(roots):
    for root in roots:
        for dirpath, _dirs, files in os.walk(root):
            for f in files:
                if f.lower().endswith(".png"):
                    yield os.path.join(dirpath, f)


def _watch_loop():
    global _seen
    marked = False
    cycles = 0
    while True:
        try:
            now = _time.time()
            if not marked:
                wm = _load_watermark()
                if wm <= 0:
                    # 首次运行：水位线 = 现在，存量旧图全部跳过（绝不批量翻旧账）
                    wm = now
                    _save_watermark(wm)
                kept = 0
                for p in _all_pngs(_watch_roots()):
                    try:
                        m = os.stat(p).st_mtime
                    except OSError:
                        continue
                    if m <= wm:
                        _seen[p] = "done"   # 水位线之前的旧图：不动
                    else:
                        kept += 1           # 停机期间落盘的新图：照常补处理
                marked = True
                _log("watcher 首轮：跳过旧图 %d 个，待补处理 %d 个；监视目录 %d 个"
                     % (len(_seen), kept, len(_watch_roots())))
            cycles += 1
            if cycles % 20 == 0:
                _save_watermark(now)
            if enabled():
                for p in _all_pngs(_watch_roots()):
                    st = _seen.get(p, "new")
                    if st == "done":
                        continue
                    try:
                        s1 = os.stat(p)
                    except OSError:
                        continue
                    if st == "new":
                        _seen[p] = (s1.st_mtime, s1.st_size)
                        continue
                    mtime0, size0 = st
                    if now - mtime0 > 2.0 and s1.st_size == size0:
                        # 写入已结束（大小稳定、mtime 超过 2 秒）
                        try:
                            reorder_png(p)
                            _log("watcher 重排 -> %s" % p)
                        except Exception as e:
                            _log("watcher 异常 %r %s" % (e, p))
                        _seen[p] = "done"
        except Exception as e:
            _log("watcher 循环异常：%r" % (e,))
        _time.sleep(3.0)


def start_watcher():
    global _watcher_started
    if _watcher_started:
        return
    _watcher_started = True
    t = threading.Thread(target=_watch_loop, name="tailmeta-watcher", daemon=True)
    t.start()


start_watcher()


@PromptServer.instance.routes.get("/preset_switch_plus/tailmeta")
async def _get_tailmeta(request):
    return web.json_response({"enabled": enabled()})


@PromptServer.instance.routes.post("/preset_switch_plus/tailmeta")
async def _set_tailmeta(request):
    body = await request.json()
    value = bool(body.get("enabled", True))
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump({"enabled": value}, f)
    return web.json_response({"enabled": value})


def _scan_current_folder():
    """只扫「当前在往里面存图的文件夹」= 输出目录下最新修改的那个子目录
    （ComfyUI 按日期分文件夹，今天出的图都在今天那个夹子里）。只查一层，
    不递归、不全库扫。有问题（元数据在前）的图才修，正常的字节都不碰。"""
    out = _folder_paths.get_output_directory()
    subs = []
    try:
        for name in os.listdir(out):
            p = os.path.join(out, name)
            if os.path.isdir(p):
                subs.append((os.path.getmtime(p), p))
    except OSError:
        return {"dir": out, "scanned": 0, "fixed": 0}
    target = max(subs)[1] if subs else out
    scanned = fixed = 0
    for f in sorted(os.listdir(target)):
        if not f.lower().endswith(".png"):
            continue
        p = os.path.join(target, f)
        scanned += 1
        try:
            if reorder_png(p):
                fixed += 1
                _log("scan 修复 -> %s" % p)
        except Exception as e:
            _log("scan 异常 %r %s" % (e, p))
    return {"dir": target, "scanned": scanned, "fixed": fixed}


@PromptServer.instance.routes.post("/preset_switch_plus/tailmeta/scan")
async def _scan_tailmeta(request):
    import asyncio
    res = await asyncio.get_event_loop().run_in_executor(None, _scan_current_folder)
    _log("scan 完成：%s" % res)
    return web.json_response(res)


_log("v5 装载 OK（SaveImage + SaveImageAdvanced + 输出目录监视器）；开关=%s" % enabled())
print("[PresetSwitchPlus/tailmeta] PNG 元数据后置已装载 v5：两个保存节点 + 输出目录监视器兜底（当前开关：", enabled(), "）")
