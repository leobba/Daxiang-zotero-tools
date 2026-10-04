# MyZoteroTools

一款自用的 Zotero 插件，按需逐步增加功能。当前版本 `0.1.0`，面向 **Zotero 10**（Firefox 140 ESR 内核）。

工程基于社区标准脚手架 [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template) 搭建，并针对 Zotero 10 做了适配；框架选型的前因后果见 [doc/框架评估.md](doc/框架评估.md)。

---

## 它解决什么问题

Zotero 默认把「分类」理解为**只包含直属条目**：

```js
// chrome/content/zotero/xpcom/collectionTreeRow.js:456-461
s.addCondition('collectionID', 'is', this.ref.id);   // 只匹配直接属于该分类的条目
if (Zotero.Prefs.get('recursiveCollections')) {
  s.addCondition('recursive', 'true');               // 只有自带开关打开才含子分类
}
```

而 `extensions.zotero.recursiveCollections` 的默认值是 `false`
（`defaults/preferences/zotero.js:1616`）。

所以当某个一级分类**自己一条直属文献都没有、文献全挂在二级分类下**时，点它就只能是空列表。
这不是 bug，是 Zotero 的默认语义。

Zotero 自带的解法是「视图 → 显示子分类中的条目」，但它是**全局开关**：一开，所有分类都变成递归，
连「机器学习」这种本来有直属条目的分类也会被子分类条目混入。
在「从分类中移除条目」时，它还会连带从子分类移除（`collectionViewItemTree.js:2129`）。

本插件要的是**更细的粒度**：只在「本来就没有直属条目」的分类上聚合，其余分类保持原样。

---

## 八个功能

### 分类聚合（功能 ①②③）

| 功能 | 做法 | 用的什么接口 |
|---|---|---|
| **① 按需智能递归** | 分类没有直属条目、但有子分类时，自动让它显示子分类的全部文献；有直属条目的分类不受影响 | 包装 `Zotero.CollectionTreeRow.prototype.getSearchObject` |
| **② 列表顶部聚合提示条** | 显示「聚合显示：来自 N 个子分类的 M 条」，避免误以为条目真的属于父分类 | 向 `#zotero-items-pane-container` 注入元素 |
| **③ 「来源子分类」列** | 每条文献旁边标出它实际所属的二级分类 | ✅ **官方 API**：`Zotero.ItemTreeManager.registerColumn()` |

可在设置界面调整的项：

- **聚合方式**：`仅空分类`（默认，只对没有直属条目的分类生效）／`所有分类`（等同打开 Zotero 自带全局开关）／`关闭`
- **提示条最少条目数**：聚合出的条目少于该数量时不显示提示条，填 `0` 表示总是显示
- **多个来源之间的分隔符**：一条文献属于多个子分类时，名称之间用什么连接（默认 ` · `）

功能 ① 的关键设计：`Zotero.Search.prototype.scope` 与 `.conditions` 都是**公开 getter**
（`xpcom/data/search.js:97-101`），所以可以拿到检索对象、沿 scope 链找到持有分类条件的那一层，
直接补上 `recursive` 条件——**完全复用 Zotero 自身的检索逻辑**，
既不用临时修改全局 pref（那会触发 `itemTree.js:992` 的观察者刷新），也不复制它的条件拼装代码。

⚠️ 一个容易踩的坑：Zotero 里 `collectionID` 只是「快捷条件」（`searchConditions.js:271`，`noLoad: true`），
调用 `addCondition('collectionID', ...)` 后存储下来的规范名称是 **`collection`**
（`searchConditions.js:295`）。两个名字都要认，否则匹配不到。

### 阅读状态（功能 ④）

Zotero 本身没有「这篇我读没读过」的状态，文献一多只能靠记忆。

- **右键菜单**：标记为 待读 / 在读 / 已读，或清除标记（可多选批量标记）
- **「阅读状态」列**：列表里直接看得到
- **状态用标签保存**（默认 `mzt/todo` `mzt/doing` `mzt/done`），并且设了颜色，所以：
  - 在 Zotero 的**标签选择器里点一下就能筛选**，等于白送一套工作流；
  - 标签会随 Zotero 同步，不会丢；
  - 导出数据包时也会带上。

标签用稳定的 ASCII id 而不是中文，这样切换界面语言不会让已有状态失效；界面上显示的是本地化文案。
标签前缀可以在设置里改。

### 导出数据包（功能 ⑤）

把选中的文献导成一个可以直接喂给大模型的「数据包」：

```
MyZoteroTools-export-20261004-130501/
  index.csv                元数据总表（带 BOM，Excel 打开中文不乱码）
  papers/0001-ABCD1234.md  每篇一个文件：元数据 + 摘要 + 全文
  papers/0002-EFGH5678.md
```

- **每篇一个文件**是刻意的：可以直接把不同文件分给不同 agent 并行处理。
- **全文取自 Zotero 自己的全文索引缓存**（`.zotero-ft-cache`），不需要重新解析 PDF，
  也不会因为 PDF 是扫描件而卡住（那种情况会记为无全文）。
- 导出格式里的字段名固定用英文（`Title` / `Creators` / `DOI` …）：
  数据包是要被程序和大模型读的，字段名跟着界面语言变会破坏下游流程。
- 设置里可以指定**默认输出目录**，填了就每次直接导出，不再弹目录选择框。

### 库体检（功能 ⑥，只读）

**工具 → 库体检**。扫描并报告，**绝不修改任何数据**：

| 检查项 | 说明 |
|---|---|
| **重复分类树** | Zotero 和任何插件都不检测这个。按**名称**分组（不能按「父分类 + 名称」—— 整树复制时副本的子分类挂的是另一份父分类），并用**子树签名**标出哪些是「整树复制」 |
| **重复条目** | 复刻 Zotero 自带算法，并明确区分「Zotero 能发现」和「**它会漏检**」（附件/笔记被它排除；标题里混了 HTML 也会让它失效） |
| 元数据污染 | 标题/期刊名里混入的 HTML 标签或实体 |
| 空分类 | 既无条目也无子分类 |
| 孤立附件 | 没有父条目的附件 |
| 缺附件的条目 | — |
| **回收站**（供决策，非问题） | 里面有多少分类/条目；**哪条存活条目的唯一附件正在回收站里**（清空回收站会永久删文件，这是决策不是清理细节） |

⚠️ **回收站里的东西不算问题**：重复的分类树/条目如果已经在回收站里，说明已经处理过了。
体检会排除它们，只在「回收站」那一条里单独列出。

报告写成 Markdown 到数据目录（可配置）并自动打开。

### 元数据清洗（功能 ⑧）

**工具 → 元数据清洗**。补的是「没装 Linter for Zotero」留下的缺口，只做两件**纯文本**的事：

1. **去掉标题/期刊名里的 HTML 标签与实体**
   从网页抓取（知网、出版商页面）时经常把 `<span style="…">` 带进标题。
   危害不只是难看 —— **它会让 Zotero 自带的重复条目检测失效**：
   Zotero 的标题归一化只处理 ASCII 标点、不剥离标签，于是两份「看起来一样」的标题
   归一化后不相等，重复条目就检不出来。（实测验证过这个机制。）
2. **规范化 `language` 字段**
   同一语言常有多种写法（`zh` / `zh-CN` / `chi` / `中文`、`en` / `eng` / `English`）。
   这个字段会影响 CSL 的引用格式（中文文献用「等」还是「et al.」），统一成 BCP-47。
   认不出来的值**原样保留，不猜**。

设计上刻意保守：只改这三个字段 + `language`；**先扫描再弹确认框**（列出要改什么、改多少），
确认后才写；只处理存活条目，回收站里的不动。

### 结构化字段（功能 ⑦）

**把从文献里抽取出来的变量存进条目，并导出成跨论文对比表。**

生态调研的结论是：跨论文结构化变量抽取**至今没有成熟方案**，因为 Zotero 十年未实现自定义字段，
插件也无法注册字段。于是链路断在下游：

```
论文 → [抽取] → [落库] → [审核] → [增量] → [跨论文对比表]
        ↑ 上游已解决          ↑↑↑↑ 这一段没人做 ↑↑↑↑
```

本功能补的就是下游：

- **落库**：写在条目的 **Extra** 里，格式 `mzt.载体类型: 聚脲微囊`（前缀可配置）。
  用 Zotero 自己的 `key: value` 约定，别的工具也读得懂；随 Zotero 一起同步。
- **编辑**：条目信息面板里的「结构化字段」区块（官方 `ItemPaneManager.registerSection`），
  只读模式显示、编辑模式可直接增删改。
- **导出**：右键菜单 → 结构化字段 → 导出对比表，产出 `comparison.csv`（Excel 友好）
  与 `comparison.md`（Markdown 表格），列是字段、行是文献。
- **导入**：从 CSV 写回。CSV 第一行是表头，必须有一列 `key`（Zotero 条目 key），
  其余列即字段名 —— 这样外部抽取流水线的输出可以直接灌回库里。


### 行为边界

本插件**只改变你看到的内容**：

- 不会把条目真正移动或复制到父分类，条目归属不变；
- 不改变「从分类中移除条目」的行为（Zotero 内部走 `unfiltered` 查询，本插件不干预该路径）；
- 关掉某个功能后，行为立即回到 Zotero 原生状态。

---

## 设置界面

设置界面是**声明式**的：功能有哪些设置项只在
[src/settings/registry.ts](src/settings/registry.ts) 里声明一次，界面由框架生成，
不需要写任何界面代码。**新增功能不会让设置界面变成一坨手写 XHTML。**

界面结构：

```
MyZoteroTools                       ← 侧栏一项
├ 分类聚合 │ 文献列表 │ 阅读状态 │ 导出 │ 结构化字段 │ 库体检 │ 关于
└ 当前分类的设置项
```

- **分类切换**用 Zotero 原生偏好面板里「多选一」的同一个控件（`radiogroup orient="horizontal"`，
  常规面板的「配色方案」也是它），视觉与原生一致。页签多了会自动换行。
- **搜索用 Zotero 设置窗口顶部自带的那个**（`#prefs-search`），本面板**不再自建搜索框**——
  Zotero 的搜索本来就会加载并搜索全部面板（`preferences.js:677-686`），再做一个就是重复入口。
  本面板需要配合它：搜索期间放开所有分类，否则别的分类里的匹配项会被我们的 `hidden` 挡住。
- 支持的控件类型：复选框、数字输入框、文本输入框、下拉选择框。外观全部用 Zotero 原生控件，
  样式表只做间距与次级文字颜色的微调。

### 新增一个设置项

1. 在 [addon/prefs.js](addon/prefs.js) 里加默认值（键名即 `SettingKey`，会自动生成 TypeScript 类型）；
2. 在 [addon/locale/zh-CN/preferences.ftl](addon/locale/zh-CN/preferences.ftl) 与 `en-US` 里加文案；
3. 在 [src/settings/registry.ts](src/settings/registry.ts) 的对应分类下挂一个描述符。

完事。不用碰 XHTML、CSS 或任何 DOM 代码。

### 新增一个功能域（顶部分类）

在 `registry.ts` 的 `SETTINGS_CATEGORIES` 里加一个分类对象，再补上它的 FTL 文案即可。

### FTL 写法约定（很重要）

| 要显示的位置 | FTL 写法 |
|---|---|
| checkbox / radio / menuitem 的文字 | **`.label = …`（属性形式）** |
| description / html:h2 的正文 | 普通值 |
| 输入框占位符 | `.placeholder = …` |

写成普通值会让 Fluent 把文案塞进 `textContent`，结果是**「只有文字、控件本体不显示」**——
界面看起来像少了复选框，其实是文案写法不对。已加回归测试锁住这一点。

---

## 调试设置界面

```powershell
npm start          # 开发实例，改代码热重载
```

界面不方便每次都手点菜单打开，可以打开开发开关（写在开发 profile 的 `prefs.js` 里）：

```js
user_pref("extensions.zotero.myzoterotools.dev.openPrefsOnStart", true);   // 启动后自动弹出设置面板
user_pref("extensions.zotero.myzoterotools.dev.initialCategory", "itemList"); // 直接打开指定分类页
```

只截 Zotero 窗口（不会拍到桌面上的其它内容）：

```powershell
pwsh -File scripts/capture-prefs.ps1
```

---

## 安装

1. 在 Zotero 中打开 **工具 → 插件**；
2. 右上角齿轮 → **Install Add-on From File…**；
3. 选择构建产物 `.scaffold/build/my-zotero-tools.xpi`；
4. 重启 Zotero。

设置项在 **编辑 → 设置 → MyZoteroTools**，三个功能可分别开关。

---

## 开发

### 环境要求

- Node.js ≥ 22.8（本机 24.16）
- Zotero 10

### 首次准备

```bash
npm install
```

> **注意**：`zotero-types` 通过 `github:` 协议依赖 `pdfjs-dist` / `epubjs`。npm 12 默认
> `allow-git=none`，且本机 GitHub git 通道不可达。项目已在 `package.json` 里用
> **嵌套式 `overrides`** 把这两个包重定向到 npm 上的等价版本。
> 如果重新拉取上游锁文件导致安装失败，删除 `package-lock.json` 后重装即可。
> （扁平写法的 overrides 对 `epubjs` 不生效，必须写成嵌套形式。）

### 常用命令

```bash
npm run build     # 构建 xpi + 类型检查（tsc --noEmit）
npm start         # 启动开发实例：自动装插件 + 改代码自动热重载
npm test          # 在真实 Zotero 中跑行为测试
npm run lint:fix  # 格式化 + 自动修复
```

`zotero-plugin test` 需要一份浏览器版 `chai.js`，脚手架会去 `chaijs.com` 下载。
本机网络受限，已把它放进脚手架缓存目录（`.scaffold/cache/chai.js`）；若缓存被清掉，
可从 npm 取 `chai@4.x` 里的 `chai.js` 放回该位置。

### 开发/测试环境是隔离的

`.env` 已配置好，开发实例使用 `.testkit/` 下的**独立 profile 与数据目录**，
数据目录里放的是正式库的**一致性快照**（`zotero.sqlite`，WAL 已 checkpoint）。
因此：**开发与测试全程不会碰到 `D:\zotero文献` 里的正式库。**

`npm start` 会启动一个独立的 Zotero 实例（用 `.testkit/profile`），可以放心点。

### 测试如何拿到真实数据

`zotero-plugin test` 每次都会清空 `.scaffold/test/data`，无法直接用环境变量指定数据目录。
项目利用脚手架提供的 `test:init` 钩子（在清空之后、启动 Zotero 之前执行），
把 `MYZOTEROTOOLS_TEST_DB` 指向的数据库快照投放进去——见
[zotero-plugin.config.ts](zotero-plugin.config.ts) 里的 `seedTestDatabase()`。

`scripts/inspect-db.mjs` 可以直接查快照库的分类树与条目数，排查数据问题时很好用：

```bash
node scripts/inspect-db.mjs .testkit/data/zotero.sqlite
```

---

## 代码结构

```
addon/                        静态资源，原样打进 xpi
  bootstrap.js                插件入口（registerChrome + loadSubScript + hooks）
  manifest.json               strict_max_version: 10.*
  prefs.js                    默认首选项（构建时自动加 extensions.zotero.myzoterotools. 前缀）
  content/preferences.xhtml   设置面板的静态空壳（内容全部按 registry 生成）
  content/preferences.css     设置面板的排版微调
  locale/{zh-CN,en-US}/*.ftl  Fluent 本地化
src/
  index.ts                    注入全局 addon / ztoolkit
  addon.ts                    Addon 类，持有 data / hooks / api
  hooks.ts                    ⭐ 生命周期总调度——只做分发与装配
  preferences.ts              设置面板脚本入口（构建为 iife，由 PreferencePanes 的 scripts 加载）
  settings/                   ⭐ 设置框架
    types.ts                    控件与分类的描述符类型
    registry.ts                 **设置项的唯一事实来源**——加设置项只改这里
    controls.ts                 按描述符生成原生控件 + pref 双向绑定
    pane.ts                     面板装配：顶部分类切换 + 面板内搜索
  modules/
    smartRecursion.ts         功能①   包装 getSearchObject
    summaryBanner.ts          功能②   列表顶部提示条
    sourceColumn.ts           功能③   「来源子分类」列
    readingStatus.ts          功能④   阅读状态（列 + 右键菜单）
    exportBundle.ts           功能⑤   导出文献数据包
    libraryAudit.ts           功能⑥   库体检（只读）
    structuredFields.ts       功能⑦   结构化字段（条目面板 + 对比表）
    metadataClean.ts          功能⑧   元数据清洗（去 HTML / 统一 language）
    prefsPane.ts              设置面板注册
  utils/{locale,prefs,window,ztoolkit}.ts
test/startup.test.ts          在真实 Zotero 中运行的行为测试
typings/                      global / i10n / prefs（后两者由构建生成）
zotero-plugin.config.ts       构建与测试配置
```

约定：**hooks 只做分发，业务逻辑放 `modules/`，界面声明放 `settings/registry.ts`**。

所有功能模块都会挂到 `addon.api` 上（`Zotero.MyzoteroTools.api.xxx`），
方便在 Zotero 的调试控制台里直接调用，测试也是通过它拿到**插件运行时**的模块实例。

### 加一个新功能

1. 在 `src/modules/` 新建模块，导出 `register()` / `unregister()`；
2. 在 `src/hooks.ts` 的 `onStartup`（或 `onMainWindowLoad`）里调用 `register()`，
   并在 `onShutdown` 里 `unregister()`，同时把它挂到 `addon.api` 上；
3. 需要设置项就按上面「新增一个设置项」的三步走（prefs.js + FTL + registry）；
4. `npm run build`，再 `npm test` 验证。

第 3 步不用写任何界面代码，界面由框架按声明生成；测试会校验
「registry 声明了什么，面板里就必须渲染出什么」，忘了改哪一边都会直接失败。

### 用官方 API 而不是 monkey-patch

功能③④⑤ 全部走 Zotero 官方插件 API（`ItemTreeManager` / `MenuManager`），
只有功能①必须包装内部方法。这样版本升级时绝大部分功能不会坏。

两个容易踩的点：

- **`MenuManager` 的 id 会被命名空间化**：内部存的是 `CSS.escape(pluginID + "-" + menuID)`，
  所以 `unregisterMenu()` 必须传 **`registerMenu()` 返回的 key**，传原始 menuID 会静默失败
  （只打一条 "Can't remove unknown option" 日志）。已加回归测试锁住。
- **菜单文案走主窗口的 `document.l10n`**：Zotero 虽然会把插件所有 `.ftl` 汇总注册，
  但必须在文档里用 `<link rel="localization">` 引入才生效。偏好面板的 xhtml 里有这个 linkset，
  **主窗口没有**，需要插件自己调 `MozXULElement.insertFTLIfNeeded()` 注入，
  否则菜单项是空白的。已加回归测试锁住。

### 用官方 API 时另外几个坑（都实测踩过）

- **注册类 API 失败不抛异常，只返回 `false`**，原因只写在 `Zotero.warn` 里。
  `ItemPaneManager.registerSection` 的 **`sidenav` 是必填的**（schema 没标 optional），
  漏了它区块会静默地不出现。所有注册都必须检查返回值。
- **`Zotero.Collections.getByLibrary()` 只返回内存缓存里的分类**（`data/collections.js:96-103`
  遍历 `_objectCache`），不是数据库里的全部。要枚举全部分类必须
  `getAllIDs()` + `getAsync()`。库体检一开始就栽在这里：31 个分类只看到 16 个，
  而漏掉的正好是「重复的那一套」。
- **`Tags.setColor` 的 `position` 是数字键 1-9 的键位**，指定位置是 `splice` 插入，
  会顶掉用户已有彩色标签的快捷键；不传 position 才是追加。彩色标签每库上限 9 个。
- **主窗口没有官方 CSS 注入 API**（插件基础设施 issue #5755 仍 open），
  样式表要自己往 document 里插 `<link rel="stylesheet">`。
- **别自建搜索框**：Zotero 设置窗口顶部已有 `#prefs-search`，而且它的 `_search`
  会加载并搜索**全部**面板（`preferences.js:677-686`）。自建一个既是重复入口，
  又会和它的 `hidden-by-search` 机制打架（我们给非当前分类加的 `hidden` 会把匹配项挡掉）。
  正确做法是监听 `#prefs-search`，搜索期间放开自己的分类。
  判定「Zotero 搜到了没有」的可靠信号是：命中时它**不会**给面板根元素加
  `hidden-by-search`（`preferences.js:769-778`）；测试环境里高亮（`search-tooltip-parent`）
  连内置面板都产生不了，不能拿来当判据。

---

## Zotero 10 需要注意的破坏性变更

开发中踩到或已规避的：

- **单数 getter 会抛异常**：`ZoteroPane.getCollectionTreeRow()` → 必须改用 `getCollectionTreeRows()`；
  同理 `getSelectedCollection()` → `getSelectedCollections()`、`getSelectedLibraryID()` → `getSelectedLibraryIDs()`。
- `ItemTree#collectionTreeRow` 已移除，改用 `itemsView.viewMode` / `itemsView.collectionTreeRows`；
  视图类拆成了 `ItemTree` / `CollectionViewItemTree`。
- `Zotero.MenuManager` 的 `collectionTreeRow` 上下文会抛异常，用 `collectionTreeRows`。
  注意 `zotero-plugin-toolkit` 早已移除自己的 `MenuManager`，菜单要用官方 `Zotero.MenuManager`。
- **`zotero-types@4.1.3` 是写给 Zotero 8 的**：缺少 Zotero 10 的新 API，
  且 `ZoteroPane` 上带 `[attr: string]: any` 索引签名，所以这些调用会被推成 `any`。
  本项目在与内部 API 打交道处统一用小范围的显式类型断言 + 注释，而不是全局 `any`。

### 开发设置面板时踩过的坑

1. **XML 注释里绝对不能出现连续两个连字符。** 面板 XHTML 是 XML，`<!-- ... -->` 里只要有
   `--` 就会让整个面板以 `not well-formed XML` 解析失败，而 Zotero 会把错误吞掉——
   表现是**面板一片空白、侧栏仍能选中，极难排查**。最典型的触发方式是顺手写下
   CSS 自定义属性名（`var` 加两个连字符）。写注释时请绕开它。
   已加回归测试「设置面板能被 Zotero 正确解析并加载」防住这类问题。
2. **`Zotero.PreferencePanes.register()` 是 async 的**（内部要 await `resolveURI` 解析
   `src` / `scripts` / `stylesheets`），必须 `await`，否则注册还没完成就往下走。
3. **插件面板被强制设置 `defaultXUL: true`**（`xpcom/preferencePanes.js:157`），
   所以 Zotero 用 `parseXULToFragment` 解析：**XUL 是默认命名空间，HTML 标签要写 `html:` 前缀**。
   （不要被 `_parseXHTMLToFragment` 误导，那不是插件面板走的路径。）
4. **面板脚本比面板片段先执行。** `_loadPane()` 的顺序是「先跑 `scripts`，再读 `src` 加载片段」，
   所以脚本里 `getElementById(容器)` 一定是 null，必须等容器出现再渲染
   （本项目用 MutationObserver + 超时兜底）。
5. **XUL 控件的文字必须用 `.label` 属性形式**（详见上面的 FTL 写法约定）。
6. **初始化时不要写首选项。** 程序化设置 `menulist.value` / `checkbox.checked` 会触发
   `change` / `command` 事件；如果此时已经挂了「写回 pref」的监听，就会被误当成用户输入，
   把默认值覆盖掉（本项目真实踩过：默认 `emptyOnly` 被写成了 `always`）。
   解决办法是**两阶段绑定**：先 `sync()` 把 pref 的值反映到界面（监听惰性），
   等界面就绪后再 `enable()` 开始接受用户输入。
   已加回归测试「打开设置面板不会改动任何首选项」防住这类问题。
7. 面板标题由 Zotero 自动插入（`_loadPane` 里会往第一个 `.main-section` 前插一个 `<h1>`），
   自己在面板里再写一遍名称会重复。
8. `scripts` 由 `Services.scriptloader.loadSubScript()` 加载，是**经典脚本**，
   所以那条 esbuild 配置必须是 `format: "iife"`，不能输出 ESM。


## 已知限制

- **Zotero 没有分类树的官方插件 API**。条目列表的自定义列是官方支持的（功能③走的这条路，最稳），
  但分类树行为只能包装内部方法（功能①），Zotero 版本升级时需回归测试。
- 功能① 依赖 `CollectionTreeRow.prototype.getSearchObject` 这一入口存在。
  插件启动时会检查，若不存在则打日志并跳过，不会导致 Zotero 异常。
- 提示条里的条目数取自 Zotero 当前的检索结果，与列表实际行数一致（展开子条目时会包含子条目行）。

## 许可

AGPL-3.0-or-later（继承自所用脚手架）。自用无影响；若将来要分发，需以 AGPL 开放源码。
