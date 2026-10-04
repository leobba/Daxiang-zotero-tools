/**
 * 功能四：条目列表「来源子分类」列
 *
 * 这是四个功能里唯一使用**官方插件 API** 的一个：
 * `Zotero.ItemTreeManager.registerColumn()`（Zotero 7+ 起提供，
 * 见 chrome/content/zotero/xpcom/pluginAPI/itemTreeManager.js）。
 * 官方 API 会自动处理 dataKey 前缀防冲突、卸载时清理、列宽持久化，
 * 不需要 monkey-patch，风险最低。
 *
 * 作用：当你在父分类里看到聚合出来的条目时，一眼就能知道
 * 每条文献实际上属于哪个二级分类。
 */

import { config } from "../../package.json";
import { getPref } from "../utils/prefs";
import { getString } from "../utils/locale";

/** 分隔符默认值，与 addon/prefs.js 里的 sourceColumn.separator 保持一致 */
const DEFAULT_SEPARATOR = " · ";

let registeredDataKey: string | false = false;

/** 当前选中分类的后代集合缓存（id -> 名称） */
let descendantCacheKey = "";
let descendantCache = new Map<number, string>();

export { register, unregister };

function register() {
  if (registeredDataKey) {
    return registeredDataKey;
  }

  registeredDataKey = Zotero.ItemTreeManager.registerColumn({
    dataKey: "sourceCollection",
    label: getString("column-source-collection"),
    pluginID: config.addonID,
    enabledTreeIDs: ["main"],
    width: "150",
    dataProvider: (item, _dataKey) => getSourceCollectionLabel(item),
    zoteroPersist: ["width", "hidden", "sortDirection"],
  });

  if (registeredDataKey) {
    Zotero.debug(`[MyZoteroTools] 已注册列: ${registeredDataKey}`);
  } else {
    Zotero.debug("[MyZoteroTools] 注册「来源子分类」列失败");
  }
  return registeredDataKey;
}

function unregister() {
  if (!registeredDataKey) {
    return;
  }
  Zotero.ItemTreeManager.unregisterColumn(registeredDataKey);
  registeredDataKey = false;
}

/**
 * 数据提供者：返回该条目所属的、位于当前选中范围之下的子分类名。
 */
function getSourceCollectionLabel(item: Zotero.Item): string {
  if (!getPref("sourceColumn.enabled")) {
    return "";
  }

  const descendants = getSelectedDescendants();
  if (!descendants.size) {
    return "";
  }

  const names: string[] = [];
  try {
    for (const collectionID of item.getCollections()) {
      const name = descendants.get(collectionID);
      if (name) {
        names.push(name);
      }
    }
  } catch (e) {
    Zotero.debug(`[MyZoteroTools] 读取条目所属分类失败: ${e}`);
    return "";
  }

  // 分隔符由设置面板里的「多个来源之间的分隔符」决定，留空则用默认值
  const separator =
    String(getPref("sourceColumn.separator") ?? "") || DEFAULT_SEPARATOR;
  return names.join(separator);
}

/**
 * 计算当前选中分类下所有后代分类的 id -> 名称映射，并按选择结果缓存。
 */
function getSelectedDescendants(): Map<number, string> {
  const collections: any[] = (() => {
    try {
      const pane = Zotero.getMainWindow()?.ZoteroPane as any;
      // Zotero 10 的单数 getter 会抛异常，必须用复数版本
      const rows: any[] = pane?.getCollectionTreeRows?.() ?? [];
      return rows
        .filter((row) => row?.isCollection?.())
        .map((row) => row.ref)
        .filter(Boolean);
    } catch (e) {
      Zotero.debug(`[MyZoteroTools] 读取当前选中分类失败: ${e}`);
      return [];
    }
  })();
  if (!collections.length) {
    return new Map();
  }

  const key = collections.map((c) => c.id).join(",");
  if (key === descendantCacheKey) {
    return descendantCache;
  }

  const map = new Map<number, string>();
  for (const collection of collections) {
    let descendants: any[] = [];
    try {
      descendants = collection.getDescendents?.(false, "collection") ?? [];
    } catch (e) {
      Zotero.debug(`[MyZoteroTools] 读取子分类失败: ${e}`);
    }
    for (const descendant of descendants) {
      map.set(descendant.id, descendant.name);
    }
  }

  descendantCacheKey = key;
  descendantCache = map;
  return map;
}
