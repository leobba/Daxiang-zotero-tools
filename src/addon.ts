import { config } from "../package.json";
import hooks from "./hooks";
import { createZToolkit, MyToolkit } from "./utils/ztoolkit";

class Addon {
  public data: {
    alive: boolean;
    config: typeof config;
    /** 构建环境，见 zotero-plugin.config.ts 的 define */
    env: "development" | "production";
    /** 供 scaffold 的测试流程判断插件是否加载完成 */
    initialized?: boolean;
    ztoolkit: MyToolkit;
    locale?: {
      current: any;
    };
  };

  /** 生命周期钩子（只做分发，业务逻辑放 modules/） */
  public hooks: typeof hooks;

  /** 对外暴露的 API，供未来扩展或调试使用 */
  public api: Record<string, unknown>;

  constructor() {
    this.data = {
      alive: true,
      config,
      env: __env__,
      initialized: false,
      ztoolkit: createZToolkit(),
    };
    this.hooks = hooks;
    this.api = {};
  }
}

export default Addon;
