import { config } from "../../package.json";
import { getString } from "../utils/locale";

/**
 * 注册插件设置面板（Zotero 7+ 官方 API）。
 * 面板在插件卸载时会由 Zotero 自动注销。
 *
 * 三个要点（都在实际调试中踩过）：
 *  1. `register()` 是 **async** 的（内部要 await `Zotero.Plugins.resolveURI()`
 *     把 src / scripts / stylesheets 解析成绝对 URI），必须 await。
 *  2. `scripts` 由 `Services.scriptloader.loadSubScript()` 加载，是**经典脚本**，
 *     所以那条 esbuild 配置必须用 iife 格式（见 zotero-plugin.config.ts）。
 *  3. 面板片段是**在脚本执行之后**才加载并插入的，所以脚本里必须等容器出现。
 */
export { registerPrefsPane };

async function registerPrefsPane() {
  await Zotero.PreferencePanes.register({
    pluginID: config.addonID,
    // 显式指定 id，避免 Zotero 自动生成随机 id 导致外部无法稳定引用
    id: `${config.addonRef}-prefpane`,
    src: "content/preferences.xhtml",
    // 面板专用样式表：只做间距与次级文字的微调，类名带 mzt- 前缀
    stylesheets: ["content/preferences.css"],
    // 面板脚本：按 src/settings/registry.ts 的声明生成界面
    scripts: [`content/scripts/${config.addonRef}-preferences.js`],
    label: getString("prefs-title"),
    image: `chrome://${config.addonRef}/content/icons/favicon.png`,
  });
}
