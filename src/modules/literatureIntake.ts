/**
 * 功能⑩：文献自动入库（agent ↔ Zotero 的衔接）
 *
 * ## 设计背景
 *
 * 目标是让 agent 全自动地把检索到的文献入库并下载 PDF。关键约束是：
 *
 *   · **agent 在 Zotero 进程外**，只能用 Zotero 10 的 Local API 写入
 *     （`http://127.0.0.1:23119/api/`，实测可用，支持建条目 / 挂分类 / 上传附件）
 *   · 但 Local API **没有「查找可用 PDF」能力**，也拿不到 Zotero 的元数据翻译器
 *   · 这两样恰好只能在插件里用
 *
 * 所以分工是：
 *
 *   agent（Local API 建条目 + 挂分类）→ 插件（Notifier 监听 → 补元数据 + 找 PDF）
 *
 * 两者**不需要 IPC、不需要轮询**，靠 Zotero 自己的数据事件衔接。
 *
 * ## 协议（agent 需要遵守的约定）
 *
 * 1. agent 通过 Local API 建条目，落在**任务分类**下；
 * 2. 若元数据需要 Zotero 翻译器补全（中文文献 / 学位论文 / 标准等），
 *    在条目的 Extra 里写一行：
 *
 *        mzt.pendingDoi: 10.xxxx/yyyy
 *
 *    插件会用它抓元数据并**原地改写该条目**（改类型、填字段、设作者），
 *    条目 key 与分类都不变。
 * 3. 若要让插件处理**不在任务分类下**的条目，在 Extra 里写：
 *
 *        mzt.intake: 1
 *
 * 4. 找不到可用 PDF 的条目会被打上标签 `mzt/需手动获取PDF`，agent 可据此回报。
 */

import { config } from "../../package.json";
import { getPref } from "../utils/prefs";
import { getLocaleID, getString } from "../utils/locale";

const MENU_ID = `${config.addonRef}-intake-menu`;
/** Extra 里的标记：让插件用翻译器补元数据 */
const PENDING_DOI_KEY = "mzt.pendingDoi";
/** Extra 里的标记：强制插件处理该条目（用于 agent 覆盖任务分类） */
const INTAKE_FLAG_KEY = "mzt.intake";
/** 找不到 PDF 时打的标签 */
const MISSING_PDF_TAG = "mzt/需手动获取PDF";
/** 收集事件的防抖窗口：agent 可能一次建几百条，攒一批再处理 */
const FLUSH_DELAY = 3000;

let menuKey: string | false = false;
let notifierID: string | null = null;
const pendingIds = new Set<number>();
let flushTimer: any = null;
let running = false;

export {
  register,
  unregister,
  flushPending,
  resolveTaskCollection,
  parseExtraMarker,
  markPendingExtraction,
  pickExtractionTargets,
  PENDING_DOI_KEY,
  INTAKE_FLAG_KEY,
  MISSING_PDF_TAG,
  PENDING_EXTRACT_TAG,
  EXTRACTED_TAG,
};

/* ------------------------------------------------------------------ */
/* 注册 / 注销                                                         */
/* ------------------------------------------------------------------ */

function register(): void {
  registerMenu();
  registerNotifier();
}

function unregister(): void {
  if (menuKey) {
    Zotero.MenuManager.unregisterMenu(menuKey);
    menuKey = false;
  }
  if (notifierID) {
    Zotero.Notifier.unregisterObserver(notifierID);
    notifierID = null;
  }
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  pendingIds.clear();
}

function registerMenu(): void {
  if (menuKey) {
    return;
  }
  menuKey = Zotero.MenuManager.registerMenu({
    menuID: MENU_ID,
    pluginID: config.addonID,
    target: "main/menubar/tools",
    menus: [
      {
        menuType: "menuitem",
        l10nID: getLocaleID("menu-intake-find-pdf"),
        onShowing: (event: any) => {
          const element = event?.target as any;
          if (element) {
            element.hidden = !getPref("intake.enabled");
          }
        },
        onCommand: () => {
          void findPdfForTaskCollection();
        },
      },
      {
        menuType: "menuitem",
        l10nID: getLocaleID("menu-intake-mark-extract"),
        onShowing: (event: any) => {
          const element = event?.target as any;
          if (element) {
            element.hidden = !getPref("intake.enabled");
          }
        },
        onCommand: () => {
          void markPendingForTaskCollection();
        },
      },
    ],
  } as any);
  if (!menuKey) {
    Zotero.debug("[MyZoteroTools] 注册文献入库菜单失败");
  }
}

/**
 * 监听条目新增事件。
 *
 * 两条触发路径：
 *   ① **常规条目**新增 → agent 用 Local API 建条目，插件接手补元数据 / 找 PDF
 *   ② **PDF 附件**新增 → 给父条目打「待抽取」标签，通知下游 agent 可以开始抽取
 *
 * ② 是「选中分类里新增 PDF 就自动抽取」的触发点。
 * 之所以用**标签**而不是直接调起外部进程：
 *   · 状态在 Zotero 里可见（用户能看到哪些待抽取、哪些已完成）
 *   · 重启后状态还在，可重试、可恢复
 *   · 下游只需 HTTP（Local API），不需要进程权限与路径约定
 */
function registerNotifier(): void {
  if (notifierID) {
    return;
  }
  try {
    notifierID = Zotero.Notifier.registerObserver(
      {
        notify: (event: string, type: string, ids: Array<string | number>) => {
          if (type !== "item" || event !== "add") {
            return;
          }
          if (!getPref("intake.enabled")) {
            return;
          }
          for (const id of ids) {
            if (typeof id === "number") {
              pendingIds.add(id);
            }
          }
          scheduleFlush();
        },
      },
      ["item"],
      `${config.addonRef}-intake`,
    );
  } catch (e) {
    Zotero.debug(`[MyZoteroTools] 注册入库监听失败: ${e}`);
  }
}

/* ------------------------------------------------------------------ */
/* 待抽取标记（PDF 新增 → 打标签，供下游 agent 轮询）                    */
/* ------------------------------------------------------------------ */

/** 待抽取标签 */
const PENDING_EXTRACT_TAG = "mzt/待抽取";
/** 抽取完成标签（由下游 agent 写回） */
const EXTRACTED_TAG = "mzt/已抽取";

/**
 * 给「任务分类下、有 PDF、还没标记过」的条目打上待抽取标签。
 *
 * 幂等：已带 `mzt/待抽取` 或 `mzt/已抽取` 的条目不重复打。
 */
async function markPendingExtraction(items: Zotero.Item[]): Promise<number> {
  if (!getPref("intake.tagForExtraction")) {
    return 0;
  }
  let marked = 0;
  for (const item of items) {
    try {
      if (!item.isRegularItem?.() || item.deleted) {
        continue;
      }
      if (!(await hasPdf(item))) {
        continue;
      }
      const tags = (item.getTags() ?? []).map((t: any) => t.tag);
      if (tags.includes(PENDING_EXTRACT_TAG) || tags.includes(EXTRACTED_TAG)) {
        continue;
      }
      item.addTag(PENDING_EXTRACT_TAG, 0);
      await item.saveTx();
      marked++;
    } catch (e) {
      Zotero.debug(`[MyZoteroTools] 打待抽取标签失败 (${item.key}): ${e}`);
    }
  }
  if (marked) {
    Zotero.debug(`[MyZoteroTools] 已标记 ${marked} 条待抽取`);
  }
  return marked;
}

/**
 * 把「附件」解析成它所属的常规条目。
 * PDF 附件新增时，要标记的是**父条目**，不是附件本身。
 */
function resolveParentItem(item: Zotero.Item): Zotero.Item | null {
  try {
    if (!item.isAttachment?.()) {
      return item.isRegularItem?.() ? item : null;
    }
    const parentID = item.parentItemID;
    if (!parentID) {
      return null;
    }
    const parent = Zotero.Items.get(parentID) as Zotero.Item | false;
    return parent && parent.isRegularItem?.() ? parent : null;
  } catch {
    return null;
  }
}

/**
 * 扫描任务分类，给所有「有 PDF 但没标记」的条目补打标签。
 * 用于插件当时没开、或历史数据的情况。
 */
async function markPendingForTaskCollection(): Promise<void> {
  const collection = await resolveTaskCollection();
  if (!collection) {
    notify(
      getString("intake-no-collection"),
      getString("intake-no-collection-hint"),
    );
    return;
  }
  const items = (collection.getChildItems(false) ?? []).filter(
    (item: Zotero.Item) => item.isRegularItem?.() && !item.deleted,
  );
  const marked = await markPendingExtraction(items);
  notify(
    getString("intake-marked"),
    getString("intake-marked-detail", {
      args: { count: marked, name: collection.name },
    }),
  );
}

function scheduleFlush(): void {
  if (flushTimer) {
    return;
  }
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushPending();
  }, FLUSH_DELAY);
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function flushPending(): Promise<void> {
  if (running) {
    return;
  }
  const ids = [...pendingIds];
  pendingIds.clear();
  if (!ids.length) {
    return;
  }

  running = true;
  try {
    const items = (await Zotero.Items.getAsync(ids)) as Zotero.Item[];
    const candidates = items.filter((item) => item && !item.deleted);

    /*
     * 新增的可能是**常规条目**（agent 建条目）也可能是**PDF 附件**
     * （插件自己找的 PDF、或 agent 上传的 PDF）。
     * 附件要追溯到父条目，否则「选中分类里新增 PDF 就自动抽取」这条链路接不上。
     */
    const fromAttachments = candidates
      .filter((item) => item.isAttachment?.() && isPdfAttachment(item))
      .map((attachment) => resolveParentItem(attachment))
      .filter((parent): parent is Zotero.Item => !!parent);
    const regularItems = candidates.filter((item) => item.isRegularItem?.());

    const targets = await pickTargets(regularItems);
    if (targets.length) {
      Zotero.debug(`[MyZoteroTools] 自动入库：${targets.length} 条需要处理`);
    }

    // 1. 先补元数据（有些条目补完才知道该挂什么 PDF）
    if (getPref("intake.resolveMetadata")) {
      for (const item of targets) {
        await resolvePendingMetadata(item);
      }
    }

    // 2. 再找 PDF（批量一次调用，addAvailableFiles 自带同域限速与进度队列）
    if (getPref("intake.autoFindPdf")) {
      const needPdf: Zotero.Item[] = [];
      for (const item of targets) {
        if (!(await hasPdf(item))) {
          needPdf.push(item);
        }
      }
      if (needPdf.length) {
        await findPdfs(needPdf);
      }
    }

    /*
     * 3. 最后打「待抽取」标签 —— 必须放在找 PDF **之后**，
     *    这样刚找到的 PDF 也能立刻触发下游抽取，不用等下一轮。
     *    判定放在这一步（而不是入口处）是为了拿到「找完 PDF 之后」的真实状态。
     */
    const candidatesForExtraction = await pickExtractionTargets([
      ...fromAttachments,
      ...targets,
    ]);
    await markPendingExtraction(candidatesForExtraction);
  } catch (e) {
    Zotero.logError(e as Error);
  } finally {
    running = false;
  }
}

/**
 * 哪些条目该打「待抽取」标签。
 *
 * 与 `pickTargets` 分开：pickTargets 决定「插件要不要动手」，
 * 这里决定「要不要通知下游抽取」——后者只关心**在任务分类下且有 PDF**。
 */
async function pickExtractionTargets(
  items: Zotero.Item[],
): Promise<Zotero.Item[]> {
  const taskCollection = await resolveTaskCollection();
  const taskID = taskCollection?.id ?? null;
  const seen = new Set<number>();

  return items.filter((item) => {
    if (!item || item.deleted || seen.has(item.id)) {
      return false;
    }
    seen.add(item.id);
    if (!item.isRegularItem?.()) {
      return false;
    }
    // 只对任务分类下的动手（②A）
    if (taskID === null) {
      return false;
    }
    try {
      return item.getCollections().includes(taskID);
    } catch {
      return false;
    }
  });
}

/**
 * PDF 附件判定。
 *
 * ⚠️ 方法名是 **`isPDFAttachment()`**，不是 `isPDF()`。
 * 写成 `isPDF?.()` 时可选链会**静默返回 undefined**，一律当成 false ——
 * 表现是「有 PDF 却永远判成没 PDF」，而且不报任何错（实测踩到，
 * 测试库里有 88 个 PDF，插件一个都认不出来）。
 */
function isPdfAttachment(item: Zotero.Item): boolean {
  try {
    return !!item.isPDFAttachment?.();
  } catch {
    return false;
  }
}

/** 判定哪些条目该由插件接手 */
async function pickTargets(items: Zotero.Item[]): Promise<Zotero.Item[]> {
  const taskCollection = await resolveTaskCollection();
  const taskID = taskCollection?.id ?? null;

  return items.filter((item) => {
    if (!item.isRegularItem?.()) {
      return false;
    }
    // 明确要求处理的（agent 覆盖任务分类的情况）
    if (parseExtraMarker(item, INTAKE_FLAG_KEY) !== null) {
      return true;
    }
    // 需要补元数据的
    if (parseExtraMarker(item, PENDING_DOI_KEY) !== null) {
      return true;
    }
    // 否则只看任务分类下的（②A：不对其它分类动手）
    if (taskID !== null) {
      try {
        return item.getCollections().includes(taskID);
      } catch {
        return false;
      }
    }
    return false;
  });
}

/* ------------------------------------------------------------------ */
/* 用 Zotero 翻译器补元数据                                            */
/* ------------------------------------------------------------------ */

/**
 * 若条目带 `mzt.pendingDoi` 标记，就用 Zotero 的检索翻译器抓元数据，
 * 并**原地改写该条目**（保留 key、分类、已有附件）。
 *
 * 关键点：`translate({ libraryID: false })` 会**不保存**地返回条目对象
 * （translate.js:178-183 的注释：if we're not supposed to save the item,
 * just return the item array），所以可以直接把字段搬过来。
 */
async function resolvePendingMetadata(item: Zotero.Item): Promise<void> {
  const doi = parseExtraMarker(item, PENDING_DOI_KEY);
  if (!doi) {
    return;
  }

  try {
    const translate = new Zotero.Translate.Search();
    translate.setIdentifier({ DOI: doi } as any);
    const translators = await translate.getTranslators();
    if (!translators?.length) {
      Zotero.debug(`[MyZoteroTools] 没有能处理 DOI ${doi} 的翻译器`);
      return;
    }
    translate.setTranslator(translators);
    const produced = (await translate.translate({
      libraryID: false,
    } as any)) as any[];
    const source = produced?.find((entry) => entry?.itemType);
    if (!source) {
      Zotero.debug(`[MyZoteroTools] DOI ${doi} 没有抓到元数据`);
      return;
    }

    applyMetadata(item, source);
    clearExtraMarker(item, PENDING_DOI_KEY);
    await item.saveTx();
    Zotero.debug(
      `[MyZoteroTools] 已用翻译器补全 ${item.key}（${source.itemType}）`,
    );
  } catch (e) {
    Zotero.debug(`[MyZoteroTools] 补元数据失败 (${doi}): ${e}`);
  }
}

/** 把翻译器抓到的条目字段搬到目标条目上 */
function applyMetadata(target: Zotero.Item, source: any): void {
  // 1. 条目类型（document → journalArticle 等）
  try {
    const typeID = Zotero.ItemTypes.getID(source.itemType);
    if (typeID && typeID !== target.itemTypeID) {
      target.setType(typeID);
    }
  } catch (e) {
    Zotero.debug(`[MyZoteroTools] 转换条目类型失败: ${e}`);
  }

  // 2. 字段：只写目标类型支持、且源里非空的
  const fields: Record<string, string> = source.fields ?? {};
  for (const [name, value] of Object.entries(fields)) {
    if (!value) {
      continue;
    }
    try {
      if (!Zotero.ItemFields.isValidForType(name, target.itemTypeID)) {
        continue;
      }
      target.setField(name as any, String(value));
    } catch {
      // 单个字段失败不影响其它字段
    }
  }

  // 3. 作者
  try {
    const creators = (source.creators ?? []).map((creator: any) => ({
      firstName: creator.firstName ?? "",
      lastName: creator.lastName ?? "",
      creatorType: creator.creatorType ?? "author",
      fieldMode: creator.fieldMode ?? 0,
    }));
    if (creators.length) {
      target.setCreators(creators as any);
    }
  } catch (e) {
    Zotero.debug(`[MyZoteroTools] 写入作者失败: ${e}`);
  }
}

/* ------------------------------------------------------------------ */
/* 查找可用 PDF                                                        */
/* ------------------------------------------------------------------ */

/** 用 Zotero 官方的「查找可用 PDF」，并给失败的条目打标签 */
async function findPdfs(items: Zotero.Item[]): Promise<void> {
  Zotero.debug(`[MyZoteroTools] 为 ${items.length} 条查找可用 PDF`);
  try {
    await (Zotero.Attachments as any).addAvailableFiles(items);
  } catch (e) {
    Zotero.debug(`[MyZoteroTools] 查找可用 PDF 失败: ${e}`);
  }

  // 复查：仍然没有 PDF 的，打标签标记出来（不假装成功）
  for (const item of items) {
    try {
      if (await hasPdf(item)) {
        continue;
      }
      item.addTag(MISSING_PDF_TAG, 0);
      await item.saveTx();
    } catch (e) {
      Zotero.debug(`[MyZoteroTools] 标记缺 PDF 失败 (${item.key}): ${e}`);
    }
  }
}

/**
 * 条目是否有 PDF 附件。
 *
 * ⚠️ 必须用**异步**的 `Zotero.Items.getAsync`，不能用同步的 `Zotero.Items.get` ——
 * 后者对**未加载到内存缓存**的条目直接返回 `false`，于是「有 PDF」会被误判成
 * 「没有 PDF」。实测：测试库里有 88 个 PDF，但同步版一个都认不出来
 * （表现为条目永远不被打「待抽取」标签、还反复被当成「缺 PDF」）。
 */
async function hasPdf(item: Zotero.Item): Promise<boolean> {
  try {
    const ids = item.getAttachments() ?? [];
    if (!ids.length) {
      return false;
    }
    const attachments = (await Zotero.Items.getAsync(ids)) as any[];
    return attachments.some((attachment) => attachment?.isPDFAttachment?.());
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 任务分类                                                            */
/* ------------------------------------------------------------------ */

/**
 * 解析「任务分类」设置。
 *
 * 设置里存的是**分类 key**（下拉选择时写入的），key 稳定、改名后依然有效。
 * 但为了兼容早期版本手填的名称，也支持：
 *   · 分类名：`除草剂`（同名多个时取第一个，并打日志）
 *   · 完整路径：`农药/国标`
 *
 * ⚠️ 用 getAllIDs + getAsync 而不是 getByLibrary —— 后者只返回内存缓存里的分类
 * （见 libraryAudit.ts 里同样的教训）。
 */
async function resolveTaskCollection(): Promise<any | null> {
  const spec = String(getPref("intake.taskCollection") ?? "").trim();
  if (!spec) {
    return null;
  }

  let all: any[];
  try {
    const ids: number[] = await (Zotero.Collections as any).getAllIDs(
      Zotero.Libraries.userLibraryID,
    );
    all = ((await (Zotero.Collections as any).getAsync(ids)) ?? []).filter(
      (collection: any) => collection && !collection.deleted,
    );
  } catch (e) {
    Zotero.debug(`[MyZoteroTools] 加载分类失败: ${e}`);
    return null;
  }

  // 1) 先按 key 找（下拉选择写入的就是 key）
  const byKey = all.find((collection: any) => collection.key === spec);
  if (byKey) {
    return byKey;
  }

  // 2) 回退：按名称或路径解析（兼容手填的旧值）
  const parts = spec
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) {
    return null;
  }

  const wantedName = parts[parts.length - 1];
  const candidates = all.filter((collection) => collection.name === wantedName);
  if (!candidates.length) {
    Zotero.debug(
      `[MyZoteroTools] 找不到任务分类「${spec}」（既不是有效的分类 key，也没有同名分类）`,
    );
    return null;
  }
  if (parts.length === 1) {
    if (candidates.length > 1) {
      Zotero.debug(
        `[MyZoteroTools] 有 ${candidates.length} 个同名分类「${wantedName}」，取 id=${candidates[0].id}。` +
          `建议改用设置里的下拉选择，避免选错。`,
      );
    }
    return candidates[0];
  }

  // 按路径逐级回溯匹配
  for (const candidate of candidates) {
    const chain: string[] = [];
    let current: any = candidate;
    let guard = 0;
    while (current && guard++ < 20) {
      chain.unshift(current.name);
      current = current.parentID
        ? all.find((entry) => entry.id === current.parentID)
        : null;
    }
    if (chain.join("/") === parts.join("/")) {
      return candidate;
    }
  }

  Zotero.debug(`[MyZoteroTools] 路径「${spec}」没有匹配到分类`);
  return null;
}

/* ------------------------------------------------------------------ */
/* 菜单命令：给任务分类下缺 PDF 的条目补 PDF                            */
/* ------------------------------------------------------------------ */

async function findPdfForTaskCollection(): Promise<void> {
  const collection = await resolveTaskCollection();
  if (!collection) {
    notify(
      getString("intake-no-collection"),
      getString("intake-no-collection-hint"),
    );
    return;
  }
  const candidates = (collection.getChildItems(false) ?? []).filter(
    (item: Zotero.Item) => item.isRegularItem?.() && !item.deleted,
  );
  // hasPdf 现在是异步的（同步版会漏判未加载的附件）
  const items: Zotero.Item[] = [];
  for (const item of candidates) {
    if (!(await hasPdf(item))) {
      items.push(item);
    }
  }
  if (!items.length) {
    notify(getString("intake-all-have-pdf"), collection.name);
    return;
  }
  notify(
    getString("intake-searching"),
    getString("intake-searching-detail", {
      args: { count: items.length, name: collection.name },
    }),
  );
  await findPdfs(items);
}

/* ------------------------------------------------------------------ */
/* Extra 标记读写                                                      */
/* ------------------------------------------------------------------ */

/** 读取 `mzt.xxx: value` 形式的 Extra 标记；没有则返回 null */
function parseExtraMarker(item: Zotero.Item, key: string): string | null {
  let extra: string;
  try {
    extra = String(item.getField("extra") ?? "");
  } catch {
    return null;
  }
  const pattern = new RegExp(
    `^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*(.*)$`,
    "i",
  );
  for (const line of extra.split(/\r?\n/)) {
    const match = line.match(pattern);
    if (match) {
      return match[1].trim();
    }
  }
  return null;
}

function clearExtraMarker(item: Zotero.Item, key: string): void {
  let extra: string;
  try {
    extra = String(item.getField("extra") ?? "");
  } catch {
    return;
  }
  const pattern = new RegExp(
    `^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`,
    "i",
  );
  const kept = extra
    .split(/\r?\n/)
    .filter((line) => !pattern.test(line))
    .filter((line) => line.trim());
  item.setField("extra", kept.join("\n"));
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function notify(headline: string, text = ""): void {
  try {
    const pw = new (Zotero as any).ProgressWindow({ closeOnClick: true });
    pw.changeHeadline(headline);
    if (text) {
      pw.addDescription(text);
    }
    pw.show();
    pw.startCloseTimer(8000);
  } catch (e) {
    Zotero.debug(`[MyZoteroTools] 提示失败: ${e}`);
  }
}
