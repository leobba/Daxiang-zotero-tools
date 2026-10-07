/**
 * 设置面板装配。
 *
 * 面板内容（顶部分类切换器 + 搜索框 + 各分类的设置项）全部在运行时按
 * registry.ts 的声明生成；静态的 preferences.xhtml 只是一个空壳
 * （外加注册 FTL 资源的 linkset）。
 *
 * 收益：**新增功能只需改 registry 声明**，不必碰界面代码；控件类型、
 * 分类切换、搜索过滤、pref 绑定都由框架统一处理。
 *
 * ⚠️ 时序：Zotero 的 `_loadPane()` 是**先执行 pane.scripts、后加载并插入面板片段**
 * （见 xpcom/preferencePanes.js 与 preferences/preferences.js 的 _loadPane）。
 * 所以本脚本启动时容器还不存在，必须等它出现再渲染。
 */

import { config } from "../../package.json";
import pkg from "../../package.json";
import { SETTINGS_CATEGORIES } from "./registry";
import { buildSetting, createPrefBinding, setL10n } from "./controls";
import { loadOptionIndex } from "./optionSources";
import type { PrefBinding } from "./controls";
import type { OptionIndex } from "./optionSources";
import type { OptionsSource, SettingCategory } from "./types";

export { renderPreferencesPane };

const ROOT_ID = `${config.addonRef}-preferences-root`;
const TABS_ID = `${config.addonRef}-preferences-tabs`;

interface RenderedCategory {
  id: string;
  el: Element;
  settings: Element[];
}

let renderedCategories: RenderedCategory[] = [];
/** 当前分类 id */
let activeCategoryId = "";
/** 是否正处于 Zotero 自带搜索状态（搜索期间要放开所有分类） */
let searching = false;
let tabsGroup: any = null;
/** 待绑定的控件；等元素插入文档、翻译完成后再 sync + enable（见下方说明） */
let pendingBindings: PrefBinding[] = [];

/**
 * 收集 registry 里声明过的动态选项来源（去重）。
 * 这样新增一个 `optionsSource` 时不需要再改 pane.ts。
 */
function collectOptionSources(): OptionsSource[] {
  const found = new Set<OptionsSource>();
  for (const category of SETTINGS_CATEGORIES) {
    for (const item of category.items ?? []) {
      if (item.optionsSource) {
        found.add(item.optionsSource);
      }
    }
  }
  return [...found];
}

async function renderPreferencesPane(win: Window): Promise<void> {
  const doc = win.document;
  const root = await waitForRoot(doc);
  if (!root) {
    Zotero.debug(`[MyZoteroTools] 未等到设置面板容器 #${ROOT_ID}`);
    return;
  }
  if (root.getAttribute("data-mzt-rendered") === "1") {
    return;
  }
  root.setAttribute("data-mzt-rendered", "1");

  const fragment = doc.createDocumentFragment();
  fragment.append(buildToolbar(doc));

  // 动态选项（如分类下拉）必须**在构建控件之前**异步取好 ——
  // Collections.getAllIDs 是异步的，而 buildSetting 是同步的。
  const dynamicOptions = await loadOptionIndex(collectOptionSources());

  const categoriesBox = createXUL(doc, "vbox");
  categoriesBox.setAttribute("id", `${config.addonRef}-preferences-categories`);
  renderedCategories = [];
  pendingBindings = [];
  for (const category of SETTINGS_CATEGORIES) {
    const built = buildCategory(doc, category, dynamicOptions);
    categoriesBox.append(built.el);
    renderedCategories.push(built);
  }
  fragment.append(categoriesBox);

  root.append(fragment);

  // FTL 资源是随面板片段一起注册的，此刻可能还没加载完；等待并重试一次。
  await translateAll(doc, root);
  win.setTimeout(() => {
    void translateAll(doc, root);
  }, 300);

  // 顺序很重要，别调换：
  //   1. 先 sync —— 把 pref 的值反映到界面（此时监听还是惰性的）
  //   2. 再 enable —— 界面就绪后才开始接受用户输入
  // 反过来会让程序化赋值触发的事件被当成用户输入，把默认值写坏。
  for (const binding of pendingBindings) {
    binding.sync();
  }
  for (const binding of pendingBindings) {
    binding.enable();
  }
  pendingBindings = [];

  // 与 Zotero 设置窗口顶部自带的搜索协作（本面板不再自己造搜索框）
  bindNativeSearch(doc);

  activeCategoryId = initialCategoryId();
  showCategory(activeCategoryId);
  Zotero.debug("[MyZoteroTools] 设置面板已渲染");
}

/**
 * 首次显示哪个分类。
 * 开发时可用 dev.initialCategory 首选项直接跳到正在调的那一页，
 * 省去每次手点（见 addon/prefs.js 的说明）。
 */
function initialCategoryId(): string {
  const fallback = SETTINGS_CATEGORIES[0]?.id ?? "";
  try {
    const wanted = String(
      Zotero.Prefs.get(`${config.prefsPrefix}.dev.initialCategory`, true) ?? "",
    );
    if (wanted && SETTINGS_CATEGORIES.some((c) => c.id === wanted)) {
      return wanted;
    }
  } catch {
    // 首选项不存在时用默认值即可
  }
  return fallback;
}

/* ------------------------------------------------------------------ */
/* 顶部工具栏                                                          */
/* ------------------------------------------------------------------ */

function buildToolbar(doc: Document): Element {
  const row = createXUL(doc, "hbox");
  row.setAttribute("align", "center");
  row.classList.add("mzt-toolbar");

  // 分类切换：Zotero 原生偏好面板里「多选一」用的就是水平 radiogroup
  tabsGroup = createXUL(doc, "radiogroup");
  tabsGroup.setAttribute("orient", "horizontal");
  tabsGroup.setAttribute("id", TABS_ID);
  tabsGroup.classList.add("mzt-tabs");

  for (const category of SETTINGS_CATEGORIES) {
    const radio = createXUL(doc, "radio");
    radio.setAttribute("value", category.id);
    radio.classList.add("mzt-tab");
    setL10n(radio, category.tabKey);
    tabsGroup.append(radio);
  }

  tabsGroup.addEventListener("command", (event: Event) => {
    const value = (event.target as any)?.value;
    if (value) {
      // 用户主动切分类时，如果 Zotero 的搜索还开着就先清掉它，
      // 否则两边对「显示哪些分类」的判断会打架。
      clearNativeSearch(doc);
      showCategory(value);
    }
  });

  // 这里**不放搜索框**：Zotero 设置窗口顶部自带一个（`#prefs-search`），
  // 而且它本来就会加载并搜索全部面板（preferences.js:677-686 的 _search
  // 会 _loadPane + _showPane 所有顶层 pane）。再加一个就是重复的入口。
  row.append(tabsGroup);
  return row;
}

/* ------------------------------------------------------------------ */
/* 与 Zotero 自带搜索的协作                                            */
/* ------------------------------------------------------------------ */

/**
 * 让本面板配合 Zotero 设置窗口顶部的搜索。
 *
 * 冲突点：Zotero 的搜索靠 `hidden-by-search` 类来隐藏不匹配的区块，
 * 并且会先把**所有**顶层面板显示出来；而本面板的分类切换器会给
 * 非当前分类加 `hidden`。两边同时生效时，别的分类里的匹配项会被我们的
 * `hidden` 挡住 —— 搜索就「搜不到」了。
 *
 * 做法：监听 `#prefs-search`，搜索期间把所有分类都放开，清空后再收回当前分类。
 */
function bindNativeSearch(doc: Document): void {
  const field = doc.getElementById("prefs-search") as any;
  if (!field) {
    return;
  }
  const sync = () => {
    const term = String(field.value ?? "").trim();
    if (term) {
      revealAllCategories();
    } else {
      showCategory(activeCategoryId || (SETTINGS_CATEGORIES[0]?.id ?? ""));
    }
  };
  field.addEventListener("command", sync);
  field.addEventListener("input", sync);
}

/** 搜索期间放开全部分类（不改 hidden-by-search，那由 Zotero 管） */
function revealAllCategories() {
  searching = true;
  for (const category of renderedCategories) {
    setHidden(category.el, false);
    for (const setting of category.settings) {
      setHidden(setting, false);
    }
  }
}

function clearNativeSearch(doc: Document) {
  const field = doc.getElementById("prefs-search") as any;
  if (field?.value) {
    field.value = "";
    field.dispatchEvent(
      new (doc.defaultView as any).Event("command", { bubbles: true }),
    );
  }
  searching = false;
}

/* ------------------------------------------------------------------ */
/* 分类内容                                                            */
/* ------------------------------------------------------------------ */

function buildCategory(
  doc: Document,
  category: SettingCategory,
  dynamicOptions?: OptionIndex,
): RenderedCategory {
  const section = createXUL(doc, "vbox");
  section.classList.add("main-section");
  section.setAttribute("id", `${config.addonRef}-category-${category.id}`);
  section.setAttribute("data-mzt-category", category.id);

  const groupbox = createXUL(doc, "groupbox");

  // 不在这里再放一个分类标题：顶部的切换器已经写着分类名了，重复显示反而累赘。
  if (category.introKey) {
    const intro = createXUL(doc, "description");
    intro.classList.add("mzt-pref-intro");
    setL10n(intro, category.introKey);
    groupbox.append(intro);
  }

  const settings: Element[] = [];
  for (const item of category.items ?? []) {
    const built = buildSetting(doc, item, dynamicOptions);
    // 绑定推迟到插入文档 + 翻译完成之后执行
    pendingBindings.push(createPrefBinding(built.control, item));
    groupbox.append(built.el);
    settings.push(built.el);
  }

  for (const note of category.notes ?? []) {
    const desc = createXUL(doc, "description");
    desc.classList.add("mzt-pref-desc");
    setL10n(desc, note.key, note.args);
    groupbox.append(desc);
  }

  if (category.showVersion) {
    const version = createXUL(doc, "description");
    version.classList.add("mzt-pref-version");
    setL10n(version, "settings-version", { version: pkg.version });
    groupbox.append(version);
  }

  section.append(groupbox);
  return { id: category.id, el: section, settings };
}

/* ------------------------------------------------------------------ */
/* 切换与搜索                                                          */
/* ------------------------------------------------------------------ */

function showCategory(id: string) {
  activeCategoryId = id;
  if (tabsGroup) {
    tabsGroup.value = id;
  }
  // 搜索期间不要收回分类，否则会把别的分类里的匹配项藏起来
  if (searching) {
    return;
  }
  for (const category of renderedCategories) {
    const isActive = category.id === id;
    setHidden(category.el, !isActive);
    if (isActive) {
      for (const setting of category.settings) {
        setHidden(setting, false);
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function createXUL(doc: Document, tag: string): Element {
  return (doc as any).createXULElement(tag) as Element;
}

/** 统一处理 XUL / HTML 元素的显示与隐藏 */
function setHidden(el: Element, hidden: boolean): void {
  (el as any).hidden = hidden;
}

/** 面板片段是异步插入的，这里等容器出现（最长 5 秒，避免无限等待） */
function waitForRoot(doc: Document): Promise<Element | null> {
  const existing = doc.getElementById(ROOT_ID);
  if (existing) {
    return Promise.resolve(existing);
  }
  return new Promise((resolve) => {
    const timer = (doc.defaultView ?? window).setTimeout;
    const observer = new MutationObserver(() => {
      const el = doc.getElementById(ROOT_ID);
      if (el) {
        observer.disconnect();
        resolve(el);
      }
    });
    const rootNode = doc.documentElement;
    if (!rootNode) {
      resolve(null);
      return;
    }
    observer.observe(rootNode, { childList: true, subtree: true });
    timer(() => {
      observer.disconnect();
      resolve(doc.getElementById(ROOT_ID));
    }, 5000);
  });
}

async function translateAll(doc: Document, root: Element) {
  const l10n = (doc as any).l10n;
  if (!l10n) {
    return;
  }
  try {
    if (l10n.ready) {
      await l10n.ready;
    }
  } catch {
    // 忽略：继续尝试翻译
  }
  const nodes = Array.from(
    root.querySelectorAll("[data-l10n-id]"),
  ) as Element[];
  if (!nodes.length) {
    return;
  }
  try {
    await l10n.translateElements(nodes);
  } catch (e) {
    Zotero.debug(`[MyZoteroTools] 设置面板本地化失败: ${e}`);
  }
}
