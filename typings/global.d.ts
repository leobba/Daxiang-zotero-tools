declare const _globalThis: {
  [key: string]: any;
  Zotero: _ZoteroTypes.Zotero;
  ztoolkit: ZToolkit;
  addon: typeof addon;
};

declare type ZToolkit = ReturnType<
  typeof import("../src/utils/ztoolkit").createZToolkit
>;

declare const ztoolkit: ZToolkit;

declare const rootURI: string;

declare const addon: import("../src/addon").default;

declare const __env__: "production" | "development";

/**
 * 设置面板脚本（src/preferences.ts 那条 iife 入口）不是运行在插件主沙箱里，
 * 而是由 Zotero 用 `Services.scriptloader.loadSubScript()` 加载到**偏好设置窗口**
 * 的 sandbox 中（以该窗口对象为原型）。所以 window / document 在运行时一定存在，
 * 但本项目的 tsconfig 走的是 zotero-types 的 sandbox 入口、只引入 ESNext，
 * 没有 DOM 库，因此在这里补上声明。
 */
declare const window: any;
declare const document: any;
