/**
 * 功能二：列表顶部聚合提示条
 *
 * 目的：智能递归会把子分类的条目聚合到父分类下显示，这会带来一个认知风险——
 * 你可能以为这些条目真的属于父分类，从而误删、误改。所以在列表顶部明确告诉你：
 * 「聚合显示：来自 N 个子分类的 M 条」。
 *
 * 挂载点（Zotero 10 的 zoteroPane.xhtml:1242-1362）：
 *   <vbox id="zotero-items-pane-container">
 *     <toolbar id="zotero-toolbar-item-tree">…</toolbar>
 *     <advanced-search-deck id="zotero-advanced-search-pane-deck"/>
 *     <hbox id="zotero-items-pane">…条目列表…</hbox>
 *   </vbox>
 * 我们把提示条插在 `#zotero-items-pane` 之前，即紧贴列表上方。
 *
 * 刷新时机：包装 `CollectionViewItemTree.prototype.changeCollectionTreeRows`
 * （zotero 10 的复数版本，changeCollectionTreeRow 已委托给它），
 * 并在 item/collection 通知事件后去抖刷新。
 *
 * 数量口径：
 *   M = 当前视图实际检索到的条目数（调用 Zotero 自己的 row.getSearchResults()，命中其缓存）
 *   N = 本次聚合范围内「确实含条目」的子分类个数（一条 SQL 聚合，只计数不加载条目）
 */

import { config } from "../../package.json";
import { getPref } from "../utils/prefs";
import { getString } from "../utils/locale";
import { isAggregating } from "./smartRecursion";

const BANNER_ID = `${config.addonRef}-aggregate-banner`;
/** 去抖时长：条目增删往往成批触发通知 */
const UPDATE_DELAY = 150;

let patched = false;
let patchedProto: any = null;
let originalChangeCollectionTreeRows:
  ((rows: unknown[]) => Promise<unknown>) | null = null;
let notifierID: string | null = null;
let updateTimer: number | null = null;

export { register, unregister };

function register(win: Window) {
  ensureBanner(win);
  patchView(win);
  registerNotifier();
  scheduleUpdate();
}

function unregister(win: Window) {
  const banner = win.document?.getElementById(BANNER_ID);
  banner?.remove();
}

/* ------------------------------------------------------------------ */
/* DOM                                                                 */
/* ------------------------------------------------------------------ */

function ensureBanner(win: Window): HTMLElement | null {
  const doc = win.document;
  const existing = doc?.getElementById(BANNER_ID);
  if (existing) {
    return existing as HTMLElement;
  }

  const container = doc?.getElementById("zotero-items-pane-container");
  const itemsPane = doc?.getElementById("zotero-items-pane");
  if (!container || !itemsPane) {
    return null;
  }

  const banner = doc.createElement("div");
  banner.id = BANNER_ID;
  banner.hidden = true;
  banner.setAttribute("role", "status");
  banner.style.cssText = [
    "padding: 3px 8px",
    "font-size: 12px",
    "line-height: 1.5",
    "color: var(--fill-secondary, #5f5f5f)",
    "background: var(--material-mix-quiet, #f2f2f2)",
    "border-bottom: 1px solid var(--material-border, #e0e0e0)",
    "user-select: none",
  ].join(";");

  container.insertBefore(banner, itemsPane);
  return banner;
}

/* ------------------------------------------------------------------ */
/* 视图刷新挂钩                                                        */
/* ------------------------------------------------------------------ */

function patchView(win: Window) {
  if (patched) {
    return;
  }
  const view = (win as any).ZoteroPane?.itemsView;
  if (!view) {
    return;
  }

  const proto = Object.getPrototypeOf(view);
  if (typeof proto?.changeCollectionTreeRows !== "function") {
    Zotero.debug(
      "[MyZoteroTools] 未找到 changeCollectionTreeRows，提示条将只在启动时刷新",
    );
    return;
  }

  patchedProto = proto;
  originalChangeCollectionTreeRows = proto.changeCollectionTreeRows;
  proto.changeCollectionTreeRows = async function (
    this: unknown,
    rows: unknown[],
  ) {
    const result = await originalChangeCollectionTreeRows!.call(this, rows);
    scheduleUpdate();
    return result;
  };
  patched = true;
}

function unpatchView() {
  if (patched && patchedProto && originalChangeCollectionTreeRows) {
    patchedProto.changeCollectionTreeRows = originalChangeCollectionTreeRows;
  }
  patched = false;
  patchedProto = null;
  originalChangeCollectionTreeRows = null;
}

function registerNotifier() {
  if (notifierID) {
    return;
  }
  notifierID = Zotero.Notifier.registerObserver(
    {
      notify: () => {
        scheduleUpdate();
      },
    },
    ["item", "collection"],
    config.addonRef,
  );
}

function unregisterNotifier() {
  if (notifierID) {
    Zotero.Notifier.unregisterObserver(notifierID);
    notifierID = null;
  }
}

function scheduleUpdate() {
  const win = Zotero.getMainWindow();
  if (!win) {
    return;
  }
  if (updateTimer !== null) {
    win.clearTimeout(updateTimer);
  }
  updateTimer = win.setTimeout(() => {
    updateTimer = null;
    void update();
  }, UPDATE_DELAY);
}

/* ------------------------------------------------------------------ */
/* 提示条内容                                                          */
/* ------------------------------------------------------------------ */

async function update() {
  const win = Zotero.getMainWindow();
  if (!win) {
    return;
  }
  const banner = ensureBanner(win);
  if (!banner) {
    return;
  }
  banner.hidden = true;

  if (!getPref("summaryBanner.enabled")) {
    return;
  }

  const pane = (win as any).ZoteroPane;
  const rows: any[] = pane?.getCollectionTreeRows?.() ?? [];
  const collectionRows = rows.filter((row) => row?.isCollection?.());
  if (!collectionRows.length) {
    return;
  }

  let aggregating = false;
  for (const row of collectionRows) {
    if (await isAggregating(row)) {
      aggregating = true;
      break;
    }
  }
  if (!aggregating) {
    return;
  }

  const collectionCount = await countContributingSubcollections(collectionRows);
  // 没有子分类在贡献条目时不必显示（例如「所有分类」模式下点开了空分类）
  if (collectionCount === 0) {
    return;
  }

  const itemCount = await countDisplayedItems(collectionRows, pane);
  // 「提示条最少条目数」设置：低于阈值就不打扰
  const minItems = Number(getPref("summaryBanner.minItems")) || 0;
  if (itemCount < minItems) {
    return;
  }

  banner.textContent = getString("banner-aggregated", {
    args: { count: itemCount, collections: collectionCount },
  });
  banner.hidden = false;
}

/** 本次聚合范围内「确实含条目」的子分类个数 */
async function countContributingSubcollections(rows: any[]): Promise<number> {
  const ids = new Set<number>();
  for (const row of rows) {
    try {
      const descendants: any[] =
        row.ref?.getDescendents?.(false, "collection") ?? [];
      for (const descendant of descendants) {
        ids.add(descendant.id);
      }
    } catch (e) {
      Zotero.debug(`[MyZoteroTools] 读取子分类失败: ${e}`);
    }
  }
  if (!ids.size) {
    return 0;
  }

  const list = [...ids];
  try {
    return Number(
      await Zotero.DB.valueQueryAsync(
        `SELECT COUNT(DISTINCT collectionID) FROM collectionItems
         WHERE collectionID IN (${list.map(() => "?").join(",")})`,
        list,
      ),
    );
  } catch (e) {
    Zotero.debug(`[MyZoteroTools] 统计子分类数失败，回退为子分类总数: ${e}`);
    return list.length;
  }
}

/** 当前视图实际显示的条目数 */
async function countDisplayedItems(rows: any[], pane: any): Promise<number> {
  let total = 0;
  let ok = true;
  for (const row of rows) {
    try {
      const ids = await row.getSearchResults?.();
      if (Array.isArray(ids)) {
        total += ids.length;
      } else {
        ok = false;
      }
    } catch (e) {
      Zotero.debug(`[MyZoteroTools] 读取检索结果数失败: ${e}`);
      ok = false;
    }
  }
  if (ok) {
    return total;
  }

  // 兜底：直接问视图有多少行
  const view = pane?.itemsView;
  try {
    if (typeof view?.getRowCount === "function") {
      return view.getRowCount();
    }
  } catch (e) {
    Zotero.debug(`[MyZoteroTools] 读取视图行数失败: ${e}`);
  }
  return 0;
}

/** 插件卸载时清理 */
export function teardown() {
  unpatchView();
  unregisterNotifier();
  const win = Zotero.getMainWindow();
  if (win && updateTimer !== null) {
    win.clearTimeout(updateTimer);
    updateTimer = null;
  }
}
