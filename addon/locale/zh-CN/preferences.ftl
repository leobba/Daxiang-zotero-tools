// 注意：checkbox / radio / menuitem 的可见文字必须写成 .label（属性形式）。
// 写成普通值时 Fluent 会写进 textContent，结果是「只有文字、控件本体不显示」。
// description 与 html:h2 的正文才用普通值。

settings-tab-aggregation =
    .label = 分类聚合
settings-tab-aggregation-intro = 让「自己没有直属文献、但子分类里有文献」的分类也能直接看到那些文献。
settings-tab-item-list =
    .label = 文献列表
settings-tab-item-list-intro = 调整文献列表本身的显示方式。
settings-tab-about =
    .label = 关于


setting-smart-recursion-mode = 聚合方式
setting-smart-recursion-mode-desc = 「仅空分类」只对没有直属文献的分类生效，有直属文献的分类（例如「机器学习」）保持原样；「所有分类」等同打开 Zotero 自带的全局开关。
setting-smart-recursion-mode-empty-only =
    .label = 仅空分类（推荐）
setting-smart-recursion-mode-always =
    .label = 所有分类
setting-smart-recursion-mode-off =
    .label = 关闭

setting-summary-banner =
    .label = 列表顶部聚合提示条
setting-summary-banner-desc = 聚合显示时，在文献列表上方标明这些文献来自哪些子分类，避免误以为它们真的属于当前分类。
setting-summary-banner-min-items = 提示条最少条目数
setting-summary-banner-min-items-desc = 聚合出的条目少于该数量时不显示提示条。填 0 表示总是显示。

setting-source-column =
    .label = 「来源子分类」列
setting-source-column-desc = 在文献列表中增加一列，标出每条文献实际所属的子分类。若看不到该列，请在列表表头右键的列选择器中勾选。
setting-source-column-separator = 多个来源之间的分隔符
setting-source-column-separator-desc = 一条文献同时属于多个子分类时，用这个字符串分隔它们的名称。留空则恢复默认值。
setting-source-column-separator-placeholder =
    .placeholder = 默认：空格 · 空格

settings-tab-reading-status =
    .label = 阅读状态
settings-tab-reading-status-intro = 给文献标一个「读没读过」的状态，并显示成一列。
setting-reading-status =
    .label = 启用阅读状态
setting-reading-status-desc = 在文献列表增加「阅读状态」列，并在右键菜单里加一组标记命令。状态用标签保存，所以在标签选择器里也能直接点选筛选。
setting-reading-status-prefix = 状态标签前缀
setting-reading-status-prefix-desc = 状态会存成形如「前缀+状态」的标签。改前缀不会迁移已有标签，改之前请先把旧标签改好。
setting-reading-status-prefix-placeholder =
    .placeholder = 默认：mzt/

settings-tab-export =
    .label = 导出
settings-tab-export-intro = 把选中的文献导出成一个数据包，方便交给大模型做结构化抽取或备份。
setting-export-enabled =
    .label = 启用「导出文献数据包」
setting-export-enabled-desc = 在文献列表的右键菜单里增加导出命令。导出内容为元数据总表 index.csv 与每篇一个 Markdown 文件（含元数据、摘要、全文）。
setting-export-fulltext =
    .label = 同时导出全文
setting-export-fulltext-desc = 全文取自 Zotero 自己的全文索引缓存，不需要重新解析 PDF。未建立索引的文献会标记为无全文。
setting-export-output-dir = 默认输出目录
setting-export-output-dir-desc = 填了就每次直接导出到这里，不再弹目录选择框；留空则每次询问。
setting-export-output-dir-placeholder =
    .placeholder = 留空则每次询问

settings-tab-structured-fields =
    .label = 结构化字段
settings-tab-structured-fields-intro = 把从文献里抽取出来的变量（载体、粒径、助剂…）存进条目，并导出成跨论文对比表。
setting-structured-enabled =
    .label = 启用结构化字段
setting-structured-enabled-desc = 在条目信息面板增加「结构化字段」区块（可直接编辑），并在右键菜单里加导出/导入命令。数据写在条目的 Extra 里，因此随 Zotero 一起同步。
setting-structured-prefix = 字段前缀
setting-structured-prefix-desc = 字段在 Extra 里存成「前缀+字段名: 值」。改前缀不会迁移已有数据。
setting-structured-prefix-placeholder =
    .placeholder = 默认：mzt.
setting-structured-output-dir = 对比表输出目录
setting-structured-output-dir-desc = 填了就每次直接导出到这里；留空则每次询问。
setting-structured-output-dir-placeholder =
    .placeholder = 留空则每次询问

settings-tab-library-audit =
    .label = 库体检
settings-tab-library-audit-intro = 只读扫描，查找重复分类树、重复条目、元数据污染等问题。不会修改任何数据。
setting-audit-enabled =
    .label = 启用库体检
setting-audit-enabled-desc = 在「工具」菜单里增加体检命令。检查重复分类树、重复条目（含 Zotero 自带检测会漏掉的那些）、元数据污染、空分类、孤立附件与缺附件的条目。
setting-audit-output-dir = 报告输出目录
setting-audit-output-dir-desc = 体检报告（Markdown）写到哪里。留空则写到 Zotero 数据目录。
setting-audit-output-dir-placeholder =
    .placeholder = 留空则写到数据目录

settings-tab-metadata-clean =
    .label = 元数据清洗
settings-tab-metadata-clean-intro = 去掉标题里混进来的 HTML 标签、把 language 的多种写法统一。只改文本，不动任何结构。
setting-clean-enabled =
    .label = 启用元数据清洗
setting-clean-enabled-desc = 在「工具」菜单里增加清洗命令。执行前会先扫描并弹确认框，列出要改什么、改多少。
setting-clean-html =
    .label = 去掉标题/期刊名里的 HTML 标签
setting-clean-html-desc = 从网页抓取时经常把 span、i 这类标签带进标题。它们不只是难看——还会让 Zotero 自带的重复条目检测失效（标题归一化后不相等），清掉之后重复检测就恢复正常。
setting-clean-language =
    .label = 统一 language 字段
setting-clean-language-desc = 把同一语言的多种写法（zh / zh-CN / chi / 中文、en / eng / English）收敛成 BCP-47 形式。这个字段会影响 CSL 的引用格式。认不出来的值保持原样，不猜。

settings-tab-update-checker =
    .label = 更新检查
settings-tab-update-checker-intro = 本机直连 GitHub 不通，所以更新检查会走加速站。这里可以配置加速站列表，运行时自动测速选最快的。
setting-update-enabled =
    .label = 启用「检查更新」
setting-update-enabled-desc = 在「工具」菜单里增加检查更新命令。它会先对所有更新源测速，用最快的一个拉取版本清单，并用第二个源交叉校验。
setting-update-proxies = 加速站列表
setting-update-proxies-desc = 每行一个前缀（如 https://gh-proxy.com/），或写 direct 表示直连。留空则用内置的实测可用列表。运行时会对它们测速。
setting-update-proxies-placeholder =
    .placeholder = 留空则用内置列表
setting-update-verify =
    .label = 交叉校验清单
setting-update-verify-desc = 同时从两个不同的加速站拉取版本清单，比对版本号与哈希，两者一致才继续。加速站是第三方中间人，这一步能防止单个站点篡改。
setting-update-download-dir = 新版下载目录
setting-update-download-dir-desc = 下载的新版 xpi 存到哪里。留空则存到 Zotero 数据目录。
setting-update-download-dir-placeholder =
    .placeholder = 留空则存到数据目录

setting-about-body = 本插件只改变你「看到」的内容：不会把条目移动或复制到父分类，也不改变「从分类中移除条目」的行为。
settings-version = 版本 { $version }
