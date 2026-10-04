import {
  BasicTool,
  ProgressWindowHelper,
  UITool,
  unregister,
} from "zotero-plugin-toolkit";
import { config } from "../../package.json";

/**
 * MyToolkit —— 本插件使用的 toolkit 聚合。
 *
 * 说明：zotero-plugin-toolkit 自 5.2.0 起移除了 `ZoteroToolkit` 聚合类，
 * 改为按需导入各个 Helper。这里只组合我们真正用到的模块，好处是：
 *   1. 打包体积更小；
 *   2. 上游增删 Helper 时不会因为一个聚合类而整体编译失败。
 *
 * `unregister(this)` 会遍历实例自身属性、逐个调用其 `unregisterAll()`
 * （见 toolkit 源码），因此这里持有 UI 即可自动完成元素清理。
 */
class MyToolkit extends BasicTool {
  UI: UITool;

  constructor() {
    super();
    this.UI = new UITool(this);
  }

  /**
   * 创建进度窗口。
   * toolkit 6 中 `ProgressWindowHelper` 是独立类（不继承 BasicTool）且需要标题，
   * 故用工厂方法包一层。
   */
  progressWindow(
    header: string,
    options?: {
      window?: Window;
      closeOnClick?: boolean;
      closeTime?: number;
      closeOtherProgressWindows?: boolean;
    },
  ) {
    return new ProgressWindowHelper(header, options);
  }

  unregisterAll() {
    unregister(this);
  }
}

export { createZToolkit };
export type { MyToolkit };

function createZToolkit() {
  const _ztoolkit = new MyToolkit();
  initZToolkit(_ztoolkit);
  return _ztoolkit;
}

function initZToolkit(_ztoolkit: MyToolkit) {
  const env = __env__;
  _ztoolkit.basicOptions.log.prefix = `[${config.addonName}]`;
  _ztoolkit.basicOptions.log.disableConsole = env === "production";
  _ztoolkit.UI.basicOptions.ui.enableElementJSONLog = env === "development";
  _ztoolkit.UI.basicOptions.ui.enableElementDOMLog = env === "development";
  _ztoolkit.basicOptions.api.pluginID = config.addonID;
}
