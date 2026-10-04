/**
 * 功能一：按需智能递归
 *
 * 背景（已在 Zotero 10.0.5 源码中核实）：
 *   选中分类时，Zotero 通过 `Zotero.CollectionTreeRow.prototype.getSearchObject()`
 *   构造检索条件（xpcom/collectionTreeRow.js:406），其中只有
 *     `collectionID is <该分类>`  —— 仅匹配直属该分类的条目
 *   再加上一个受全局开关控制的递归条件：
 *     `extensions.zotero.recursiveCollections`（默认 false，见 defaults/preferences/zotero.js:1616）
 *
 *   因此当某个一级分类本身没有直属条目、文献全挂在二级分类下时，选中它就只能是空列表。
 *   这不是 bug，是 Zotero 的默认语义。
 *
 * 本功能做的事：
 *   对「没有直属条目、但有子分类」的分类，在**显示用**的检索里补上 `recursive` 条件，
 *   使其聚合子分类的条目；对有直属条目的分类（例如本例中的「机器学习」）保持原样，
 *   不被子分类条目污染。这比 Zotero 自带的全局开关粒度更细。
 *
 * 实现方式（为什么这样写）：
 *   - `Zotero.Search.prototype.scope` 是公开 getter（xpcom/data/search.js:100-101），
 *     而 `conditions` 也是公开 getter（同文件 97-99）。所以我们可以拿到
 *     getSearchObject() 返回的检索对象、沿 scope 链找到持有 `collectionID` 的那一层，
 *     直接 `addCondition('recursive', 'true')`——完全复用 Zotero 自身逻辑，
 *     **不需要临时改全局 pref**（改 pref 会触发 itemTree.js:992 的观察者刷新）。
 *   - 用 WeakSet 记录已注入过的检索对象，保证幂等，避免缓存对象被重复加条件。
 *   - 只处理「显示用」的调用（options.unfiltered 为假）。Zotero 内部用于拖拽、
 *     "从分类中移除条目" 等场景的 unfiltered 查询保持默认语义，因此本插件只改变
 *     你**看到**的内容，不改变条目的真实归属与增删行为。
 */

import { getPref } from "../utils/prefs";

/** 决策缓存有效期（毫秒）——防止频繁切分类时反复查库 */
const CACHE_TTL = 5000;

interface SearchLike {
  conditions?: Record<string, { condition?: string } | undefined>;
  scope?: SearchLike | null;
  addCondition: (condition: string, operator: string, value?: unknown) => void;
}

interface CollectionLike {
  id: number;
  getDescendents?: (
    includeParent: boolean,
    type: string,
  ) => Array<{ id: number }>;
}

interface RowLike {
  type?: string;
  ref?: CollectionLike;
  _cachedSearch?: SearchLike | null;
}

/** 已注入过 recursive 的检索对象，保证幂等 */
const injected = new WeakSet<object>();

const directCountCache = new Map<number, { count: number; at: number }>();
const aggregateCache = new Map<number, { aggregate: boolean; at: number }>();

let installed = false;
let original:
  ((options?: { unfiltered?: boolean }) => Promise<unknown>) | null = null;

export { install, uninstall, clearCaches };

function install() {
  if (installed) {
    return;
  }
  const Ctor = (Zotero as any).CollectionTreeRow;
  if (typeof Ctor?.prototype?.getSearchObject !== "function") {
    Zotero.debug(
      "[MyZoteroTools] 未找到 CollectionTreeRow.getSearchObject，智能递归未启用",
    );
    return;
  }

  original = Ctor.prototype.getSearchObject;
  Ctor.prototype.getSearchObject = async function (
    this: RowLike,
    options: { unfiltered?: boolean } = {},
  ) {
    const call = original!.bind(this);

    // 关闭 / 非分类行 / Zotero 内部的未过滤查询 —— 一律不干预
    const mode = getSmartRecursionMode();
    if (mode === "off") {
      return call(options);
    }
    if (this?.type !== "collection" || options.unfiltered) {
      return call(options);
    }

    // 「所有分类」= 相当于打开 Zotero 自带的全局开关；这一模式不做按需判定
    const want = mode === "always" ? true : await shouldAggregate(this);
    const cached = this._cachedSearch;

    // 之前注入过、现在不该聚合了（例如你往父分类里直接加了条目）：
    // 清掉 Zotero 的检索缓存，让它重建一个干净的检索对象。
    if (!want && cached && injected.has(cached)) {
      this._cachedSearch = null;
    }

    const search = (await call(options)) as SearchLike | null;
    if (want && search) {
      injectRecursive(search);
    }
    return search;
  };

  installed = true;
  Zotero.debug("[MyZoteroTools] 智能递归已启用");
}

function uninstall() {
  if (!installed || !original) {
    return;
  }
  const Ctor = (Zotero as any).CollectionTreeRow;
  if (Ctor?.prototype) {
    Ctor.prototype.getSearchObject = original;
  }
  installed = false;
  original = null;
  clearCaches();
  Zotero.debug("[MyZoteroTools] 智能递归已停用");
}

function clearCaches() {
  directCountCache.clear();
  aggregateCache.clear();
}

/**
 * 沿 scope 链找到持有 collectionID 条件的那一层检索，给它加上 recursive 条件。
 * @returns 是否成功注入
 */
/**
 * 判断条件是否为「限定在某个分类内」的条件。
 *
 * 注意：Zotero 里 `collectionID` 只是「快捷条件」（searchConditions.js:271，noLoad: true），
 * 调用 addCondition('collectionID', ...) 后，存储下来的规范名称是 `collection`
 * （searchConditions.js:295，table: 'collectionItems', field: 'collectionID'）。
 * 两个名字都要认，否则会漏判。
 */
const COLLECTION_CONDITION_NAMES = ["collection", "collectionID"];

function isCollectionCondition(condition?: string): boolean {
  return !!condition && COLLECTION_CONDITION_NAMES.includes(condition);
}

function injectRecursive(search: SearchLike | null | undefined): boolean {
  let node: SearchLike | null | undefined = search;
  while (node) {
    const conditions = node.conditions;
    if (conditions) {
      const list = Object.values(conditions);
      if (list.some((c) => isCollectionCondition(c?.condition))) {
        // 若 Zotero 自带的全局开关（extensions.zotero.recursiveCollections）已打开，
        // 条件已经存在，此时不能再加一次，否则会产生重复条件。
        const hasRecursive = list.some((c) => c?.condition === "recursive");
        if (!hasRecursive) {
          node.addCondition("recursive", "true");
        }
        injected.add(node);
        return true;
      }
    }
    node = node.scope;
  }
  return false;
}

/**
 * 是否该对这个分类做聚合：没有直属条目、且存在子分类。
 */
async function shouldAggregate(row: RowLike): Promise<boolean> {
  const collection = row.ref;
  if (!collection || typeof collection.id !== "number") {
    return false;
  }
  const id = collection.id;

  const cached = aggregateCache.get(id);
  if (cached && Date.now() - cached.at < CACHE_TTL) {
    return cached.aggregate;
  }

  const aggregate = await (async () => {
    try {
      const hasDirectItems = (await getDirectItemCount(id)) > 0;
      return !hasDirectItems && getDescendantCollections(collection).length > 0;
    } catch (e) {
      Zotero.debug(`[MyZoteroTools] 判断分类 ${id} 是否聚合时出错: ${e}`);
      return false;
    }
  })();

  aggregateCache.set(id, { aggregate, at: Date.now() });
  return aggregate;
}

/** 该分类的直属条目数（走 Zotero 自己的 collectionItems 表，只取计数、不加载条目） */
async function getDirectItemCount(collectionID: number): Promise<number> {
  const cached = directCountCache.get(collectionID);
  if (cached && Date.now() - cached.at < CACHE_TTL) {
    return cached.count;
  }

  const count = await (async () => {
    try {
      return Number(
        await Zotero.DB.valueQueryAsync(
          "SELECT COUNT(*) FROM collectionItems WHERE collectionID = ?",
          collectionID,
        ),
      );
    } catch (e) {
      // 兜底：万一表结构变化，退回对象 API
      Zotero.debug(`[MyZoteroTools] 计数查询失败，回退对象 API: ${e}`);
      const collection = Zotero.Collections.get(collectionID) as any;
      const items = (await collection?.getChildItems?.(true)) ?? [];
      return items.length;
    }
  })();

  directCountCache.set(collectionID, { count, at: Date.now() });
  return count;
}

/** 该分类的全部后代分类（不包含自己） */
function getDescendantCollections(
  collection: CollectionLike,
): CollectionLike[] {
  try {
    return collection.getDescendents?.(false, "collection") ?? [];
  } catch (e) {
    Zotero.debug(`[MyZoteroTools] 读取子分类失败: ${e}`);
    return [];
  }
}

/** 聚合方式，取值与 src/settings/registry.ts 里 menulist 的选项一致 */
export type SmartRecursionMode = "emptyOnly" | "always" | "off";

/** 读取聚合方式；取值异常时回落到最保守的 emptyOnly */
export function getSmartRecursionMode(): SmartRecursionMode {
  const value = getPref("smartRecursion.mode") as string;
  return value === "always" || value === "off" ? value : "emptyOnly";
}

/**
 * 供提示条模块复用的聚合判定（走同一份缓存，并尊重当前的聚合方式）。
 */
export async function isAggregating(row: unknown): Promise<boolean> {
  const mode = getSmartRecursionMode();
  if (mode === "off") {
    return false;
  }
  if (mode === "always") {
    return (row as RowLike)?.type === "collection";
  }
  return shouldAggregate(row as RowLike);
}
