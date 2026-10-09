// 默认首选项。构建时 scaffold 会自动加上 extensions.zotero.myzoterotools. 前缀。
//
// 每一项都必须在 src/settings/registry.ts 里声明（否则设置面板不会显示它），
// 反之亦然 —— 回归测试会校验两边一致。
pref("smartRecursion.mode", "emptyOnly");
pref("summaryBanner.enabled", true);
pref("summaryBanner.minItems", 0);
pref("sourceColumn.enabled", true);
pref("sourceColumn.separator", " · ");

pref("readingStatus.enabled", true);
// 状态标签的前缀。标签名形如 mzt/todo，Zotero 会把它显示成分组的嵌套标签。
pref("readingStatus.tagPrefix", "mzt/");

pref("exportBundle.enabled", true);
pref("exportBundle.includeFulltext", true);
// 留空表示每次导出时弹目录选择框
pref("exportBundle.outputDir", "");

pref("libraryAudit.enabled", true);
// 留空表示把体检报告写到 Zotero 数据目录
pref("libraryAudit.outputDir", "");

pref("metadataClean.enabled", true);
// 去掉标题/期刊名里的 HTML 标签（顺带能让 Zotero 的重复检测恢复工作）
pref("metadataClean.fixHtml", true);
// 把 language 的多种写法收敛成 BCP-47（zh-CN / en）
pref("metadataClean.normalizeLanguage", true);

pref("updateChecker.enabled", true);
// 加速站列表（每行一个前缀，或写 direct 表示直连）。
// 留空则用内置的实测可用列表。运行时会对它们测速，选最快的。
pref("updateChecker.proxies", "");
// 交叉校验：清单同时从两个不同站点拉取并比对，防止单个加速站篡改
pref("updateChecker.verifyWithSecondSource", true);
// 下载的新版 xpi 存哪里；留空则存到 Zotero 数据目录
pref("updateChecker.downloadDir", "");

pref("structuredFields.enabled", true);
// 结构化字段在条目 Extra 里的前缀，形如 "mzt.载体类型: 聚脲微囊"
pref("structuredFields.prefix", "mzt.");
// 留空表示每次导出时弹目录选择框
pref("structuredFields.outputDir", "");

pref("intake.enabled", true);
// 任务分类：agent 入库到这个分类的条目会被自动补元数据 / 找 PDF。
// 支持分类名（除草剂）或完整路径（农药/国标）。**切任务时改这里**。
pref("intake.taskCollection", "");
// 自动为新条目查找可用 PDF（走 Zotero 的解析器链，含机构代理）
pref("intake.autoFindPdf", true);
// 处理 Extra 里的 mzt.pendingDoi 标记：用 Zotero 翻译器抓元数据并原地补全
pref("intake.resolveMetadata", true);
// 任务分类里新增 PDF 时，给父条目打「mzt/待抽取」标签，通知下游 agent 开始抽取。
// 下游（workbuddy）轮询 Local API 取这些条目，抽完把标签换成「mzt/已抽取」。
pref("intake.tagForExtraction", true);
// 自动给「没有 PDF 附件」的条目打 mzt/无PDF 标签；补上 PDF 时自动摘掉。
// 目的是能一眼筛出缺 PDF 的文献（菜单里也有手动触发的命令）。
pref("intake.tagMissingPdf", true);

// 开发用开关（不出现在设置面板里）。打开方式：在开发 profile 的 prefs.js 里写入
//   user_pref("extensions.zotero.myzoterotools.dev.openPrefsOnStart", true);
//   user_pref("extensions.zotero.myzoterotools.dev.initialCategory", "itemList");
// 前者让开发实例启动后自动弹出设置面板，后者让它直接打开指定分类页，
// 调界面时不用每次手点菜单。
pref("dev.openPrefsOnStart", false);
pref("dev.initialCategory", "");
