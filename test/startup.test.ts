import { assert } from "chai";
import { config } from "../package.json";
import { SETTINGS_CATEGORIES } from "../src/settings/registry";
import * as readingStatus from "../src/modules/readingStatus";
import * as exportBundle from "../src/modules/exportBundle";
import * as libraryAudit from "../src/modules/libraryAudit";
import * as structuredFields from "../src/modules/structuredFields";
import * as metadataClean from "../src/modules/metadataClean";
import * as updateChecker from "../src/modules/updateChecker";
import * as literatureIntake from "../src/modules/literatureIntake";
import * as optionSources from "../src/settings/optionSources";

/**
 * 在真实 Zotero 中运行的行为测试（`npm test`）。
 *
 * 数据来源：通过 zotero-plugin.config.ts 的 `test:init` 钩子投放的数据库快照，
 * 详见该文件里的说明。
 *
 * 验收标准的设计说明（重要）：
 *   Zotero 的检索在分类场景下会额外纳入「作用域内条目的子项」（附件 / 笔记 / 批注）——
 *   见 chrome/content/zotero/xpcom/data/search.js:641-652 的 `_scopeIncludeChildren` 分支。
 *   因此 `search()` 返回的 id 数量会大于「分类内条目数」，这不是缺陷。
 *
 *   所以本测试不自行推算期望值，而是直接以 **Zotero 自带的全局递归开关**为基准：
 *   插件在「无直属条目的分类」上产出的结果，必须与把
 *   `extensions.zotero.recursiveCollections` 打开时的原生结果**逐条一致**。
 *   这样验的是「插件忠实复现了 Zotero 的递归语义，但只在我们指定的分类上生效」。
 */

const PREFS_PREFIX = config.prefsPrefix;
const RECURSIVE_PREF = "recursiveCollections";

/** 聚合方式取值，与 registry.ts 的 menulist 选项对应 */
const MODE_EMPTY_ONLY = "emptyOnly";
const MODE_OFF = "off";

function setPluginPref(key: string, value: boolean | string | number) {
  Zotero.Prefs.set(`${PREFS_PREFIX}.${key}`, value, true);
}

function setSmartRecursionMode(mode: string) {
  setPluginPref("smartRecursion.mode", mode);
}

/** 构造最小可用的 CollectionTreeRow（不依赖真实视图） */
function makeRow(collection: Zotero.Collection) {
  return new (Zotero as any).CollectionTreeRow(
    {},
    "collection",
    collection,
    0,
    false,
  );
}

async function searchIds(row: any): Promise<number[]> {
  const search = await row.getSearchObject();
  const ids: number[] = await search.search();
  return [...ids].sort((a, b) => a - b);
}

async function directItemCount(collectionID: number): Promise<number> {
  return Number(
    await Zotero.DB.valueQueryAsync(
      "SELECT COUNT(*) FROM collectionItems WHERE collectionID = ?",
      collectionID,
    ),
  );
}

function getUserCollections(): Zotero.Collection[] {
  const library = Zotero.Libraries.getAll().find(
    (l) => l.libraryType === "user",
  );
  if (!library) {
    return [];
  }
  return Zotero.Collections.getByLibrary(
    library.libraryID,
    true,
  ) as Zotero.Collection[];
}

/**
 * 找出「没有直属条目、但子分类里有条目」的分类——
 * 也就是用户反馈中「点一级分类列表空白」的那一类。
 */
async function findAggregatableCollection() {
  for (const collection of getUserCollections()) {
    if ((await directItemCount(collection.id)) !== 0) {
      continue;
    }
    const descendants = collection.getDescendents(false, "collection") as any[];
    if (!descendants.length) {
      continue;
    }
    const placeholders = descendants.map(() => "?").join(",");
    const union = Number(
      await Zotero.DB.valueQueryAsync(
        `SELECT COUNT(DISTINCT itemID) FROM collectionItems
         WHERE collectionID IN (${placeholders})`,
        descendants.map((c) => c.id),
      ),
    );
    if (union > 0) {
      return { collection, descendants, union };
    }
  }
  return null;
}

/** 找出「有直属条目、且子分类也有条目」的分类 */
async function findCollectionWithDirectItems() {
  for (const collection of getUserCollections()) {
    if ((await directItemCount(collection.id)) === 0) {
      continue;
    }
    const descendants = collection.getDescendents(false, "collection") as any[];
    if (!descendants.length) {
      continue;
    }
    return { collection, descendants };
  }
  return null;
}

/** 子分类里「顶层条目」的数量——也就是用户最终在列表里看到的行数 */
async function expectedTopLevelCount(descendants: any[]): Promise<number> {
  const placeholders = descendants.map(() => "?").join(",");
  const ids: number[] = await Zotero.DB.columnQueryAsync(
    `SELECT DISTINCT itemID FROM collectionItems WHERE collectionID IN (${placeholders})`,
    descendants.map((c) => c.id),
  );
  const items = await Zotero.Items.getAsync(ids);
  return items.filter((item: any) => !item.parentItemID).length;
}

/** 取测试库里的普通条目（排除附件 / 笔记 / 批注） */
async function firstRegularItems(limit: number): Promise<Zotero.Item[]> {
  const ids: number[] = await Zotero.DB.columnQueryAsync(
    `SELECT itemID FROM items
      WHERE itemTypeID NOT IN (
        SELECT itemTypeID FROM itemTypes
         WHERE typeName IN ('attachment','note','annotation')
      )
      LIMIT ?`,
    [limit],
  );
  if (!ids?.length) {
    return [];
  }
  return Zotero.Items.getAsync(ids);
}

async function firstRegularItem(): Promise<Zotero.Item> {
  const items = await firstRegularItems(1);
  assert.isAbove(items.length, 0, "测试库中没有普通条目");
  return items[0];
}

/** 取测试库里的第一个附件条目 */
async function firstAttachment(): Promise<Zotero.Item | null> {
  const ids: number[] = await Zotero.DB.columnQueryAsync(
    `SELECT itemID FROM items
      WHERE itemTypeID = (SELECT itemTypeID FROM itemTypes WHERE typeName = 'attachment')
      LIMIT 1`,
  );
  if (!ids?.length) {
    return null;
  }
  return (await Zotero.Items.getAsync(ids[0])) ?? null;
}

/** 用 nsIFile.append 拼路径，交给平台处理分隔符 */
function childPath(dir: string, ...parts: string[]): string {
  const file = Zotero.File.pathToFile(dir);
  for (const part of parts) {
    file.append(part);
  }
  return file.path;
}

/** 当前注册在「文献列表右键菜单」上的全部菜单 id */
function registeredItemMenuIDs(): string[] {
  const options: any[] = (
    Zotero.MenuManager as any
  )._menuManager.getCustomMenuOptions("main/library/item");
  return options.map((option) => String(option.menuID));
}

/** 打开设置面板并返回其 document（面板脚本是异步渲染的，这里等它就绪） */
async function openPaneAndGetDocument(): Promise<Document> {
  Zotero.Utilities.Internal.openPreferences(`${config.addonRef}-prefpane`);

  /*
   * 轮询等窗口，而不是「睡 4 秒再断言」。
   *
   * 固定等待在 Zotero 启动慢时会偶发失败（实测遇到过「没有找到设置窗口」），
   * 这种抖动会让整套测试的可信度下降 —— 一个偶尔变红的测试等于没有测试。
   */
  const deadline = Date.now() + 20000;
  let win: any = null;
  while (Date.now() < deadline) {
    win = Services.wm.getMostRecentWindow("zotero:pref");
    if (win) {
      const root = win.document?.getElementById(
        `${config.addonRef}-preferences-root`,
      );
      if (root?.getAttribute("data-mzt-rendered") === "1") {
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  assert.ok(win, "没有找到设置窗口（等了 20 秒）");
  const doc: Document = win.document;
  const root = doc.getElementById(`${config.addonRef}-preferences-root`);
  assert.ok(root, "面板容器不存在");
  assert.equal(
    root.getAttribute("data-mzt-rendered"),
    "1",
    "面板脚本尚未完成渲染，后续断言无意义",
  );
  return doc;
}

describe("MyZoteroTools", function () {
  this.timeout(60000);

  /**
   * 回归测试：面板初始化**绝对不能改动首选项的值**。
   *
   * 真实踩过的坑：程序化设置 menulist.value / checkbox.checked 会触发
   * change/command 事件，如果这时已经挂上「写回 pref」的监听，就会被当成
   * 用户输入，把默认值覆盖掉（当时默认 emptyOnly 被写成了 always）。
   *
   * 这条测试必须排在所有会打开面板的用例之前 —— 面板脚本只在首次加载时渲染，
   * 排在后面就成了空测。
   */
  it("打开设置面板不会改动任何首选项（初始化不得写坏默认值）", async function () {
    const keys = SETTINGS_CATEGORIES.flatMap((category) =>
      (category.items ?? []).map((item) => String(item.key)),
    );
    assert.isAbove(keys.length, 0, "registry 里没有任何设置项");

    // 故意设成与默认值都不同的值，这样「被初始化逻辑覆盖」才会暴露出来
    const probes: Record<string, boolean | string | number> = {
      "smartRecursion.mode": "always",
      "summaryBanner.enabled": false,
      "summaryBanner.minItems": 7,
      "sourceColumn.enabled": false,
      "sourceColumn.separator": " / ",
    };
    for (const key of keys) {
      setPluginPref(key, probes[key] ?? "");
    }
    const readAll = () =>
      keys.map(
        (key) =>
          `${key}=${String(Zotero.Prefs.get(`${PREFS_PREFIX}.${key}`, true))}`,
      );
    const before = readAll();

    Zotero.Utilities.Internal.openPreferences(`${config.addonRef}-prefpane`);
    await new Promise((r) => setTimeout(r, 5000));

    // 确认面板确实渲染了，否则这条测试没有意义
    const win: any = Services.wm.getMostRecentWindow("zotero:pref");
    assert.ok(win, "没有找到设置窗口");
    const root = win.document.getElementById(
      `${config.addonRef}-preferences-root`,
    );
    assert.ok(root, "面板容器不存在");
    assert.equal(
      root.getAttribute("data-mzt-rendered"),
      "1",
      "面板脚本没有执行，本次校验无意义",
    );

    assert.deepEqual(readAll(), before, "打开设置面板后首选项的值被改动了");

    // 还原成默认值，避免影响后续用例
    for (const key of keys) {
      Zotero.Prefs.clear(`${PREFS_PREFIX}.${key}`, true);
    }
    setSmartRecursionMode(MODE_EMPTY_ONLY);
  });

  // 这是一条回归测试：面板 XHTML 一旦不是良构 XML，Zotero 只会静默地把面板
  // 渲染成空白（错误被吞成 "not well-formed XML"），极难排查。
  // 最常见的诱因是 XML 注释里出现了连续两个连字符（例如写 CSS 自定义属性名）。
  it("设置面板能被 Zotero 正确解析并加载", async function () {
    const panes = (Zotero.PreferencePanes as any).pluginPanes as any[];
    const ours = panes.find((p) => String(p.id).includes("prefpane"));
    assert.ok(
      ours,
      `插件面板未注册。现有 ${panes.length} 个: ${panes.map((p) => p.id).join(", ")}`,
    );

    const markup = Zotero.File.getContentsFromURL(ours.src);
    assert.isAbove(markup.length, 0, "面板 XHTML 内容为空");

    Zotero.Utilities.Internal.openPreferences(ours.id);
    await new Promise((r) => setTimeout(r, 4000));

    const win: any = Services.wm.getMostRecentWindow("zotero:pref");
    assert.ok(win, "没有找到设置窗口");

    // 插件面板注册时被强制设为 defaultXUL: true（preferencePanes.js:157），
    // 所以 Zotero 走的是 parseXULToFragment。这里复现同一条解析路径。
    const dtdFiles = [
      "chrome://zotero/locale/zotero.dtd",
      "chrome://zotero/locale/preferences.dtd",
    ];
    let frag: any;
    try {
      frag = win.MozXULElement.parseXULToFragment(markup, dtdFiles);
    } catch (e) {
      assert.fail(
        `面板 XHTML 解析失败（最常见原因：XML 注释里出现了连续两个连字符）: ${e}`,
      );
    }

    // 解析没问题还不够，还要确认 Zotero 真的把元素插进了设置窗口的 DOM
    const doc: Document = win.document;
    const rootIds = (Array.from(frag.children ?? []) as any[])
      .map((el) => el.id)
      .filter(Boolean);
    assert.isAbove(rootIds.length, 0, "面板解析后没有任何带 id 的顶层元素");
    for (const id of rootIds) {
      assert.ok(
        doc.getElementById(id),
        `面板元素 id=${id} 没有出现在设置窗口中（面板可能加载失败）`,
      );
    }
  });

  /**
   * 面板内容是运行时按 registry.ts 生成的，所以「声明了却没渲染」是一个
   * 静默风险：界面看起来正常，只是少了一项。这条测试把两边锁死。
   * 新增设置项时若忘了改某一边，这里会直接失败。
   */
  it("设置面板渲染出的项与 registry 声明完全一致", async function () {
    Zotero.Utilities.Internal.openPreferences(`${config.addonRef}-prefpane`);
    // 面板脚本要等容器出现，再等 FTL 资源加载完，这里留足时间
    await new Promise((r) => setTimeout(r, 5000));

    const win: any = Services.wm.getMostRecentWindow("zotero:pref");
    assert.ok(win, "没有找到设置窗口");
    const doc: Document = win.document;

    const renderedKeys = Array.from(doc.querySelectorAll("[data-mzt-key]")).map(
      (el) => el.getAttribute("data-mzt-key"),
    );

    const declaredKeys = SETTINGS_CATEGORIES.flatMap((category) =>
      (category.items ?? []).map((item) => String(item.key)),
    );
    assert.isAbove(declaredKeys.length, 0, "registry 里没有任何设置项");
    assert.deepEqual(
      [...renderedKeys].sort(),
      [...declaredKeys].sort(),
      `registry 声明 ${declaredKeys.length} 项，面板渲染 ${renderedKeys.length} 项，两者不一致`,
    );

    // 分类切换器也要与 registry 一致
    const renderedTabs = Array.from(
      doc.querySelectorAll(`#${config.addonRef}-preferences-tabs radio`),
    ).map((el) => el.getAttribute("value"));
    assert.deepEqual(
      [...renderedTabs].sort(),
      SETTINGS_CATEGORIES.map((c) => c.id).sort(),
      "分类切换器与 registry 的分类不一致",
    );

    // 每个设置项都必须真的被本地化过（label 非空），否则界面上会是空白
    for (const el of Array.from(doc.querySelectorAll("[data-mzt-key]"))) {
      const control =
        (el as Element).querySelector("checkbox, menulist, textbox") ?? el;
      const label = control.getAttribute("label") ?? "";
      const text = (el as Element).textContent ?? "";
      assert.isAbove(
        (label + text).trim().length,
        0,
        `设置项 ${el.getAttribute("data-mzt-key")} 没有任何文案（本地化可能失败）`,
      );
    }
  });

  /**
   * XUL 的 checkbox / radio / menuitem 只认 label 属性。FTL 里若把文案写成普通值，
   * Fluent 会写进 textContent，界面上就变成「只有文字、控件本体不显示」——
   * 这个 bug 视觉上很容易被忽略，所以单独锁一条测试。
   */
  it("面板控件用的是 label 属性而不是纯文本（XUL 控件必须如此）", async function () {
    Zotero.Utilities.Internal.openPreferences(`${config.addonRef}-prefpane`);
    await new Promise((r) => setTimeout(r, 5000));

    const win: any = Services.wm.getMostRecentWindow("zotero:pref");
    assert.ok(win, "没有找到设置窗口");
    const doc: Document = win.document;

    const controls = Array.from(
      doc.querySelectorAll("checkbox, radio, menuitem"),
    );
    assert.isAbove(controls.length, 0, "面板里没有找到 XUL 控件");

    for (const control of controls) {
      if (!control.hasAttribute("data-l10n-id")) {
        continue;
      }
      assert.isAbove(
        (control.getAttribute("label") ?? "").trim().length,
        0,
        `<${control.localName} data-l10n-id="${control.getAttribute("data-l10n-id")}"> ` +
          `的 label 属性为空 —— FTL 文案可能写成了普通值，应改为 ".label = …"`,
      );
    }
  });

  /**
   * 顶部分类切换是这次设置界面改版的核心交互，必须真的能切换内容。
   */
  it("顶部分类切换器能真正切换内容", async function () {
    const doc = await openPaneAndGetDocument();
    const ids = SETTINGS_CATEGORIES.map((category) => category.id);

    for (const active of ids) {
      const radio = doc.querySelector(
        `#${config.addonRef}-preferences-tabs radio[value="${active}"]`,
      );
      assert.ok(radio, `切换器里没有找到分类 ${active}`);
      (radio as any).click();
      await new Promise((r) => setTimeout(r, 120));

      for (const other of ids) {
        const section = doc.getElementById(
          `${config.addonRef}-category-${other}`,
        ) as any;
        assert.ok(section, `面板里没有分类区块 ${other}`);
        assert.equal(
          !!section.hidden,
          other !== active,
          `选中「${active}」时，分类 ${other} 的显示状态不对`,
        );
      }
    }
  });

  /**
   * 本面板**不自己做搜索框** —— Zotero 设置窗口顶部自带一个（`#prefs-search`），
   * 而且它本来就会加载并搜索全部面板（preferences.js:677-686）。
   * 这里验证的是：用 Zotero 自带搜索，能搜到我们面板里的设置项。
   */
  it("Zotero 自带搜索能搜到本插件面板的设置项", async function () {
    const doc = await openPaneAndGetDocument();

    // 不该再有自建的搜索框
    assert.isNull(
      doc.getElementById(`${config.addonRef}-preferences-search`),
      "面板里仍有自建搜索框，与 Zotero 自带搜索重复",
    );

    const nativeSearch = doc.getElementById("prefs-search") as any;
    assert.ok(nativeSearch, "设置窗口里没有找到 Zotero 自带的搜索框");

    const runSearch = async (term: string) => {
      nativeSearch.value = term;
      nativeSearch.dispatchEvent(
        new (doc.defaultView as any).Event("command", { bubbles: true }),
      );
      // Zotero 的 _search 是串行的 async，给足时间
      await new Promise((r) => setTimeout(r, 900));
    };

    try {
      // 「分隔符」只出现在「文献列表」分类里。
      // 先停在别的分类上，验证搜索能跨分类把匹配项露出来。
      (
        doc.querySelector(
          `#${config.addonRef}-preferences-tabs radio[value="aggregation"]`,
        ) as any
      ).click();
      await new Promise((r) => setTimeout(r, 120));

      await runSearch("分隔符");

      const paneRoot = doc.getElementById(
        `${config.addonRef}-preferences-root`,
      ) as any;
      assert.ok(paneRoot, "面板容器不存在");

      /*
       * 判据来自 Zotero 自己的逻辑（preferences.js:769-778）：
       *   命中 → 高亮；没命中 → 给 root 加 `hidden-by-search`；
       *   root 全被标记时，连 pane-container 一起隐藏。
       * 所以「root 没被标记」就等于「Zotero 在它里面找到了匹配」。
       *
       * 注：不能断言 search-tooltip-parent（高亮）—— 在测试环境下连内置面板
       * 也产生不了高亮，那是测试环境的问题，不是面板的问题。
       */
      assert.isFalse(
        paneRoot.classList.contains("hidden-by-search"),
        "搜索「分隔符」时，本面板被判为「没有匹配」—— " +
          "说明 Zotero 自带搜索看不到本面板的内容",
      );
      assert.isFalse(
        paneRoot.parentElement?.classList.contains("hidden-by-search"),
        "整个面板容器被搜索隐藏了",
      );

      // 反向对照：搜一个肯定不存在的词，root 应当被判为不匹配。
      // 没有这一步，「没被标记」也可能只是因为搜索压根没跑到本面板。
      await runSearch("zzz不存在的词zzz");
      assert.isTrue(
        paneRoot.classList.contains("hidden-by-search"),
        "搜索不存在的词时，本面板没有被判为「无匹配」—— " +
          "说明上面的判据不成立（搜索可能根本没覆盖到本面板）",
      );

      // 搜索期间，别的分类（含匹配项的那个）必须被放开，
      // 否则匹配项虽然被 Zotero 标记了，用户也看不到。
      await runSearch("分隔符");
      const itemListSection = doc.getElementById(
        `${config.addonRef}-category-itemList`,
      ) as any;
      assert.isFalse(
        !!itemListSection?.hidden,
        "搜索期间「文献列表」分类仍被我们隐藏着，匹配项看不到",
      );
    } finally {
      await runSearch("");
    }
  });

  before(function () {
    Zotero.Prefs.set(RECURSIVE_PREF, false);
  });

  after(function () {
    Zotero.Prefs.set(RECURSIVE_PREF, false);
    setSmartRecursionMode(MODE_EMPTY_ONLY);
  });

  it("插件实例已注册", function () {
    assert.isNotEmpty(Zotero[config.addonInstance]);
  });

  it("已注册「来源子分类」自定义列（官方 ItemTreeManager API）", function () {
    const columns = Zotero.ItemTreeManager.getCustomColumns();
    const found = columns.find((column) =>
      column.dataKey.includes("sourceCollection"),
    );
    assert.ok(
      found,
      `未找到自定义列，当前已注册: ${columns.map((c) => c.dataKey).join(", ") || "(无)"}`,
    );
  });

  it("已包装 CollectionTreeRow.getSearchObject", function () {
    const fn = Zotero.CollectionTreeRow.prototype.getSearchObject;
    assert.isFunction(fn);
    assert.include(
      fn.toString(),
      "shouldAggregate",
      "getSearchObject 看起来没有被本插件包装",
    );
  });

  it("关闭功能时，无直属条目的分类保持为空（等同 Zotero 原生默认行为）", async function () {
    const target = await findAggregatableCollection();
    assert.ok(
      target,
      "测试库中没有「无直属条目但有子分类条目」的分类，无法验证",
    );

    Zotero.Prefs.set(RECURSIVE_PREF, false);
    setSmartRecursionMode(MODE_OFF);
    try {
      assert.lengthOf(await searchIds(makeRow(target.collection)), 0);
    } finally {
      setSmartRecursionMode(MODE_EMPTY_ONLY);
    }
  });

  it("【核心】无直属条目的分类：插件结果与 Zotero 自带全局递归逐条一致", async function () {
    const target = await findAggregatableCollection();
    assert.ok(target, "测试库中没有可聚合的分类");

    // 基准：Zotero 自带开关打开 + 插件功能关闭
    Zotero.Prefs.set(RECURSIVE_PREF, true);
    setSmartRecursionMode(MODE_OFF);
    const nativeIds = await searchIds(makeRow(target.collection));

    // 被测：Zotero 自带开关关闭 + 插件功能打开
    Zotero.Prefs.set(RECURSIVE_PREF, false);
    setSmartRecursionMode(MODE_EMPTY_ONLY);
    const pluginIds = await searchIds(makeRow(target.collection));

    assert.isAbove(
      nativeIds.length,
      0,
      `基准结果为空，测试数据不合适（分类「${target.collection.name}」）`,
    );
    assert.deepEqual(
      pluginIds,
      nativeIds,
      `分类「${target.collection.name}」：插件产出 ${pluginIds.length} 条，` +
        `Zotero 原生递归产出 ${nativeIds.length} 条，两者不一致`,
    );
  });

  it("【核心】聚合后用户看到的顶层条目数 = 子分类条目并集", async function () {
    const target = await findAggregatableCollection();
    assert.ok(target, "测试库中没有可聚合的分类");

    Zotero.Prefs.set(RECURSIVE_PREF, false);
    setSmartRecursionMode(MODE_EMPTY_ONLY);

    const ids = await searchIds(makeRow(target.collection));
    const items = await Zotero.Items.getAsync(ids);
    const topLevel = items.filter((item: any) => !item.parentItemID).length;

    const expected = await expectedTopLevelCount(target.descendants);
    assert.isAbove(expected, 0, "子分类里没有顶层条目，测试数据不合适");
    assert.equal(
      topLevel,
      expected,
      `分类「${target.collection.name}」应显示 ${expected} 条顶层条目，实际 ${topLevel} 条`,
    );
  });

  it("【核心】有直属条目的分类不被聚合（与关闭功能时完全一致）", async function () {
    const target = await findCollectionWithDirectItems();
    assert.ok(target, "测试库中没有「有直属条目且子分类也有条目」的分类");

    Zotero.Prefs.set(RECURSIVE_PREF, false);

    setSmartRecursionMode(MODE_EMPTY_ONLY);
    const withFeature = await searchIds(makeRow(target.collection));

    setSmartRecursionMode(MODE_OFF);
    const withoutFeature = await searchIds(makeRow(target.collection));

    setSmartRecursionMode(MODE_EMPTY_ONLY);

    assert.isAbove(withFeature.length, 0, "该分类本身应有条目");
    assert.deepEqual(
      withFeature,
      withoutFeature,
      `分类「${target.collection.name}」被不该有的聚合影响了`,
    );
  });

  it("【核心】有直属条目的分类：结果必须少于「聚合子分类」后的数量", async function () {
    const target = await findCollectionWithDirectItems();
    assert.ok(target, "测试库中没有合适的分类");

    Zotero.Prefs.set(RECURSIVE_PREF, false);
    setSmartRecursionMode(MODE_EMPTY_ONLY);
    const plain = await searchIds(makeRow(target.collection));

    // 用 Zotero 自带的全局递归算出「如果真的聚合了」会是多少
    Zotero.Prefs.set(RECURSIVE_PREF, true);
    setSmartRecursionMode(MODE_OFF);
    const recursive = await searchIds(makeRow(target.collection));
    Zotero.Prefs.set(RECURSIVE_PREF, false);

    assert.isAbove(
      recursive.length,
      plain.length,
      `分类「${target.collection.name}」的子分类没有额外条目，无法验证未聚合`,
    );
  });

  /* ------------------------------------------------------------------ */
  /* 功能④：阅读状态                                                     */
  /* ------------------------------------------------------------------ */

  it("已注册「阅读状态」列与两个右键菜单", function () {
    const columns = Zotero.ItemTreeManager.getCustomColumns();
    assert.isTrue(
      columns.some((column) => column.dataKey.includes("readingStatus")),
      `没有注册阅读状态列，现有列: ${columns.map((c) => c.dataKey).join(", ")}`,
    );

    // MenuManager 把 id 存成 CSS.escape(pluginID + "-" + menuID)，所以用后缀匹配
    const menuIDs = registeredItemMenuIDs();
    for (const suffix of ["reading-status-menu", "export-bundle-menu"]) {
      assert.isTrue(
        menuIDs.some((id) => id.endsWith(`${config.addonRef}-${suffix}`)),
        `菜单 ${suffix} 未注册，现有: ${menuIDs.join(", ")}`,
      );
    }
  });

  /**
   * 回归测试：MenuManager 内部把 id 存成 CSS.escape(pluginID + "-" + menuID)，
   * `unregisterMenu()` 必须收到**注册时返回的**那个 key。
   * 之前这里传的是原始 menuID，注销静默失败（Zotero 只打一条
   * "Can't remove unknown option" 的日志），插件关闭时菜单清不掉。
   */
  it("右键菜单能注销并重新注册（unregister 必须用注册返回的 key）", function () {
    const before = registeredItemMenuIDs().slice().sort();
    assert.isAbove(before.length, 0, "注册前就没有菜单，测试无意义");

    // 必须用插件运行时的那份模块实例：测试里 import 到的是另一个副本，
    // 它的注册状态是空的，调 unregister 不会有任何效果。
    const api = (Zotero as any)[config.addonInstance]?.api;
    assert.ok(api?.readingStatus, "addon.api 上没有暴露 readingStatus");
    assert.ok(api?.exportBundle, "addon.api 上没有暴露 exportBundle");
    assert.ok(api?.structuredFields, "addon.api 上没有暴露 structuredFields");

    api.readingStatus.unregister();
    api.exportBundle.unregister();
    api.structuredFields.unregister();
    const during = registeredItemMenuIDs();
    assert.equal(during.length, 0, `注销后仍有残留菜单: ${during.join(", ")}`);

    api.readingStatus.register();
    api.exportBundle.register();
    api.structuredFields.register();
    assert.deepEqual(
      registeredItemMenuIDs().slice().sort(),
      before,
      "重新注册后的菜单与注销前不一致",
    );
  });

  /**
   * 菜单文案走主窗口的 document.l10n，而插件的 FTL 必须由插件自己用
   * insertFTLIfNeeded 注入主窗口才会生效。不注入的话菜单项是空的——
   * 这个失败很隐蔽，所以单独锁一条测试。
   */
  it("主窗口已注册插件 FTL（右键菜单文案依赖它）", async function () {
    const win: any = Zotero.getMainWindow();
    assert.ok(win, "没有主窗口");
    assert.ok(win.document.l10n, "主窗口没有 document.l10n");

    const ids = [
      `${config.addonRef}-menu-reading-status`,
      `${config.addonRef}-menu-export-bundle`,
    ];
    const messages = await win.document.l10n.formatMessages(
      ids.map((id) => ({ id })),
    );

    for (const [index, message] of messages.entries()) {
      const label = message?.attributes?.find(
        (attribute: any) => attribute.name === "label",
      )?.value;
      assert.isOk(
        label,
        `主窗口解析不到 ${ids[index]} 的 .label —— ` +
          `FTL 可能没有通过 insertFTLIfNeeded 注入主窗口`,
      );
    }
  });

  it("阅读状态：标记、互斥与清除", async function () {
    const item = await firstRegularItem();
    const tagNames = () => item.getTags().map((entry: any) => entry.tag);

    // 先清干净，避免受上次运行影响
    await readingStatus.setReadingState([item], null);
    assert.isNull(readingStatus.getReadingState(item), "初始状态应为空");

    await readingStatus.setReadingState([item], "todo");
    assert.equal(readingStatus.getReadingState(item), "todo");
    assert.include(tagNames(), "mzt/todo");

    // 关键：三个状态互斥，标成「在读」后「待读」必须消失
    await readingStatus.setReadingState([item], "doing");
    assert.equal(readingStatus.getReadingState(item), "doing");
    assert.include(tagNames(), "mzt/doing");
    assert.notInclude(tagNames(), "mzt/todo", "旧状态标签没有被清掉");

    await readingStatus.setReadingState([item], "done");
    assert.equal(readingStatus.getReadingState(item), "done");
    assert.notInclude(tagNames(), "mzt/doing");

    await readingStatus.setReadingState([item], null);
    assert.isNull(readingStatus.getReadingState(item), "清除后应无状态");
    for (const state of ["todo", "doing", "done"]) {
      assert.notInclude(tagNames(), `mzt/${state}`);
    }
  });

  it("阅读状态：列显示本地化后的状态名", async function () {
    const item = await firstRegularItem();
    await readingStatus.setReadingState([item], "todo");

    const column = Zotero.ItemTreeManager.getCustomColumns().find((entry) =>
      entry.dataKey.includes("readingStatus"),
    ) as any;
    assert.ok(column, "没有阅读状态列");
    assert.equal(column.dataProvider(item), "待读");

    await readingStatus.setReadingState([item], null);
    assert.equal(column.dataProvider(item), "", "无状态时应返回空字符串");
  });

  /* ------------------------------------------------------------------ */
  /* 功能⑤：导出数据包                                                   */
  /* ------------------------------------------------------------------ */

  it("导出数据包：生成 index.csv 与每篇一个 Markdown", async function () {
    const items = await firstRegularItems(3);
    assert.isAbove(items.length, 0, "测试库中没有可用条目");

    const result = await exportBundle.buildBundle(
      items,
      Zotero.DataDirectory.dir,
    );

    try {
      assert.isTrue(
        Zotero.File.pathToFile(result.dir).exists(),
        `导出目录没有生成: ${result.dir}`,
      );
      assert.equal(result.count, items.length);

      // index.csv：要有表头，且每篇都在
      const csv = String(
        (await Zotero.File.getContentsAsync(
          childPath(result.dir, "index.csv"),
        )) ?? "",
      );
      assert.include(csv, "key,title,creators");
      for (const item of items) {
        assert.include(csv, item.key, `index.csv 里没有 ${item.key}`);
      }

      // papers/：每篇一个 Markdown，含元数据与全文小节
      for (const [index, item] of items.entries()) {
        const name = `${String(index + 1).padStart(4, "0")}-${item.key}.md`;
        const markdown = String(
          (await Zotero.File.getContentsAsync(
            childPath(result.dir, "papers", name),
          )) ?? "",
        );
        assert.include(
          markdown,
          `- **ZoteroKey**: ${item.key}`,
          `${name} 里没有元数据`,
        );
        assert.include(markdown, "## Fulltext", `${name} 里没有全文小节`);
      }
    } finally {
      // 清理，避免污染测试数据目录
      try {
        Zotero.File.pathToFile(result.dir).remove(true);
      } catch (e) {
        Zotero.debug(`清理导出目录失败: ${e}`);
      }
    }
  });

  /* ------------------------------------------------------------------ */
  /* 回归：阅读状态不得挤掉已有彩色标签的键位                            */
  /* ------------------------------------------------------------------ */

  /**
   * Zotero 用数字键 1-9 给条目快速打彩色标签，**position 就是键位**
   * （collectionViewItemTree.js:1966-1974）。而 Tags.setColor 指定位置时是
   * splice 插入（data/tags.js:721），会把它后面的标签往后挤。
   *
   * 之前我们的代码传了 position 0/1/2，一旦使用就会把用户的「双语已译」
   * 从键 1 挤到键 3。这条测试锁死这个行为。
   */
  it("阅读状态上色不会改动已有彩色标签的键位", async function () {
    const libraryID = Zotero.Libraries.userLibraryID;
    const snapshot = () =>
      [...(Zotero.Tags.getColors(libraryID) as Map<string, any>).entries()]
        .map(([name, data]) => `${name}@${data.position}`)
        .sort();

    const before = snapshot();
    const usersBefore = before.filter((entry) => !entry.startsWith("mzt/"));

    // 触发我们的上色逻辑
    const item = await firstRegularItem();
    await readingStatus.setReadingState([item], "todo");

    const after = snapshot();

    // 1) 用户已有的彩色标签位置必须一个都不变
    //    （测试库快照里带着用户真实的「双语已译 @0 / 待翻译 @1」）
    for (const entry of usersBefore) {
      assert.include(
        after,
        entry,
        `已有彩色标签的键位被改动了：${entry} 不在 [${after.join(", ")}] 里`,
      );
    }

    // 2) 我们的状态标签必须排在**所有用户标签之后**，不能插队
    const usersAfter = after.filter((entry) => !entry.startsWith("mzt/"));
    const ours = after.filter((entry) => entry.startsWith("mzt/"));
    assert.isAbove(ours.length, 0, "状态标签没有上色");
    for (const entry of ours) {
      const position = Number(entry.split("@")[1]);
      assert.isAtLeast(
        position,
        usersAfter.length,
        `状态标签 ${entry} 插到了用户标签前面（抢了数字键键位）。` +
          `用户标签 ${usersAfter.length} 个: [${usersAfter.join(", ")}]`,
      );
    }

    // 3) 再跑一次不应重复写入（已有颜色就跳过）
    await readingStatus.setReadingState([item], "doing");
    assert.deepEqual(snapshot(), after, "重复上色改动了标签颜色设置");
  });

  /* ------------------------------------------------------------------ */
  /* 功能⑥：库体检（只读）                                               */
  /* ------------------------------------------------------------------ */

  /**
   * 这条测试覆盖了一个很容易搞错的点：**回收站里的东西等于已经处理过了**，
   * 不能再报成待办问题。测试库快照里那 15 个「重复分类」实际上全在回收站
   * （`deletedCollections`），所以正确行为是：
   *   - 不出现「重复分类树」问题项
   *   - 它们出现在「回收站」这一项里，供用户决定要不要清空
   */
  it("库体检：回收站里的重复分类树不算问题，但要单独汇报", async function () {
    const libraryID = Zotero.Libraries.userLibraryID;
    const countItems = async () =>
      (await Zotero.Items.getAllIDs(libraryID)).length;
    const countCollections = async () =>
      ((await (Zotero.Collections as any).getAllIDs(libraryID)) ?? []).length;
    const before = {
      items: await countItems(),
      collections: await countCollections(),
    };

    const report = await libraryAudit.collectFindings();

    // 只读：扫描前后数量必须一致
    assert.equal(await countItems(), before.items, "体检改动了条目数");
    assert.equal(
      await countCollections(),
      before.collections,
      "体检改动了分类数",
    );

    assert.isAbove(report.counts.contentItems, 0, "没有扫到内容条目");
    assert.isAbove(report.counts.collections, 0, "没有扫到分类");
    assert.isString(report.markdown);
    assert.include(report.markdown, "库体检报告", "报告缺少标题");

    // 先确认前提：快照里确实有同名分类，而且它们都在回收站里
    const allCollections = await (Zotero.Collections as any).getAsync(
      await (Zotero.Collections as any).getAllIDs(libraryID),
    );
    const alive = allCollections.filter((c: any) => !c.deleted);
    const trashed = allCollections.filter((c: any) => c.deleted);
    const nameCount = new Map<string, number>();
    for (const collection of alive) {
      const name = String(collection?.name ?? "").trim();
      if (name) {
        nameCount.set(name, (nameCount.get(name) ?? 0) + 1);
      }
    }
    const aliveDupGroups = [...nameCount.values()].filter((n) => n > 1).length;
    assert.isAbove(trashed.length, 0, "快照里没有回收站分类，测试无意义");
    assert.equal(
      aliveDupGroups,
      0,
      `前提不成立：存活分类里仍有 ${aliveDupGroups} 组同名，` +
        `说明快照状态与预期不同（预期：重复的那套已全部在回收站）`,
    );

    // 正确行为：存活分类里没有重复 → 不该出现「重复分类树」问题项
    const dupCollections = report.findings.find(
      (finding) => finding.group === "重复分类树",
    );
    assert.isUndefined(
      dupCollections,
      "回收站里的重复分类树被报成了待处理问题",
    );

    // 但必须单独汇报回收站内容（清空回收站会永久删除文件，是决策不是清理）
    const trash = report.findings.find((finding) =>
      finding.group.startsWith("回收站"),
    );
    assert.ok(trash, "没有汇报回收站内容");
    assert.include(
      trash.summary,
      String(trashed.length),
      `回收站分类数不对：库里 ${trashed.length}，报告里没提到`,
    );
    assert.isTrue(
      trash.details.some((line) => line.includes("不计入上面的问题清单")),
      "没有说明回收站里的分类不算问题",
    );
  });

  it("库体检：能判定出 Zotero 自带重复检测的盲区", async function () {
    // 1) 附件与笔记被 Zotero 明确排除（duplicates.js:283、:305）
    const attachment = await firstAttachment();
    const items = await firstRegularItems(1);
    assert.ok(attachment, "测试库里没有附件，无法验证盲区判定");
    assert.isAbove(items.length, 0);

    const verdict = libraryAudit.zoteroWouldFindDuplicate(items[0], attachment);
    assert.isFalse(verdict.found, "附件应被判定为「Zotero 不会发现」");
    assert.include(
      verdict.reason,
      "附件",
      `漏检原因里应当说明是附件被排除，实际: ${verdict.reason}`,
    );

    // 2) 标题归一化：混入 HTML 标签后，两份「看起来一样」的标题不再相等，
    //    这正是快照里那一对被漏检的原因
    assert.equal(
      libraryAudit.normalizeForDuplicates("Foo Bar"),
      libraryAudit.normalizeForDuplicates("foo, bar"),
      "标点与大小写应当被归一化掉",
    );
    assert.notEqual(
      libraryAudit.normalizeForDuplicates("Foo Bar"),
      libraryAudit.normalizeForDuplicates('Foo <span style="x">Bar</span>'),
      "混入 HTML 后归一化结果应当不同（这正是 Zotero 漏检的原因）",
    );
  });

  /* ------------------------------------------------------------------ */
  /* 功能⑦：结构化字段                                                   */
  /* ------------------------------------------------------------------ */

  it("结构化字段：写入、读取与删除（Extra 里 key: value）", async function () {
    const item = await firstRegularItem();

    await structuredFields.writeFields(item, {
      载体类型: "聚脲微囊",
      粒径: "200 nm",
    });

    const fields = structuredFields.readFields(item);
    assert.equal(fields.get("载体类型"), "聚脲微囊");
    assert.equal(fields.get("粒径"), "200 nm");

    // 必须真的落在 Extra 里，且带前缀
    const extra = String(item.getField("extra") ?? "");
    assert.include(extra, "mzt.载体类型: 聚脲微囊");
    assert.include(extra, "mzt.粒径: 200 nm");

    // 不能破坏 Extra 里原有的内容
    const before = extra
      .split(/\r?\n/)
      .filter((line) => !line.startsWith("mzt."));
    await structuredFields.writeFields(item, { 助剂: "SDBS" });
    const after = String(item.getField("extra") ?? "")
      .split(/\r?\n/)
      .filter((line) => !line.startsWith("mzt."));
    assert.deepEqual(after, before, "写结构化字段时破坏了 Extra 里的其它内容");

    // 空字符串 = 删除
    await structuredFields.writeFields(item, { 粒径: "" });
    assert.isFalse(
      structuredFields.readFields(item).has("粒径"),
      "空值没有删除字段",
    );

    // 清理
    await structuredFields.writeFields(item, { 载体类型: "", 助剂: "" });
    assert.equal(
      structuredFields.readFields(item).size,
      0,
      "清理后仍有残留字段",
    );
  });

  it("结构化字段：能汇成跨论文对比表并渲染成 CSV / Markdown", async function () {
    const items = await firstRegularItems(3);
    assert.isAtLeast(items.length, 2, "测试库条目不足以验证对比表");

    await structuredFields.writeFields(items[0], {
      载体: "聚脲",
      粒径: "200nm",
    });
    await structuredFields.writeFields(items[1], { 载体: "明胶", 药效: "90%" });

    try {
      const table = structuredFields.collectTable(items);
      assert.include(table.columns, "载体");
      assert.include(table.columns, "粒径");
      assert.include(table.columns, "药效");
      assert.equal(table.rows.length, items.length);
      assert.equal(table.rows[0].values["载体"], "聚脲");
      assert.equal(table.rows[1].values["药效"], "90%");

      // CSV：带表头与 BOM 之外的转义
      const csv = structuredFields.toCsv(table);
      assert.include(csv, "key,title,year,载体,粒径,药效");
      assert.include(csv, "聚脲");
      assert.include(csv, items[0].key);

      // Markdown：必须是合法表格
      const markdown = structuredFields.toMarkdown(table);
      assert.include(markdown, "| Zotero Key | 标题 | 年份 |");
      assert.include(markdown, "聚脲");
    } finally {
      for (const item of items) {
        await structuredFields.writeFields(item, {
          载体: "",
          粒径: "",
          药效: "",
        });
      }
    }
  });

  it("结构化字段：CSV 解析支持引号、逗号与换行", function () {
    const rows = structuredFields.parseCsv(
      'key,title,备注\nABCD1234,"含,逗号","含""引号"""\n',
    );
    assert.equal(rows.length, 2, `行数不对: ${JSON.stringify(rows)}`);
    assert.equal(rows[1][0], "ABCD1234");
    assert.equal(rows[1][1], "含,逗号");
    assert.equal(rows[1][2], '含"引号"');
  });

  /**
   * 条目信息面板区块用的是官方 `ItemPaneManager.registerSection`。
   * 这个 API **注册失败时只返回 false、不抛异常**，所以必须显式检查，
   * 否则界面里会静默地少一块。
   */
  it("结构化字段：条目面板区块已成功注册", function () {
    const manager = (Zotero as any).ItemPaneManager;
    assert.ok(manager, "当前 Zotero 没有 ItemPaneManager");

    const sections = manager.customSectionData?.options ?? [];
    const ids = sections.map((section: any) => String(section?.paneID ?? ""));
    assert.isTrue(
      ids.some((id) => id.includes(`${config.addonRef}-structured-fields`)),
      `没有注册结构化字段区块。已注册: ${ids.join(", ") || "(无)"}`,
    );

    // 必填的 sidenav 也要在（漏了它注册会静默失败）
    const ours = sections.find((section: any) =>
      String(section?.paneID ?? "").includes(
        `${config.addonRef}-structured-fields`,
      ),
    );
    assert.ok(ours?.sidenav, "区块缺少必填的 sidenav");
  });

  /**
   * 直接调用注册好的 onRender，验证区块真的能渲染出内容。
   * 比截图可靠：不依赖窗口里恰好选中了条目。
   */
  it("结构化字段：区块能渲染出字段行与编辑控件", async function () {
    const manager = (Zotero as any).ItemPaneManager;
    const sections = manager.customSectionData?.options ?? [];
    const ours = sections.find((section: any) =>
      String(section?.paneID ?? "").includes(
        `${config.addonRef}-structured-fields`,
      ),
    );
    assert.ok(ours, "没有注册结构化字段区块");

    const item = await firstRegularItem();
    await structuredFields.writeFields(item, { 载体: "聚脲微囊" });
    try {
      const doc: Document = (Zotero.getMainWindow() as any).document;

      // 只读模式：显示字段名与值
      const readBody = doc.createElement("div");
      ours.onRender({ doc, body: readBody, item, editable: false });
      assert.include(readBody.textContent ?? "", "载体", "没有显示字段名");
      assert.include(readBody.textContent ?? "", "聚脲微囊", "没有显示字段值");

      // 编辑模式：出现输入框与「添加」行
      const editBody = doc.createElement("div");
      ours.onRender({ doc, body: editBody, item, editable: true });
      assert.isAbove(
        editBody.querySelectorAll("input").length,
        0,
        "编辑模式下没有输入框",
      );
      assert.include(
        editBody.textContent ?? "",
        "添加",
        "编辑模式下没有「添加」按钮",
      );
    } finally {
      await structuredFields.writeFields(item, { 载体: "" });
    }
  });

  /** 库体检挂在「工具」菜单上，不是条目右键菜单 */
  it("库体检：命令已注册在「工具」菜单", function () {
    const options: any[] = (
      Zotero.MenuManager as any
    )._menuManager.getCustomMenuOptions("main/menubar/tools");
    const ids = options.map((option) => String(option.menuID));
    assert.isTrue(
      ids.some((id) => id.includes(`${config.addonRef}-library-audit`)),
      `工具菜单里没有库体检命令。已注册: ${ids.join(", ") || "(无)"}`,
    );
  });

  /* ------------------------------------------------------------------ */
  /* 功能⑧：元数据清洗                                                   */
  /* ------------------------------------------------------------------ */

  it("元数据清洗：能去掉 HTML 标签与实体", function () {
    assert.equal(
      metadataClean.cleanHtml(
        'Expression Pattern of Entire Cytochrome P450 Genes <span style="font-size:10pt">and Response</span>',
      ),
      "Expression Pattern of Entire Cytochrome P450 Genes and Response",
    );
    assert.equal(
      metadataClean.cleanHtml("A<br>B<i>C</i>"),
      "ABC",
      "换行标签与斜体标签应被去掉但保留文字",
    );
    assert.equal(
      metadataClean.cleanHtml("Tom &amp; Jerry &nbsp;&lt;x&gt;"),
      "Tom & Jerry <x>",
      "HTML 实体应被还原",
    );
    assert.equal(
      metadataClean.cleanHtml("农药微囊负载体系的构建及其药效调控"),
      "农药微囊负载体系的构建及其药效调控",
      "干净的中文标题不应被改动",
    );
    assert.equal(metadataClean.cleanHtml(""), "", "空值原样返回");
  });

  /**
   * 这条是「清洗 HTML 的真正价值」：Zotero 的重复检测靠标题归一化，
   * 标题里混了 HTML 就会让它失效 —— 清掉之后应当恢复。
   */
  it("元数据清洗：清掉 HTML 后 Zotero 的重复检测能重新匹配上", function () {
    const dirty = 'Foo Bar <span style="x">Baz</span>';
    const clean = "Foo Bar Baz";

    // 清洗前：归一化结果不同 → Zotero 认不出是重复
    assert.notEqual(
      libraryAudit.normalizeForDuplicates(dirty),
      libraryAudit.normalizeForDuplicates(clean),
      "前提不成立：混入 HTML 后归一化结果应当不同",
    );

    // 清洗后：归一化结果相同 → Zotero 能认出重复
    assert.equal(
      libraryAudit.normalizeForDuplicates(metadataClean.cleanHtml(dirty)),
      libraryAudit.normalizeForDuplicates(clean),
      "清洗后仍与干净标题的归一化结果不同，说明没真正修好",
    );
  });

  it("元数据清洗：language 字段收敛成 BCP-47", function () {
    for (const value of ["zh", "zh-CN", "chi", "Chinese", "中文", "简体中文"]) {
      assert.equal(
        metadataClean.normalizeLanguage(value),
        "zh-CN",
        `${value} 应当被收敛成 zh-CN`,
      );
    }
    for (const value of ["en", "eng", "English", "英文"]) {
      assert.equal(
        metadataClean.normalizeLanguage(value),
        "en",
        `${value} 应当被收敛成 en`,
      );
    }
    // 认不出来的一律原样返回，不猜
    assert.equal(metadataClean.normalizeLanguage("de"), "de");
    assert.equal(metadataClean.normalizeLanguage(""), "");
  });

  it("元数据清洗：扫描能找出待改项，且不改动数据", async function () {
    const libraryID = Zotero.Libraries.userLibraryID;
    const before = (await Zotero.Items.getAllIDs(libraryID)).length;

    const plan = await metadataClean.planCleanup();

    assert.equal(
      (await Zotero.Items.getAllIDs(libraryID)).length,
      before,
      "扫描改动了条目数",
    );
    assert.isArray(plan.htmlChanges);
    assert.isArray(plan.languageChanges);
    // 测试库快照里确实有带 HTML 的标题与多种 language 写法
    assert.isAbove(
      plan.htmlChanges.length,
      0,
      "没有扫出待清理的 HTML（快照里应当有）",
    );
    assert.isAbove(
      plan.languageChanges.length,
      0,
      "没有扫出待规范的 language（快照里有 zh/zh-CN/en/eng/English）",
    );
    // 每一处改动都必须是真的「会变」
    for (const change of [...plan.htmlChanges, ...plan.languageChanges]) {
      assert.notEqual(change.before, change.after, "扫出了不会发生变化的项");
    }
  });

  it("元数据清洗：应用后确实写回条目", async function () {
    const items = await firstRegularItems(1);
    const item = items[0];
    const originalTitle = String(item.getField("title") ?? "");
    const originalLanguage = String(item.getField("language") ?? "");

    try {
      item.setField("title", 'Test <span style="x">Title</span> &amp; More');
      item.setField("language", "English");
      await item.saveTx();

      const plan = await metadataClean.planCleanup();
      const touched = [...plan.htmlChanges, ...plan.languageChanges].filter(
        (change) => change.item.id === item.id,
      );
      assert.isAbove(touched.length, 0, "扫描没有发现刚写进去的脏数据");

      await metadataClean.applyCleanup(plan);

      assert.equal(
        String(item.getField("title") ?? ""),
        "Test Title & More",
        "标题没有被正确清洗",
      );
      assert.equal(
        String(item.getField("language") ?? ""),
        "en",
        "language 没有被规范化",
      );
    } finally {
      item.setField("title", originalTitle);
      item.setField("language", originalLanguage);
      await item.saveTx();
    }
  });

  it("元数据清洗：命令已注册在「工具」菜单", function () {
    const options: any[] = (
      Zotero.MenuManager as any
    )._menuManager.getCustomMenuOptions("main/menubar/tools");
    const ids = options.map((option) => String(option.menuID));
    assert.isTrue(
      ids.some((id) => id.includes(`${config.addonRef}-metadata-clean`)),
      `工具菜单里没有元数据清洗命令。已注册: ${ids.join(", ") || "(无)"}`,
    );
  });

  /* ------------------------------------------------------------------ */
  /* 功能⑨：检查更新（含加速站测速）                                     */
  /* ------------------------------------------------------------------ */

  it("更新检查：版本号比较逻辑正确", function () {
    const cmp = updateChecker.compareVersions;
    assert.isAbove(cmp("0.3.0", "0.2.1"), 0, "0.3.0 应大于 0.2.1");
    assert.isBelow(cmp("0.2.1", "0.3.0"), 0, "0.2.1 应小于 0.3.0");
    assert.equal(cmp("0.2.1", "0.2.1"), 0, "同版本应相等");
    assert.isAbove(
      cmp("0.10.0", "0.9.0"),
      0,
      "0.10.0 应大于 0.9.0（按数字比而非字典序）",
    );
    assert.isBelow(cmp("0.2.1", "0.2.1-beta.1"), 0, "正式版应小于同号预发布版");
    assert.isAbove(cmp("1.0.0", "0.99.99"), 0);
  });

  /**
   * 加速站列表的解析：支持每行一个前缀、也支持 `direct`，
   * 并且**直连永远排在第一个**（能用就是最好的，不经第三方）。
   */
  it("更新检查：加速站列表解析正确", function () {
    const sources = updateChecker.listSources();
    assert.isAbove(sources.length, 1, "至少要有一个直连 + 一个加速站");
    assert.isTrue(sources[0].direct, "直连必须排在第一个");
    assert.equal(
      sources[0].resolve("https://example.com/x"),
      "https://example.com/x",
      "直连应原样返回，不加任何前缀",
    );

    const proxied = sources.filter((source) => !source.direct);
    assert.isAbove(proxied.length, 0, "没有解析出任何加速站");
    for (const source of proxied) {
      const resolved = source.resolve("https://example.com/x");
      assert.include(
        resolved,
        "https://example.com/x",
        `加速站的地址必须把原始 URL 完整保留在前缀之后，实际: ${resolved}`,
      );
      assert.notEqual(
        resolved,
        "https://example.com/x",
        "加速站不应原样返回（那样等于没走代理）",
      );
      assert.include(
        resolved,
        source.label,
        `解析后的地址应包含该站点的域名 ${source.label}，实际: ${resolved}`,
      );
    }
  });

  /** 清单地址必须由 package.json 的 repository.url 推导，且指向固定 tag `release` */
  it("更新检查：清单地址指向固定 tag 的 Release", function () {
    assert.include(
      updateChecker.MANIFEST_URL,
      "/releases/download/release/update.json",
      `清单地址不对: ${updateChecker.MANIFEST_URL}`,
    );
    assert.include(
      updateChecker.MANIFEST_URL,
      "Daxiang-zotero-tools",
      "清单地址没有指向本仓库",
    );
  });

  it("更新检查：命令已注册在「工具」菜单", function () {
    const options: any[] = (
      Zotero.MenuManager as any
    )._menuManager.getCustomMenuOptions("main/menubar/tools");
    const ids = options.map((option) => String(option.menuID));
    assert.isTrue(
      ids.some((id) => id.includes(`${config.addonRef}-update-check`)),
      `工具菜单里没有检查更新命令。已注册: ${ids.join(", ") || "(无)"}`,
    );
  });

  /* ------------------------------------------------------------------ */
  /* 功能⑩：文献自动入库（agent ↔ Zotero 衔接）                          */
  /* ------------------------------------------------------------------ */

  /**
   * Extra 标记是 agent ↔ 插件之间的**协议**，解析必须稳。
   * agent 会用 Local API 往 Extra 里写 `mzt.pendingDoi: 10.xxxx/yyyy`。
   */
  it("文献入库：能解析 Extra 里的 mzt.* 标记", async function () {
    const item = await firstRegularItem();
    const original = String(item.getField("extra") ?? "");

    try {
      item.setField(
        "extra",
        `一些别的内容\n${literatureIntake.PENDING_DOI_KEY}: 10.1016/j.cej.2026.178700\n另一行`,
      );
      await item.saveTx();

      assert.equal(
        literatureIntake.parseExtraMarker(
          item,
          literatureIntake.PENDING_DOI_KEY,
        ),
        "10.1016/j.cej.2026.178700",
        "没有正确解析出 DOI",
      );
      assert.isNull(
        literatureIntake.parseExtraMarker(
          item,
          literatureIntake.INTAKE_FLAG_KEY,
        ),
        "不存在的标记应返回 null",
      );

      // 大小写与空格容错（agent 手写 Extra 时很容易多空格）
      item.setField("extra", "  MZT.PendingDOI :   10.1/abc  ");
      await item.saveTx();
      assert.equal(
        literatureIntake.parseExtraMarker(
          item,
          literatureIntake.PENDING_DOI_KEY,
        ),
        "10.1/abc",
        "应容忍大小写与多余空格",
      );

      // intake 标记（agent 用它绕过任务分类）
      item.setField("extra", `${literatureIntake.INTAKE_FLAG_KEY}: 1`);
      await item.saveTx();
      assert.equal(
        literatureIntake.parseExtraMarker(
          item,
          literatureIntake.INTAKE_FLAG_KEY,
        ),
        "1",
      );
    } finally {
      item.setField("extra", original);
      await item.saveTx();
    }
  });

  /**
   * 任务分类解析：支持「分类名」和「完整路径」两种写法。
   * ⚠️ 必须用 getAllIDs + getAsync —— getByLibrary 只返回内存缓存里的分类
   * （库体检曾栽在这上面，只看到 31 个分类里的 16 个）。
   */
  it("文献入库：任务分类能按名称与路径解析", async function () {
    const libraryID = Zotero.Libraries.userLibraryID;
    const ids: number[] = await (Zotero.Collections as any).getAllIDs(
      libraryID,
    );
    const all = (
      (await (Zotero.Collections as any).getAsync(ids)) ?? []
    ).filter((collection: any) => collection && !collection.deleted);
    assert.isAbove(all.length, 0, "测试库里没有分类");

    const top = all.find((collection: any) => !collection.parentID);
    assert.ok(top, "没有顶层分类");

    const prefKey = `${PREFS_PREFIX}.intake.taskCollection`;
    const original = String(Zotero.Prefs.get(prefKey, true) ?? "");
    try {
      // 按名称
      Zotero.Prefs.set(prefKey, top.name, true);
      const byName = await literatureIntake.resolveTaskCollection();
      assert.ok(byName, `按名称「${top.name}」没解析出分类`);
      assert.equal(byName.name, top.name);

      // 按路径
      const child = all.find(
        (collection: any) => collection.parentID === top.id,
      );
      if (child) {
        Zotero.Prefs.set(prefKey, `${top.name}/${child.name}`, true);
        const byPath = await literatureIntake.resolveTaskCollection();
        assert.ok(byPath, `按路径「${top.name}/${child.name}」没解析出分类`);
        assert.equal(byPath.id, child.id, "路径解析到了错误的分类");
      }

      // 不存在时返回 null 而不是抛异常
      Zotero.Prefs.set(prefKey, "zzz不存在的分类zzz", true);
      assert.isNull(await literatureIntake.resolveTaskCollection());

      // 留空时也返回 null（未配置任务分类）
      Zotero.Prefs.set(prefKey, "", true);
      assert.isNull(await literatureIntake.resolveTaskCollection());
    } finally {
      Zotero.Prefs.set(prefKey, original, true);
    }
  });

  it("文献入库：命令已注册在「工具」菜单", function () {
    const options: any[] = (
      Zotero.MenuManager as any
    )._menuManager.getCustomMenuOptions("main/menubar/tools");
    const ids = options.map((option) => String(option.menuID));
    assert.isTrue(
      ids.some((id) => id.includes(`${config.addonRef}-intake`)),
      `工具菜单里没有文献入库命令。已注册: ${ids.join(", ") || "(无)"}`,
    );
  });

  /**
   * 任务分类改成了下拉选择，存的是**分类 key**。
   * 这条保证「key 能解析回分类」—— 分类改名后设置依然有效。
   */
  it("文献入库：任务分类存 key 时也能解析（改名后依然有效）", async function () {
    const libraryID = Zotero.Libraries.userLibraryID;
    const ids: number[] = await (Zotero.Collections as any).getAllIDs(
      libraryID,
    );
    const all = (
      (await (Zotero.Collections as any).getAsync(ids)) ?? []
    ).filter((collection: any) => collection && !collection.deleted);
    const target = all.find((collection: any) => collection.key);
    assert.ok(target, "测试库里没有分类");

    const prefKey = `${PREFS_PREFIX}.intake.taskCollection`;
    const original = String(Zotero.Prefs.get(prefKey, true) ?? "");
    try {
      Zotero.Prefs.set(prefKey, target.key, true);
      const resolved = await literatureIntake.resolveTaskCollection();
      assert.ok(resolved, `按 key「${target.key}」没解析出分类`);
      assert.equal(resolved.id, target.id, "解析到了错误的分类");
    } finally {
      Zotero.Prefs.set(prefKey, original, true);
    }
  });

  /**
   * 下拉选项必须来自真实分类，且值用 **key**、标签用**完整路径**。
   *
   * 为什么强调这两点：
   *   · 值用 key —— 库里有同名分类时（复制分类树之后很常见）按名字解析会选错，
   *     而且 key 在改名后依然有效
   *   · 标签用完整路径 —— 否则下拉里两个「除草剂」根本分不清是哪个
   */
  it("设置：分类下拉的选项来自真实分类，值是 key、标签是完整路径", async function () {
    const options = await optionSources.collectionOptions();

    assert.equal(options[0].value, "", "第一项应当是空值（不使用）");
    assert.isTrue(
      options[0].label.length > 0,
      "「不使用」选项的标签不能为空 —— 空标签会让下拉显示成一个空白方块（截图时发现）",
    );

    const real = options.slice(1);
    const libraryID = Zotero.Libraries.userLibraryID;
    const ids: number[] = await (Zotero.Collections as any).getAllIDs(
      libraryID,
    );
    const all = (
      (await (Zotero.Collections as any).getAsync(ids)) ?? []
    ).filter((collection: any) => collection && !collection.deleted);
    assert.equal(
      real.length,
      all.length,
      `下拉选项数 ${real.length} 与存活分类数 ${all.length} 不一致`,
    );

    const keys = new Set(all.map((c: any) => c.key));
    for (const option of real) {
      assert.isTrue(
        keys.has(option.value),
        `选项值 ${option.value} 不是真实分类 key`,
      );
      assert.isTrue(option.label.length > 0, "选项标签不能为空");
    }
    assert.equal(
      new Set(real.map((o) => o.value)).size,
      real.length,
      "下拉选项的值有重复",
    );

    // 有子分类时标签应当是「父 / 子」形式
    const child = all.find((c: any) => c.parentID);
    if (child) {
      const option = real.find((o) => o.value === child.key);
      assert.ok(option, "子分类没有出现在下拉里");
      assert.include(
        option.label,
        " / ",
        `子分类的标签应当是完整路径，实际: ${option.label}`,
      );
    }
  });

  /** registry 里声明的动态来源必须都能加载出内容，否则下拉会是空的 */
  it("设置：registry 声明的动态选项来源都能加载出内容", async function () {
    const sources: string[] = [];
    for (const category of SETTINGS_CATEGORIES) {
      for (const item of category.items ?? []) {
        if (item.optionsSource) {
          sources.push(item.optionsSource);
        }
      }
    }
    assert.isAbove(sources.length, 0, "registry 里没有声明任何动态选项来源");

    const index = await optionSources.loadOptionIndex(sources as any);
    for (const source of sources) {
      const options = (index as any)[source];
      assert.isArray(options, `来源「${source}」没有加载出数组`);
      assert.isAbove(
        options.length,
        1,
        `来源「${source}」只有 ${options?.length} 个选项，下拉会是空的`,
      );
    }
  });

  /** 任务分类必须是下拉，不能是输入框 —— 手填名字在同名分类时会选错 */
  it("设置：任务分类是下拉控件且绑定了动态来源", function () {
    const category = SETTINGS_CATEGORIES.find((c) => c.id === "intake");
    assert.ok(category, "没有文献入库分类");
    const item = (category.items ?? []).find(
      (i) => String(i.key) === "intake.taskCollection",
    );
    assert.ok(item, "没有任务分类设置项");
    assert.equal(item.kind, "menulist", "任务分类必须是下拉选择");
    assert.equal(
      item.optionsSource,
      "collections",
      "任务分类必须绑定 collections 动态来源",
    );
  });

  /**
   * 【核心】面板里真的渲染出了**有内容**的下拉。
   *
   * 这条比截图可靠：截图依赖窗口状态，而这里直接检查 DOM。
   * 之前的问题是任务分类是个空输入框，用户没法选分类。
   */
  it("设置：任务分类在面板里渲染成有选项的下拉", async function () {
    const doc = await openPaneAndGetDocument();

    const controlID = `zotero-prefpane-${config.addonRef}-intake-taskCollection`;
    const list: any = doc.getElementById(controlID);
    assert.ok(list, `面板里找不到任务分类控件 #${controlID}`);
    assert.equal(
      list.localName,
      "menulist",
      `任务分类应当是下拉，实际是 <${list.localName}>`,
    );

    const items = Array.from(list.querySelectorAll("menuitem")) as any[];
    assert.isAbove(
      items.length,
      1,
      `下拉里只有 ${items.length} 个选项（应当包含「不使用」+ 库里所有分类）`,
    );

    // 第一项是「不使用」
    assert.equal(
      items[0].getAttribute("value"),
      "",
      "第一项应当是空值（不使用）",
    );

    // 其余选项的值必须是真实的分类 key
    const libraryID = Zotero.Libraries.userLibraryID;
    const ids: number[] = await (Zotero.Collections as any).getAllIDs(
      libraryID,
    );
    const all = (
      (await (Zotero.Collections as any).getAsync(ids)) ?? []
    ).filter((collection: any) => collection && !collection.deleted);
    const keys = new Set(all.map((c: any) => c.key));
    const real = items.slice(1);
    assert.equal(
      real.length,
      all.length,
      `下拉选项数 ${real.length} 与存活分类数 ${all.length} 不一致`,
    );
    for (const item of real) {
      const value = item.getAttribute("value");
      assert.isTrue(keys.has(value), `选项值 ${value} 不是真实分类 key`);
      assert.isTrue(
        (item.getAttribute("label") ?? "").length > 0,
        "选项没有标签",
      );
    }

    // 标签应当是完整路径（含子分类时出现「 / 」）
    const child = all.find((c: any) => c.parentID);
    if (child) {
      const option = real.find(
        (i: any) => i.getAttribute("value") === child.key,
      );
      assert.ok(option, "子分类没有出现在下拉里");
      assert.include(
        option.getAttribute("label"),
        " / ",
        `子分类的标签应当是完整路径，实际: ${option.getAttribute("label")}`,
      );
    }
  });

  /**
   * 锁住文献入库补元数据路径的**核心契约**：
   * `translate({ libraryID: false })` 会**不落库**地返回条目对象
   * （translate.js:178-183 的注释：if we're not supposed to save the item,
   * just return the item array）。literatureIntake 正是靠这个把翻译器抓到的
   * 字段搬到已有条目上，而不是新建一个条目再删掉旧的。
   *
   * ⚠️ 这条测试要联网解析 DOI，而本机到学术站点的网络经常被阻断。
   * 所以拿不到结果时**跳过**而不是失败 —— 否则测试会随网络抖动变红，
   * 反而让人不再信任测试结果。
   */
  it("文献入库：翻译器能「不落库」地返回条目（补元数据路径的契约）", async function () {
    this.timeout(90000);
    const translate = new Zotero.Translate.Search();
    translate.setIdentifier({ DOI: "10.1002/ps.8586" } as any);
    const translators = await translate.getTranslators();
    if (!translators?.length) {
      this.skip();
      return;
    }
    translate.setTranslator(translators);

    let produced: any[] = [];
    try {
      produced = (await translate.translate({
        libraryID: false,
      } as any)) as any[];
    } catch (e) {
      Zotero.debug(`[MyZoteroTools] 翻译器调用失败（可能是网络）: ${e}`);
    }
    if (!produced?.length) {
      // 网络不通就跳过；但契约本身已由源码与下面的断言共同保证
      Zotero.debug("[MyZoteroTools] 翻译器没返回条目，跳过（多半是网络）");
      this.skip();
      return;
    }

    const first = produced[0];
    assert.isUndefined(
      first.id,
      "libraryID:false 时不应有 id —— 说明条目被落库了，补元数据路径会因此建出重复条目",
    );
    assert.equal(first.itemType, "journalArticle", "条目类型不对");
    assert.ok(first.title, "翻译器没有返回标题");
  });
});
