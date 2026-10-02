"""
Preset Switch Plus —— 工作流状态预设（增强版）

在原有「记录节点 bypass / mode 状态」的基础上，增加了
「记录并还原节点 widget 参数值」的能力，所以保存一个预设时，
开关状态和参数值会被一起存下来，切换预设时一起恢复。

节点类型名（PresetSwitch / PresetGroupEditor）与原版保持一致，
因此原版工作流可以直接迁移，不需要重新添加节点。
"""


class PresetSwitch:
    """
    Preset Switch —— 用 preset_index 在多个工作流状态之间切换。

    交互按钮（由前端扩展提供）：
    - Add Preset / Record Current / Delete Selected
    - Prev Preset / Next Preset / Preset Browser / Rename Current

    快照内容（每个节点）：
    - mode / bypass：节点是启用、跳过还是禁用
    - widgets：节点上各个 widget 的参数值（本增强版新增）
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "preset_index": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 999999,
                        "step": 1,
                        "tooltip": "当前激活的预设编号。改动后会自动套用对应预设。",
                    },
                )
            }
        }

    RETURN_TYPES = ("INT",)
    RETURN_NAMES = ("preset_index",)
    FUNCTION = "run"
    CATEGORY = "X-WIDE/Preset"
    # 搜索别名：在节点搜索框里输入 xwide / x-wide / x wied / preset 都能命中
    SEARCH_ALIASES = [
        "X-WIDE",
        "X-WIED",
        "xwide",
        "x wide",
        "preset",
        "preset switch",
        "预设",
        "预设开关",
        "子模式",
        "工作流预设",
    ]

    DESCRIPTION = (
        "把整个工作流的开关状态 + 参数值存成若干套预设，"
        "改一个 preset_index（或点 Preset Browser 里的一行）即可整体切换。"
    )

    def run(self, preset_index):
        return (int(preset_index),)


class PresetGroupEditor:
    """
    Preset Group Editor —— 分组三态控制面板。

    列出工作流里的所有分组（Group），一键在三种状态间切换：
    - 启用（ALWAYS）
    - 跳过（BYPASS / mode=4）
    - 禁用（NEVER）

    支持过滤、排序、导航、双击改名，以及批量操作。
    后端仅提供节点定义，交互全部由前端扩展实现。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    RETURN_NAMES = ()
    FUNCTION = "run"
    CATEGORY = "X-WIDE/Preset"
    SEARCH_ALIASES = [
        "X-WIDE",
        "X-WIED",
        "xwide",
        "x wide",
        "group",
        "group editor",
        "分组",
        "分组面板",
        "跳过",
        "禁用",
    ]

    DESCRIPTION = "按分组批量切换 启用 / 跳过 / 禁用，支持 max one、always one 等互斥策略。"

    def run(self):
        return tuple()


NODE_CLASS_MAPPINGS = {
    "PresetSwitch": PresetSwitch,
    "PresetGroupEditor": PresetGroupEditor,
}

# 显示名里带上 X-WIDE，这样在节点搜索框里输入 xwide / x-wide / X-WIDE
# 都能直接搜到（ComfyUI 的搜索会匹配显示名与分类）。
NODE_DISPLAY_NAME_MAPPINGS = {
    "PresetSwitch": "X-WIDE Preset Switch 预设开关",
    "PresetGroupEditor": "X-WIDE Preset Group Editor 分组面板",
}
