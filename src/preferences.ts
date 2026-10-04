/**
 * 设置面板脚本入口。
 *
 * 由 `Zotero.PreferencePanes.register({ scripts: [...] })` 加载，底层是
 * `Services.scriptloader.loadSubScript()` —— **经典脚本**加载器，不支持 ESM，
 * 因此构建时必须打成 iife（见 zotero-plugin.config.ts 的第二条 esbuild 配置）。
 *
 * 作用域是偏好设置窗口的 sandbox（以该窗口对象为原型），所以
 * `window` / `document` / `Zotero` 都可以直接使用。
 */

import { renderPreferencesPane } from "./settings/pane";

void renderPreferencesPane(window);
