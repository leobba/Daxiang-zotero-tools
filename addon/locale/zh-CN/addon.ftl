startup-begin = 插件加载中
startup-finish = 插件已就绪

prefs-title = MyZoteroTools

# ---- 功能①②③：分类聚合与文献列表 ----
column-source-collection = 来源子分类
banner-aggregated = 聚合显示：来自 { $collections } 个子分类的 { $count } 条

# ---- 功能④：阅读状态 ----
# 这一列显示的是本地化后的状态名
column-reading-status = 阅读状态
reading-state-todo = 待读
reading-state-doing = 在读
reading-state-done = 已读

# 右键菜单。注意这些是给 document.l10n 用的，所以必须写成 .label（属性形式）；
# 主窗口的 FTL 由 hooks.onMainWindowLoad 用 insertFTLIfNeeded 注入。
menu-reading-status =
    .label = 阅读状态
menu-reading-state-todo =
    .label = 标记为待读
menu-reading-state-doing =
    .label = 标记为在读
menu-reading-state-done =
    .label = 标记为已读
menu-reading-state-clear =
    .label = 清除状态标记

# ---- 功能⑤：导出数据包 ----
menu-export-bundle =
    .label = 导出文献数据包…
export-bundle-choose-folder = 选择数据包的输出目录
export-bundle-start = 正在导出文献数据包
export-bundle-count = 共 { $count } 篇
export-bundle-done = 数据包导出完成
export-bundle-result = { $count } 篇已导出到 { $dir }
export-bundle-failed = 数据包导出失败

# ---- 功能⑥：库体检 ----
menu-library-audit =
    .label = 库体检（只读，查找重复分类与重复条目）…
audit-running = 正在体检文献库…
audit-done = 库体检完成
audit-clean = 未发现问题 ✅
audit-summary = 共发现 { $count } 项问题，报告已生成并打开
audit-failed = 库体检失败

# ---- 功能⑧：元数据清洗 ----
menu-metadata-clean =
    .label = 元数据清洗（去 HTML 标签 / 统一 language）…
clean-nothing = 没有需要清洗的元数据 ✅
clean-confirm-title = 确认元数据清洗
clean-confirm-body = 将修改 { $items } 条文献：HTML 标签 { $html } 处、language 字段 { $language } 处。
clean-confirm-more = （下面只列出前 6 处，其余同理）
clean-confirm-ok = 开始清洗
clean-done = 元数据清洗完成
clean-done-detail = 已更新 { $count } 条文献

# ---- 功能⑨：检查更新（含加速站测速）----
menu-check-update =
    .label = 检查更新（含加速站测速）…
update-checking = 正在检查更新
update-probing = 正在对加速站测速…
update-all-failed = 所有更新源都不可用
update-all-failed-detail = 试了 { $count } 个源都没成功。请检查网络，或在设置里换一组加速站。
update-check-failed = 检查更新失败
update-latest = 已是最新版本
update-latest-detail = 当前 { $version }，清单来自 { $from }（共 { $count } 个源可用）
update-available-title = 发现新版本
update-available-body = 当前版本 { $current }，最新版本 { $latest }（清单来自 { $from }）。
update-verify-note = 校验
update-verified-ok = 已用 { $a } 与 { $b } 交叉校验，两站清单一致 ✅
update-verified-mismatch = ⚠️ { $a } 与 { $b } 返回的清单不一致，已中止（可能有站点被篡改）
update-verified-unavailable = 只有 { $a } 一个源可用，无法交叉校验 ⚠️
update-verified-direct = 走 GitHub 直连，未经第三方 ✅
update-verified-skipped = 已关闭交叉校验
update-confirm-ok = 下载新版本
update-downloading = 正在下载新版本
update-downloading-detail = { $version}，来自 { $from }
update-downloaded = 新版本已下载
update-downloaded-detail = { $version } 已存到 { $path }。请用「工具 → 插件 → 齿轮 → Install Add-on From File」安装。
update-download-failed = 下载失败
update-hash-mismatch = { $from } 返回的文件哈希与清单不符，已拒绝（可能被篡改）

# ---- 功能⑦：结构化字段 ----
menu-structured-fields =
    .label = 结构化字段
menu-export-selected-table =
    .label = 导出对比表（选中条目）
menu-export-collection-table =
    .label = 导出对比表（当前列表全部）
menu-import-fields-csv =
    .label = 从 CSV 导入…
section-structured-fields =
    .label = 结构化字段
sidenav-structured-fields =
    .label = 结构化字段
section-structured-fields-empty = 暂无结构化字段。进入编辑模式即可添加。
section-structured-fields-name = 字段名
section-structured-fields-value = 值
section-structured-fields-add = 添加
section-structured-fields-remove = 删除这个字段
structured-choose-folder = 选择对比表的输出目录
structured-choose-csv = 选择要导入的 CSV
structured-no-items = 没有可导出的条目
structured-empty = 选中的条目里没有结构化字段
structured-empty-hint = 结构化字段写在条目的 Extra 里，形如「{ $prefix }字段名: 值」
structured-exported = 对比表已导出
structured-exported-detail = { $count } 篇已导出到 { $dir }
structured-failed = 操作失败
structured-import-empty = CSV 内容为空
structured-import-no-key = CSV 缺少 key 列
structured-import-no-key-hint = 第一行必须是表头，且要有一列名为 key（Zotero 条目 key）
structured-imported = 导入完成
structured-imported-detail = 更新 { $count } 条，跳过 { $skipped } 条
