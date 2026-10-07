/**
 * 设置项注册表 —— **整个插件设置界面的唯一事实来源**。
 *
 * 新增一个功能的设置，只需要在这里加一段声明：
 *   1. 在 addon/prefs.js 里加对应的默认值（键名要与这里的 key 一致）；
 *   2. 在 addon/locale/{zh-CN,en-US}/preferences.ftl 里加文案；
 *   3. 在这里挂上描述符。
 * 不需要写任何 XHTML / DOM 代码，也不需要动界面布局。
 * （回归测试会校验「注册表里的每一项都在面板中渲染出来了」。）
 */

import type { SettingCategory } from "./types";

export const SETTINGS_CATEGORIES: SettingCategory[] = [
  {
    id: "aggregation",
    tabKey: "settings-tab-aggregation",
    introKey: "settings-tab-aggregation-intro",
    items: [
      {
        key: "smartRecursion.mode",
        kind: "menulist",
        labelKey: "setting-smart-recursion-mode",
        descKey: "setting-smart-recursion-mode-desc",
        options: [
          {
            value: "emptyOnly",
            labelKey: "setting-smart-recursion-mode-empty-only",
          },
          { value: "always", labelKey: "setting-smart-recursion-mode-always" },
          { value: "off", labelKey: "setting-smart-recursion-mode-off" },
        ],
      },
      {
        key: "summaryBanner.enabled",
        kind: "checkbox",
        labelKey: "setting-summary-banner",
        descKey: "setting-summary-banner-desc",
      },
      {
        key: "summaryBanner.minItems",
        kind: "number",
        labelKey: "setting-summary-banner-min-items",
        descKey: "setting-summary-banner-min-items-desc",
        min: 0,
        max: 9999,
      },
    ],
  },

  {
    id: "itemList",
    tabKey: "settings-tab-item-list",
    introKey: "settings-tab-item-list-intro",
    items: [
      {
        key: "sourceColumn.enabled",
        kind: "checkbox",
        labelKey: "setting-source-column",
        descKey: "setting-source-column-desc",
      },
      {
        key: "sourceColumn.separator",
        kind: "text",
        labelKey: "setting-source-column-separator",
        descKey: "setting-source-column-separator-desc",
        placeholderKey: "setting-source-column-separator-placeholder",
      },
    ],
  },

  {
    id: "readingStatus",
    tabKey: "settings-tab-reading-status",
    introKey: "settings-tab-reading-status-intro",
    items: [
      {
        key: "readingStatus.enabled",
        kind: "checkbox",
        labelKey: "setting-reading-status",
        descKey: "setting-reading-status-desc",
      },
      {
        key: "readingStatus.tagPrefix",
        kind: "text",
        labelKey: "setting-reading-status-prefix",
        descKey: "setting-reading-status-prefix-desc",
        placeholderKey: "setting-reading-status-prefix-placeholder",
      },
    ],
  },

  {
    id: "export",
    tabKey: "settings-tab-export",
    introKey: "settings-tab-export-intro",
    items: [
      {
        key: "exportBundle.enabled",
        kind: "checkbox",
        labelKey: "setting-export-enabled",
        descKey: "setting-export-enabled-desc",
      },
      {
        key: "exportBundle.includeFulltext",
        kind: "checkbox",
        labelKey: "setting-export-fulltext",
        descKey: "setting-export-fulltext-desc",
      },
      {
        key: "exportBundle.outputDir",
        kind: "text",
        labelKey: "setting-export-output-dir",
        descKey: "setting-export-output-dir-desc",
        placeholderKey: "setting-export-output-dir-placeholder",
      },
    ],
  },

  {
    id: "structuredFields",
    tabKey: "settings-tab-structured-fields",
    introKey: "settings-tab-structured-fields-intro",
    items: [
      {
        key: "structuredFields.enabled",
        kind: "checkbox",
        labelKey: "setting-structured-enabled",
        descKey: "setting-structured-enabled-desc",
      },
      {
        key: "structuredFields.prefix",
        kind: "text",
        labelKey: "setting-structured-prefix",
        descKey: "setting-structured-prefix-desc",
        placeholderKey: "setting-structured-prefix-placeholder",
      },
      {
        key: "structuredFields.outputDir",
        kind: "text",
        labelKey: "setting-structured-output-dir",
        descKey: "setting-structured-output-dir-desc",
        placeholderKey: "setting-structured-output-dir-placeholder",
      },
    ],
  },

  {
    id: "libraryAudit",
    tabKey: "settings-tab-library-audit",
    introKey: "settings-tab-library-audit-intro",
    items: [
      {
        key: "libraryAudit.enabled",
        kind: "checkbox",
        labelKey: "setting-audit-enabled",
        descKey: "setting-audit-enabled-desc",
      },
      {
        key: "libraryAudit.outputDir",
        kind: "text",
        labelKey: "setting-audit-output-dir",
        descKey: "setting-audit-output-dir-desc",
        placeholderKey: "setting-audit-output-dir-placeholder",
      },
    ],
  },

  {
    id: "metadataClean",
    tabKey: "settings-tab-metadata-clean",
    introKey: "settings-tab-metadata-clean-intro",
    items: [
      {
        key: "metadataClean.enabled",
        kind: "checkbox",
        labelKey: "setting-clean-enabled",
        descKey: "setting-clean-enabled-desc",
      },
      {
        key: "metadataClean.fixHtml",
        kind: "checkbox",
        labelKey: "setting-clean-html",
        descKey: "setting-clean-html-desc",
      },
      {
        key: "metadataClean.normalizeLanguage",
        kind: "checkbox",
        labelKey: "setting-clean-language",
        descKey: "setting-clean-language-desc",
      },
    ],
  },

  {
    id: "updateChecker",
    tabKey: "settings-tab-update-checker",
    introKey: "settings-tab-update-checker-intro",
    items: [
      {
        key: "updateChecker.enabled",
        kind: "checkbox",
        labelKey: "setting-update-enabled",
        descKey: "setting-update-enabled-desc",
      },
      {
        key: "updateChecker.proxies",
        kind: "text",
        labelKey: "setting-update-proxies",
        descKey: "setting-update-proxies-desc",
        placeholderKey: "setting-update-proxies-placeholder",
      },
      {
        key: "updateChecker.verifyWithSecondSource",
        kind: "checkbox",
        labelKey: "setting-update-verify",
        descKey: "setting-update-verify-desc",
      },
      {
        key: "updateChecker.downloadDir",
        kind: "text",
        labelKey: "setting-update-download-dir",
        descKey: "setting-update-download-dir-desc",
        placeholderKey: "setting-update-download-dir-placeholder",
      },
    ],
  },

  {
    id: "intake",
    tabKey: "settings-tab-intake",
    introKey: "settings-tab-intake-intro",
    items: [
      {
        key: "intake.enabled",
        kind: "checkbox",
        labelKey: "setting-intake-enabled",
        descKey: "setting-intake-enabled-desc",
      },
      {
        key: "intake.taskCollection",
        kind: "text",
        labelKey: "setting-intake-collection",
        descKey: "setting-intake-collection-desc",
        placeholderKey: "setting-intake-collection-placeholder",
      },
      {
        key: "intake.autoFindPdf",
        kind: "checkbox",
        labelKey: "setting-intake-find-pdf",
        descKey: "setting-intake-find-pdf-desc",
      },
      {
        key: "intake.resolveMetadata",
        kind: "checkbox",
        labelKey: "setting-intake-metadata",
        descKey: "setting-intake-metadata-desc",
      },
    ],
  },

  {
    id: "about",
    tabKey: "settings-tab-about",
    notes: [{ key: "setting-about-body" }],
    showVersion: true,
  },
];
