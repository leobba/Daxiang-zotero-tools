import { config } from "../package.json";
import { getString, initLocale } from "./utils/locale";
import { getPref } from "./utils/prefs";
import { registerPrefsPane } from "./modules/prefsPane";
import * as smartRecursion from "./modules/smartRecursion";
import * as sourceColumn from "./modules/sourceColumn";
import * as summaryBanner from "./modules/summaryBanner";
import * as readingStatus from "./modules/readingStatus";
import * as exportBundle from "./modules/exportBundle";
import * as libraryAudit from "./modules/libraryAudit";
import * as structuredFields from "./modules/structuredFields";
import * as metadataClean from "./modules/metadataClean";
import * as updateChecker from "./modules/updateChecker";
import * as literatureIntake from "./modules/literatureIntake";

/**
 * 生命周期总调度。
 *
 * 约定（沿用模板的实践）：hooks 只做分发与装配，真正的业务逻辑放在
 * `src/modules/` 下，便于长期维护和逐项开关。
 */
async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  // 把功能模块挂到 addon.api 上：既方便在 Zotero 的调试控制台里直接调用，
  // 也让测试能拿到**插件运行时**的模块实例（测试包与插件包是两次独立构建，
  // 测试里 import 到的是另一份副本，register/unregister 这类带状态的调用必须走这里）。
  addon.api = {
    smartRecursion,
    sourceColumn,
    summaryBanner,
    readingStatus,
    exportBundle,
    libraryAudit,
    structuredFields,
    metadataClean,
    updateChecker,
    literatureIntake,
  };

  await registerPrefsPane();

  // 功能①：按需智能递归（包装 CollectionTreeRow.getSearchObject）
  smartRecursion.install();

  // 功能③：条目列表「来源子分类」列（官方 ItemTreeManager API）
  sourceColumn.register();

  // 功能④：阅读状态——自定义列 + 右键菜单（都是官方 API）
  readingStatus.register();

  // 功能⑤：导出文献数据包——右键菜单
  exportBundle.register();

  // 功能⑥：库体检（只读）——「工具」菜单
  libraryAudit.register();

  // 功能⑦：结构化字段——条目面板区块 + 右键菜单
  structuredFields.register();

  // 功能⑧：元数据清洗（去 HTML 标签 / 统一 language）——「工具」菜单
  metadataClean.register();

  // 功能⑨：检查更新（含加速站测速）——「工具」菜单
  updateChecker.register();

  // 功能⑩：文献自动入库（agent ↔ Zotero 衔接）
  literatureIntake.register();

  // 功能②需要在每个主窗口上工作
  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  // 供 scaffold 的测试流程判断插件是否加载完成
  addon.data.initialized = true;
  ztoolkit.log(getString("startup-finish"));
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  // 把插件的 FTL 注册到主窗口。
  // Zotero 会把插件所有 .ftl 汇总进一个 L10nFileSource，但**必须在文档里
  // 用 <link rel="localization"> 引入才会生效**。偏好设置面板的 xhtml 里有这个
  // linkset，主窗口没有——而 MenuManager 的菜单文案走的是主窗口的
  // document.l10n，不注入的话菜单项会没有文字。
  // insertFTLIfNeeded 是 Firefox 提供的标准方法，自带去重。
  try {
    (win as any).MozXULElement.insertFTLIfNeeded(
      `${config.addonRef}-addon.ftl`,
    );
  } catch (e) {
    Zotero.debug(`[MyZoteroTools] 注册主窗口本地化资源失败: ${e}`);
  }

  // 主窗口样式表也得自己注入：偏好面板有官方 stylesheets 选项，主窗口没有
  // （Zotero 插件基础设施 issue #5755 至今 open）。
  try {
    injectStyleSheet(win.document);
  } catch (e) {
    Zotero.debug(`[MyZoteroTools] 注入主窗口样式失败: ${e}`);
  }

  // 功能②：列表顶部聚合提示条
  summaryBanner.register(win);

  // 开发便利：打开了 dev.openPrefsOnStart 时，自动弹出设置面板，
  // 便于改完界面直接看效果（仅开发构建生效，正式构建里这段不会执行）。
  if (__env__ === "development" && getPref("dev.openPrefsOnStart")) {
    win.setTimeout(() => {
      try {
        Zotero.Utilities.Internal.openPreferences(
          `${addon.data.config.addonRef}-prefpane`,
        );
      } catch (e) {
        Zotero.debug(`[MyZoteroTools] 自动打开设置面板失败: ${e}`);
      }
    }, 2500);
  }
}

async function onMainWindowUnload(win: Window): Promise<void> {
  summaryBanner.unregister(win);
}

/**
 * 往主窗口注入插件样式表（自带去重）。
 * 偏好设置面板有官方 `stylesheets` 选项，主窗口没有对应的官方 API，
 * 只能自己插 <link rel="stylesheet">。
 */
function injectStyleSheet(doc: Document): void {
  const href = `chrome://${config.addonRef}/content/zoteroPane.css`;
  const existing = doc.querySelector(`link[rel="stylesheet"][href="${href}"]`);
  if (existing) {
    return;
  }
  const link = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "link",
  ) as HTMLLinkElement;
  link.setAttribute("rel", "stylesheet");
  link.setAttribute("href", href);
  const root = doc.documentElement;
  if (root) {
    root.append(link);
  }
}

function onShutdown(): void {
  summaryBanner.teardown();
  literatureIntake.unregister();
  updateChecker.unregister();
  metadataClean.unregister();
  structuredFields.unregister();
  libraryAudit.unregister();
  exportBundle.unregister();
  readingStatus.unregister();
  sourceColumn.unregister();
  smartRecursion.uninstall();

  addon.data.ztoolkit.unregisterAll();
  addon.data.alive = false;
  // @ts-expect-error - 移除全局实例
  delete Zotero[addon.data.config.addonInstance];
}

/**
 * 设置面板事件分发。
 * 目前所有开关都由设置框架的 pref 绑定自动写入，且各功能在运行时读取 pref，
 * 因此这里暂无额外工作，保留入口供后续扩展。
 */
function onPrefsEvent(type: string, _data: { [key: string]: any }) {
  switch (type) {
    case "load":
      break;
    default:
      break;
  }
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onPrefsEvent,
};
