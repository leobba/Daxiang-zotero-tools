/**
 * 动态选项的来源实现。
 *
 * registry 里只写「来源名」（如 `optionsSource: "collections"`），
 * 真正的取数逻辑放在这里。这样 registry 保持纯声明，测试也能直接遍历比对。
 *
 * ⚠️ 必须异步加载：`Collections.getAllIDs()` 返回 Promise。
 * 而 `buildSetting` 是同步的，所以由 pane.ts 在渲染前调 `loadOptionIndex()`
 * 一次性把所有来源的选项都取好，再传给每个控件。
 *
 * ⚠️ 必须用 `getAllIDs` + `getAsync`，**不能用 `getByLibrary`** ——
 * 后者只返回内存缓存里的分类（库体检曾因此只看到 31 个分类里的 16 个）。
 */

import { config } from "../../package.json";
import type { DynamicOption, OptionsSource } from "./types";

export { loadOptionIndex, collectionOptions, EMPTY_OPTION_VALUE };
export type { OptionIndex };

/** 「不使用」选项的值。留空字符串，与 pref 的默认值一致 */
const EMPTY_OPTION_VALUE = "";

type OptionIndex = Partial<Record<OptionsSource, DynamicOption[]>>;

/**
 * 一次性加载 registry 里用到的所有动态选项来源。
 * @param sources 需要加载的来源名；不传则加载全部
 */
async function loadOptionIndex(
  sources: OptionsSource[] = ["collections"],
): Promise<OptionIndex> {
  const index: OptionIndex = {};
  for (const source of sources) {
    try {
      index[source] = await loadOne(source);
    } catch (e) {
      Zotero.debug(`[MyZoteroTools] 加载动态选项「${source}」失败: ${e}`);
      index[source] = [];
    }
  }
  return index;
}

async function loadOne(source: OptionsSource): Promise<DynamicOption[]> {
  switch (source) {
    case "collections":
      return collectionOptions();
    default:
      return [];
  }
}

/**
 * 列出所有**存活**分类，标签用完整路径（如「农药 / 除草剂」）。
 *
 * 为什么用路径当标签：库里有同名分类时（复制分类树之后很常见），
 * 只显示名字根本分不清是哪个。
 *
 * 为什么值用 **key** 而不是名字：key 稳定，分类改名后设置依然有效；
 * 而按名字解析在存在同名分类时可能选错。
 */
async function collectionOptions(): Promise<DynamicOption[]> {
  const libraryID = Zotero.Libraries.userLibraryID;
  const ids: number[] = await (Zotero.Collections as any).getAllIDs(libraryID);
  const all = ((await (Zotero.Collections as any).getAsync(ids)) ?? []).filter(
    (collection: any) => collection && !collection.deleted,
  );

  const byID = new Map<number, any>(all.map((c: any) => [c.id, c]));

  /** 拼出从顶层到该分类的完整路径 */
  const pathOf = (collection: any): string => {
    const chain: string[] = [];
    let current = collection;
    let guard = 0;
    while (current && guard++ < 50) {
      chain.unshift(String(current.name ?? ""));
      current = current.parentID ? byID.get(current.parentID) : null;
    }
    return chain.filter(Boolean).join(" / ");
  };

  interface SortableOption extends DynamicOption {
    sortKey: string;
  }

  const options: DynamicOption[] = all
    .map((collection: any): SortableOption => {
      const label = pathOf(collection);
      return {
        value: String(collection.key ?? ""),
        label,
        // 排序用，最后删掉
        sortKey: label.toLowerCase(),
      };
    })
    .filter((option: SortableOption) => option.value && option.label)
    .sort((a: SortableOption, b: SortableOption) =>
      a.sortKey.localeCompare(b.sortKey, "zh"),
    )
    .map((option: SortableOption) => ({
      value: option.value,
      label: option.label,
    }));

  // 第一项是「不使用」，让用户能清空设置
  return [{ value: EMPTY_OPTION_VALUE, label: "" }, ...options];
}

/** 供测试与调试使用：把 registry 里声明过的来源都列出来 */
export function declaredSources(): string[] {
  void config;
  return ["collections"];
}
