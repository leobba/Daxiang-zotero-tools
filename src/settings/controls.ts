/**
 * 根据描述符生成 Zotero 原生风格的控件，并完成 pref 双向绑定与本地化。
 *
 * 这里刻意使用 Zotero 自己在偏好面板里用的那套元素与属性，
 * 视觉上就与原生面板完全一致：
 *   · checkbox 加 native="true" 才会套用 Zotero 原生勾选图标与悬停/按下态
 *   · textbox / menulist / description 都由皮肤统一美化
 *   · 说明文字用 description + .mzt-pref-desc（见 content/preferences.css）
 *
 * 关于 pref 绑定：Zotero 只会在面板片段**插入那一刻**扫描一次 `preference` 属性
 * （preferences.js 的 _initImportedNodesPostInsert），而我们的控件是之后动态生成的，
 * 所以这里手动复刻同一套语义：读值初始化 + 监听事件写回 + 监听外部改动同步回界面。
 */

import { config } from "../../package.json";
import { getLocaleID } from "../utils/locale";
import type { FluentMessageId } from "../../typings/i10n";
import type { DynamicOption, SettingDescriptor } from "./types";
import type { OptionIndex } from "./optionSources";

export interface BuiltSetting {
  /** 外层容器；搜索过滤以它为最小显示单位 */
  el: Element;
  /** 真正承载取值/赋值的控件 */
  control: Element;
  descriptor: SettingDescriptor;
}

export { buildSetting, createPrefBinding, setL10n };

/* ------------------------------------------------------------------ */
/* 构建                                                                */
/* ------------------------------------------------------------------ */

/**
 * @param dynamicOptions 动态选项（如分类列表）。由 pane.ts 在渲染前异步加载好传进来 ——
 *   因为 `Collections.getAllIDs()` 是异步的，而本函数是同步的。
 */
function buildSetting(
  doc: Document,
  item: SettingDescriptor,
  dynamicOptions?: OptionIndex,
): BuiltSetting {
  const wrap = createXUL(doc, "vbox");
  wrap.classList.add("mzt-setting");
  wrap.setAttribute("data-mzt-key", String(item.key));

  let control: Element;
  switch (item.kind) {
    case "checkbox":
      control = buildCheckbox(doc, item);
      wrap.append(control);
      break;
    case "menulist":
      control = buildMenulist(doc, item, dynamicOptions);
      wrap.append(buildLabelledRow(doc, item, control));
      break;
    default:
      control = buildTextbox(doc, item);
      wrap.append(buildLabelledRow(doc, item, control));
      break;
  }

  if (item.descKey) {
    const desc = createXUL(doc, "description");
    desc.classList.add("mzt-pref-desc");
    setL10n(desc, item.descKey);
    // 说明与控件关联，便于无障碍读屏，也与原生面板写法一致
    const controlId = control.getAttribute("id");
    if (controlId) {
      desc.setAttribute("id", `${controlId}-desc`);
      control.setAttribute("aria-describedby", `${controlId}-desc`);
    }
    wrap.append(desc);
  }

  return { el: wrap, control, descriptor: item };
}

function buildCheckbox(doc: Document, item: SettingDescriptor): Element {
  const box = createXUL(doc, "checkbox");
  box.setAttribute("id", controlId(item));
  // native="true" 是拿到 Zotero 原生复选框外观的关键
  box.setAttribute("native", "true");
  setL10n(box, item.labelKey);
  return box;
}

function buildTextbox(doc: Document, item: SettingDescriptor): Element {
  const box = createXUL(doc, "textbox");
  box.setAttribute("id", controlId(item));
  if (item.kind === "number") {
    box.setAttribute("type", "number");
    if (item.min !== undefined) {
      box.setAttribute("min", String(item.min));
    }
    if (item.max !== undefined) {
      box.setAttribute("max", String(item.max));
    }
  }
  if (item.placeholderKey) {
    setL10n(box, item.placeholderKey, undefined, "placeholder");
  }
  box.classList.add("mzt-control-input");
  return box;
}

function buildMenulist(
  doc: Document,
  item: SettingDescriptor,
  dynamicOptions?: OptionIndex,
): Element {
  const list = createXUL(doc, "menulist");
  list.setAttribute("id", controlId(item));
  const popup = createXUL(doc, "menupopup");

  // 静态选项（options）与动态选项（optionsSource）二选一
  if (item.optionsSource) {
    const options: DynamicOption[] = dynamicOptions?.[item.optionsSource] ?? [];
    for (const option of options) {
      const menuItem = createXUL(doc, "menuitem");
      menuItem.setAttribute("value", option.value);
      // 分类名是用户数据，没有 FTL key，直接写 label 属性
      menuItem.setAttribute("label", option.label);
      popup.append(menuItem);
    }
    if (!options.length) {
      // 一个分类都没有时给个占位，避免出现完全空的下拉
      const menuItem = createXUL(doc, "menuitem");
      menuItem.setAttribute("value", "");
      menuItem.setAttribute("label", "");
      menuItem.setAttribute("disabled", "true");
      popup.append(menuItem);
    }
  } else {
    for (const option of item.options ?? []) {
      const menuItem = createXUL(doc, "menuitem");
      menuItem.setAttribute("value", option.value);
      setL10n(menuItem, option.labelKey);
      popup.append(menuItem);
    }
  }

  list.append(popup);
  return list;
}

/** 左侧标签 + 右侧控件的横排（Zotero 原生面板里设置项就是这么排的） */
function buildLabelledRow(
  doc: Document,
  item: SettingDescriptor,
  control: Element,
): Element {
  const row = createXUL(doc, "hbox");
  row.setAttribute("align", "center");
  row.classList.add("mzt-setting-row");

  const label = createXUL(doc, "label");
  label.setAttribute("control", controlId(item));
  label.classList.add("mzt-setting-label");
  setL10n(label, item.labelKey);

  row.append(label, control);
  return row;
}

function controlId(item: SettingDescriptor): string {
  return `zotero-prefpane-${config.addonRef}-${String(item.key).replace(/\./g, "-")}`;
}

/* ------------------------------------------------------------------ */
/* pref 双向绑定                                                       */
/* ------------------------------------------------------------------ */

/**
 * 一条设置项与 pref 的绑定。
 *
 * ⚠️ 必须分两步用，否则会写坏首选项：
 * 程序化地设置 `menulist.value` / `checkbox.checked` 会**触发 change/command 事件**，
 * 如果此时已经挂了「写回 pref」的监听，这些事件会被误当成用户输入，
 * 把默认值覆盖掉（真实踩过：默认 emptyOnly 被写成了 always）。
 *
 * 正确顺序是 sync() → 等翻译完成 → enable()：
 *   · sync()   只把 pref 的值反映到界面，此时监听是惰性的
 *   · enable() 在界面完全就绪后才开始接受用户输入
 */
export interface PrefBinding {
  sync: () => void;
  enable: () => void;
}

function createPrefBinding(
  control: Element,
  descriptor: SettingDescriptor,
): PrefBinding {
  const pref = fullPrefKey(descriptor);
  let accepting = false;

  const sync = () => syncFromPref(control, descriptor);

  const write = () => {
    if (!accepting) {
      return;
    }
    const next = readControlValue(control, descriptor);
    // 值没变就不写，避免无意义的写入与事件回环
    if (next === Zotero.Prefs.get(pref, true)) {
      return;
    }
    Zotero.Prefs.set(pref, next, true);
  };

  // checkbox / menulist 走 command，输入框在提交时走 change（与 Zotero 自身一致）
  control.addEventListener("command", write);
  control.addEventListener("change", write);

  // 外部（about:config 或另一个窗口）改动时同步回界面
  try {
    Zotero.Prefs.registerObserver(pref, sync, true);
  } catch (e) {
    Zotero.debug(`[MyZoteroTools] 注册 pref 观察者失败 (${pref}): ${e}`);
  }

  return {
    sync,
    enable: () => {
      accepting = true;
    },
  };
}

function fullPrefKey(descriptor: SettingDescriptor): string {
  return `${config.prefsPrefix}.${String(descriptor.key)}`;
}

function readControlValue(
  control: Element,
  descriptor: SettingDescriptor,
): boolean | number | string {
  const node = control as any;
  switch (descriptor.kind) {
    case "checkbox":
      return !!node.checked;
    case "number": {
      const n = Number(node.value);
      return Number.isFinite(n) ? n : 0;
    }
    default:
      return String(node.value ?? "");
  }
}

function syncFromPref(control: Element, descriptor: SettingDescriptor): void {
  const node = control as any;
  const value = Zotero.Prefs.get(fullPrefKey(descriptor), true);

  if (descriptor.kind === "checkbox") {
    node.checked = !!value;
    return;
  }

  const next = value === undefined || value === null ? "" : String(value);
  if (descriptor.kind === "menulist") {
    node.value = next;
    // 某些情况下 menulist 只在选项已存在时才会刷新显示文本
    const item = Array.from(node.querySelectorAll("menuitem")).find(
      (el: any) => el.getAttribute("value") === next,
    );
    if (item) {
      node.selectedItem = item;
    }
    return;
  }

  if (node.value !== next) {
    node.value = next;
  }
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

/**
 * 设置 Fluent 消息。
 * @param attr 要把文案写进哪个属性（默认 data-l10n-id 由 Fluent 按约定写入）；
 *             传 "placeholder" 时使用 data-l10n-attrs 覆盖写入属性。
 */
function setL10n(
  el: Element,
  key: string,
  args?: Record<string, string>,
  attr?: string,
): void {
  el.setAttribute("data-l10n-id", getLocaleID(key as FluentMessageId));
  if (args) {
    el.setAttribute("data-l10n-args", JSON.stringify(args));
  }
  if (attr) {
    el.setAttribute("data-l10n-attrs", attr);
  }
}

function createXUL(doc: Document, tag: string): Element {
  return (doc as any).createXULElement(tag) as Element;
}
