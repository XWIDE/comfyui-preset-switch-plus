from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

# PNG 元数据后置开关（tailmeta）：装载即生效，行为由前端设置项控制，默认开。
from . import tailmeta as _tailmeta

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

__version__ = "0.12.51"
