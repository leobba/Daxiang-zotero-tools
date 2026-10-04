/**
 * 功能④：阅读状态（待读 / 在读 / 已读）
 *
 * 解决的问题：Zotero 本身没有「这篇我读没读过」的状态。文献一多，
 * 只能靠记忆，或者自己手动打标签。
 *
 * 实现要点：
 *  · 状态存成**标签**（默认 `mzt/todo` `mzt/doing` `mzt/done`）。
 *    用标签而不是自建数据库，好处是它天然可搜索、可随 Zotero 同步、
 *    在标签选择器里能直接点选筛选——等于白送一套工作流。
 *  · 标签用稳定的 ASCII id 而不是中文，这样切换界面语言不会让已有状态失效；
 *    界面上显示的是本地化文案。
 *  · 给三个标签设了颜色，于是它们会出现在 Zotero 的彩色标签里，
 *    点一下就能高亮所有待读文献。
 *  · 列与右键菜单都走**官方插件 API**（ItemTreeManager / MenuManager），
 *    不做任何 monkey-patch，版本升级最不容易坏。
 */

import { config } from "../../package.json";
import { getPref } from "../utils/prefs";
import { getLocaleID, getString } from "../utils/locale";

/** 三种状态。id 会拼进标签名，必须保持稳定；显示名走 FTL。 */
export const READING_STATES = ["todo", "doing", "done"] as const;
export type ReadingState = (typeof READING_STATES)[number];

const COLUMN_DATA_KEY = "readingStatus";
const MENU_ID = `${config.addonRef}-reading-status-menu`;

/** 与 Zotero 彩色标签配套的颜色 */
const STATE_COLORS: Record<ReadingState, string> = {
  todo: "#d64c4c",
  doing: "#d9a13b",
  done: "#4c9a5a",
};

let columnKey: string | false = false;
/**
 * 注册菜单时返回的 key。
 * ⚠️ MenuManager 会把 id 变成 `CSS.escape(pluginID + "-" + menuID)` 再存，
 * `unregisterMenu()` 要的正是这个返回的 key；传原始 menuID 会注销失败
 * （Zotero 只会打一条 "Can't remove unknown option" 的日志，很难发现）。
 */
let menuKey: string | false = false;

export { register, unregister, getReadingState, setReadingState };

/* ------------------------------------------------------------------ */
/* 注册 / 注销                                                         */
/* ------------------------------------------------------------------ */

function register(): void {
  registerColumn();
  registerMenu();
}

function unregister(): void {
  if (columnKey) {
    Zotero.ItemTreeManager.unregisterColumn(columnKey);
    columnKey = false;
  }
  if (menuKey) {
    Zotero.MenuManager.unregisterMenu(menuKey);
    menuKey = false;
  }
}

function registerColumn(): void {
  if (columnKey) {
    return;
  }
  columnKey = Zotero.ItemTreeManager.registerColumn({
    dataKey: COLUMN_DATA_KEY,
    label: getString("column-reading-status"),
    pluginID: config.addonID,
    enabledTreeIDs: ["main"],
    width: "56",
    dataProvider: (item: Zotero.Item) => stateLabel(getReadingState(item)),
    zoteroPersist: ["width", "hidden", "sortDirection"],
  } as any);
}

function registerMenu(): void {
  if (menuKey) {
    return;
  }
  menuKey = Zotero.MenuManager.registerMenu({
    menuID: MENU_ID,
    pluginID: config.addonID,
    target: "main/library/item",
    menus: [
      {
        menuType: "submenu",
        // 菜单文案走主窗口的 document.l10n，所以 id 必须带插件前缀
        // （主窗口的 FTL 由 hooks.onMainWindowLoad 用 insertFTLIfNeeded 注入）
        l10nID: getLocaleID("menu-reading-status"),
        onShowing: (event: any) => {
          const element = event?.target as any;
          if (!element) {
            return;
          }
          // 功能关闭、或没有选中条目时，整个子菜单直接隐藏
          element.hidden = !isEnabled() || selectedRegularItems().length === 0;
        },
        menus: [
          ...READING_STATES.map((state) => ({
            menuType: "menuitem",
            l10nID: getLocaleID(`menu-reading-state-${state}`),
            onCommand: () => {
              void applyState(state);
            },
          })),
          {
            menuType: "menuitem",
            l10nID: getLocaleID("menu-reading-state-clear"),
            onCommand: () => {
              void applyState(null);
            },
          },
        ],
      },
    ],
  } as any);
  if (!menuKey) {
    Zotero.debug("[MyZoteroTools] 注册阅读状态菜单失败");
  }
}

function isEnabled(): boolean {
  return !!getPref("readingStatus.enabled");
}

/* ------------------------------------------------------------------ */
/* 状态读写                                                            */
/* ------------------------------------------------------------------ */

function tagPrefix(): string {
  return String(getPref("readingStatus.tagPrefix") ?? "") || "mzt/";
}

function tagName(state: ReadingState): string {
  return `${tagPrefix()}${state}`;
}

function stateLabel(state: ReadingState | null): string {
  return state ? getString(`reading-state-${state}` as any) : "";
}

/** 读出条目当前的阅读状态；三个标签同时存在时取优先级最高的那个 */
function getReadingState(
  item: Zotero.Item | null | undefined,
): ReadingState | null {
  if (!item) {
    return null;
  }
  try {
    const tags = new Set((item.getTags() ?? []).map((entry: any) => entry.tag));
    for (const state of READING_STATES) {
      if (tags.has(tagName(state))) {
        return state;
      }
    }
  } catch (e) {
    Zotero.debug(`[MyZoteroTools] 读取阅读状态失败: ${e}`);
  }
  return null;
}

/**
 * 设置阅读状态。传 null 表示清除标记。
 * 无论设成哪种状态，都会先把另外两个标签摘掉，保证同一篇最多只有一个状态。
 */
async function setReadingState(
  items: Zotero.Item[],
  state: ReadingState | null,
): Promise<number> {
  let changed = 0;
  for (const item of items) {
    if (!item || typeof item.getTags !== "function") {
      continue;
    }
    try {
      const existing = new Set(
        (item.getTags() ?? []).map((entry: any) => entry.tag),
      );
      let dirty = false;

      for (const other of READING_STATES) {
        const name = tagName(other);
        if (existing.has(name)) {
          item.removeTag(name);
          dirty = true;
        }
      }
      if (state) {
        const wanted = tagName(state);
        if (!existing.has(wanted)) {
          item.addTag(wanted);
          dirty = true;
        }
      }

      if (dirty) {
        await item.saveTx();
        changed++;
      }
    } catch (e) {
      Zotero.debug(`[MyZoteroTools] 设置阅读状态失败: ${e}`);
    }
  }

  if (changed) {
    await applyTagColors();
  }
  return changed;
}

/**
 * 给三个状态标签上色，这样它们会出现在 Zotero 的彩色标签里，
 * 在标签选择器中点一下就能高亮（Zotero 自带行为）。
 *
 * ⚠️ 两条必须遵守的约束（都是实测得出的，改动前请先读）：
 *
 * 1. **绝不重设已有颜色。** 彩色标签是**同步设置**（存在 `SyncedSettings` 的
 *    `tagColors` 里），每次写入都会触发同步。
 * 2. **绝不指定 position。** Zotero 把 position 当作**数字键 1-9 的键位**
 *    （`collectionViewItemTree.js:1966-1974`：按 1 就是 position 0 的那个标签）。
 *    而 `Tags.setColor` 在指定位置时是 `splice` **插入**（`data/tags.js:721`），
 *    会把用户已有的彩色标签往后挤 —— 例如把「双语已译」从键 1 挤到键 3。
 *    不传 position 时是 `push` 追加（`data/tags.js:716`），不会动到别人的键位。
 *
 * 另外彩色标签每库上限 9 个，所以这里只加 3 个、且只在缺失时加。
 */
async function applyTagColors(): Promise<void> {
  const libraryID = Zotero.Libraries.userLibraryID;
  let existing: Map<string, unknown>;
  try {
    existing = Zotero.Tags.getColors(libraryID) as Map<string, unknown>;
  } catch (e) {
    Zotero.debug(`[MyZoteroTools] 读取标签颜色失败，跳过上色: ${e}`);
    return;
  }

  for (const state of READING_STATES) {
    const name = tagName(state);
    if (existing.has(name)) {
      continue; // 已有颜色（可能被用户改过），不要动它
    }
    try {
      // 第 4 个参数 position 必须保持 undefined：
      // 传数字会 splice 插入并顶掉已有标签的键位（见上方说明）。
      // zotero-types 把它标成必填 number，但运行时允许 undefined
      // （data/tags.js:716 就是按 undefined 走 push 分支）。
      await (Zotero.Tags.setColor as any)(
        libraryID,
        name,
        STATE_COLORS[state],
        undefined,
      );
    } catch (e) {
      // 颜色只是锦上添花，失败不影响功能
      Zotero.debug(`[MyZoteroTools] 设置标签颜色失败 (${state}): ${e}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 菜单动作                                                            */
/* ------------------------------------------------------------------ */

function selectedRegularItems(): Zotero.Item[] {
  try {
    const pane = Zotero.getActiveZoteroPane() as any;
    const items: Zotero.Item[] = pane?.getSelectedItems?.() ?? [];
    return items.filter(
      (item) => item && (item.isRegularItem?.() || item.isNote?.()),
    );
  } catch (e) {
    Zotero.debug(`[MyZoteroTools] 读取选中条目失败: ${e}`);
    return [];
  }
}

async function applyState(state: ReadingState | null): Promise<void> {
  const items = selectedRegularItems();
  if (!items.length) {
    return;
  }
  const changed = await setReadingState(items, state);
  Zotero.debug(
    `[MyZoteroTools] 阅读状态 -> ${state ?? "清除"}，更新 ${changed} 条`,
  );
}
