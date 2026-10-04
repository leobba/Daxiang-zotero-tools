/**
 * 设置框架的类型定义。
 *
 * 设计目标：**新增功能时只改声明，不写界面代码**。
 * 每个设置项在这里被描述一次（绑定哪个 pref、用哪种控件、文案用哪个 FTL key），
 * 界面由 settings/pane.ts 在面板加载时生成，原生控件样式与 pref 双向绑定
 * 都由框架统一处理。
 */

import type { FluentMessageId } from "../../typings/i10n";

/** 设置项绑定的首选项键（相对 prefsPrefix），由 addon/prefs.js 经构建生成类型 */
export type SettingKey = keyof _ZoteroTypes.Prefs["PluginPrefsMap"];

/** 支持的控件类型 */
export type SettingKind = "checkbox" | "text" | "number" | "menulist";

/** menulist 的一个选项 */
export interface SettingOption {
  value: string;
  labelKey: FluentMessageId;
}

/** 单个设置项 */
export interface SettingDescriptor {
  /** 绑定的 pref 键，例如 "smartRecursion.mode" */
  key: SettingKey;
  kind: SettingKind;
  /** 控件主标签 */
  labelKey: FluentMessageId;
  /** 说明文字，显示在控件下方（可选，但强烈建议写） */
  descKey?: FluentMessageId;
  /** kind = "menulist" 时的选项 */
  options?: SettingOption[];
  /** kind = "text" 时的占位符 */
  placeholderKey?: FluentMessageId;
  /** kind = "number" 的取值范围 */
  min?: number;
  max?: number;
}

/** 顶部分类（二级分类），对应一组功能相关的设置项 */
export interface SettingCategory {
  /** 稳定的分类 id，同时用于 DOM 标记与测试 */
  id: string;
  /**
   * 顶部切换器里显示的名称。
   * ⚠️ FTL 里必须写成 `.label = …`（属性形式）——XUL 的 radio / checkbox /
   * menuitem 只认 label 属性；写成普通值会被 Fluent 塞进 textContent，
   * 结果是「有文字但控件本身不显示」。
   */
  tabKey: FluentMessageId;
  /** 分类内的引导语（普通值即可，description 是 XUL 但 Fluent 会写入文本） */
  introKey?: FluentMessageId;
  /** 该分类下的设置项 */
  items?: SettingDescriptor[];
  /**
   * 纯说明段落（用于「关于」这类没有设置项的分类）。
   * 需要插值的段落用 args 传参。
   */
  notes?: Array<{ key: FluentMessageId; args?: Record<string, string> }>;
  /** 是否在该分类末尾显示版本号 */
  showVersion?: boolean;
}

/**
 * 关于 FTL 写法的一条约定（踩过坑，写在这里避免重犯）：
 *   · checkbox / radio / menuitem 的可见文字 → 必须用 `.label = …`
 *   · description / html:h2 的正文           → 用普通值
 *   · 输入框的占位符                          → 用 `.placeholder = …`
 */
