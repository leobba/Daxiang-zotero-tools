/**
 * 功能⑥：库体检（只读）
 *
 * 解决的问题：Zotero 自带「重复条目」只处理**条目**，而且**明确排除附件和笔记**；
 * 重复的分类树则没有任何工具会检测。库里出了问题（例如换库/同步事故之后）
 * 往往没人发现。
 *
 * 本模块只做**扫描与报告**，绝不修改任何数据 —— 修复动作交给用户或后续功能。
 *
 * 检查项：
 *   1. 重复分类树（同库内同名分类）
 *   2. 重复条目（复刻 Zotero 自带算法，并额外标出**它会漏检**的那些）
 *   3. 元数据污染（标题/期刊名里混入 HTML 标签）
 *   4. 空分类（既无直属条目也无子分类）
 *   5. 孤立附件（没有父条目）
 *   6. 缺附件的条目
 *
 * 关于「Zotero 会漏检」的判定，见 `zoteroWouldFindDuplicate()`：
 * 它复刻了 `xpcom/duplicates.js` 的规则（归一化标题必须完全相等 + DOI/ISBN/年份
 * 不冲突 + 至少一个作者的姓与名首字母相同，且**排除附件与笔记**），
 * 所以能明确区分「Zotero 能发现」和「只有我们能发现」。
 */

import { config } from "../../package.json";
import { getPref } from "../utils/prefs";
import { getLocaleID, getString } from "../utils/locale";

const MENU_ID = `${config.addonRef}-library-audit-menu`;

/** 内容条目类型（用于把附件/笔记/批注排除在「条目」之外） */
const NON_CONTENT_TYPES = new Set(["attachment", "note", "annotation"]);

let menuKey: string | false = false;

export { register, unregister, runAudit, collectFindings };
// 纯函数单独导出，便于测试（也方便将来复用）
export { zoteroWouldFindDuplicate, normalizeForDuplicates };
export type { AuditReport, AuditFinding };

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

interface AuditFinding {
  /** 分组标题（重复分类树 / 重复条目 / …） */
  group: string;
  /** 一句话说明问题 */
  summary: string;
  /** 明细行 */
  details: string[];
  /** 影响条目数（用于排序与汇总） */
  severity: "high" | "medium" | "low";
}

interface AuditReport {
  libraryID: number;
  libraryName: string;
  scannedAt: string;
  counts: {
    contentItems: number;
    attachments: number;
    notes: number;
    collections: number;
  };
  findings: AuditFinding[];
  /** Markdown 全文，可直接写文件 */
  markdown: string;
}

/* ------------------------------------------------------------------ */
/* 注册                                                                */
/* ------------------------------------------------------------------ */

function register(): void {
  registerMenu();
}

function unregister(): void {
  if (menuKey) {
    Zotero.MenuManager.unregisterMenu(menuKey);
    menuKey = false;
  }
}

function registerMenu(): void {
  if (menuKey) {
    return;
  }
  menuKey = Zotero.MenuManager.registerMenu({
    menuID: MENU_ID,
    pluginID: config.addonID,
    // 库级操作放在「工具」菜单里，而不是条目右键菜单
    target: "main/menubar/tools",
    menus: [
      {
        menuType: "menuitem",
        l10nID: getLocaleID("menu-library-audit"),
        onShowing: (event: any) => {
          const element = event?.target as any;
          if (element) {
            element.hidden = !getPref("libraryAudit.enabled");
          }
        },
        onCommand: () => {
          void runAudit();
        },
      },
    ],
  } as any);
  if (!menuKey) {
    Zotero.debug("[MyZoteroTools] 注册库体检菜单失败");
  }
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function runAudit(): Promise<void> {
  notify(getString("audit-running"), "");

  let report: AuditReport;
  try {
    report = await collectFindings();
  } catch (e) {
    Zotero.logError(e as Error);
    notify(getString("audit-failed"), String(e));
    return;
  }

  // 报告写到数据目录旁边，方便直接打开查看
  let reportPath = "";
  try {
    const dir =
      String(getPref("libraryAudit.outputDir") ?? "").trim() ||
      Zotero.DataDirectory.dir;
    await Zotero.File.createDirectoryIfMissingAsync(dir);
    const file = Zotero.File.pathToFile(dir);
    file.append(`MyZoteroTools-audit-${timestamp()}.md`);
    await Zotero.File.putContentsAsync(file.path, report.markdown);
    reportPath = file.path;
  } catch (e) {
    Zotero.debug(`[MyZoteroTools] 写体检报告失败: ${e}`);
  }

  const total = report.findings.length;
  notify(
    getString("audit-done"),
    total === 0
      ? getString("audit-clean")
      : getString("audit-summary", { args: { count: total } }),
  );

  if (reportPath) {
    try {
      // 用系统默认程序打开报告（.md 通常是编辑器）
      const file = Zotero.File.pathToFile(reportPath);
      file.launch();
    } catch (e) {
      Zotero.debug(`[MyZoteroTools] 打开报告失败: ${e}`);
    }
  }

  Zotero.debug(
    `[MyZoteroTools] 库体检完成：${total} 项发现${reportPath ? `，报告: ${reportPath}` : ""}`,
  );
}

/* ------------------------------------------------------------------ */
/* 扫描                                                                */
/* ------------------------------------------------------------------ */

async function collectFindings(): Promise<AuditReport> {
  const libraryID = Zotero.Libraries.userLibraryID;
  const libraryName = Zotero.Libraries.getName(libraryID);

  const allIDs: number[] = await Zotero.Items.getAllIDs(libraryID);
  const items: Zotero.Item[] = [];
  // 批量取条目：Items.get() 对「已知存在但未加载」的 id 会抛
  // UnloadedDataException（dataObjects.js:105-140），所以用 getAsync。
  for (const id of allIDs) {
    try {
      const item = await Zotero.Items.getAsync(id);
      if (item && !item.deleted) {
        items.push(item);
      }
    } catch (e) {
      Zotero.debug(`[MyZoteroTools] 读取条目 ${id} 失败: ${e}`);
    }
  }

  const contentItems = items.filter(
    (item) => !NON_CONTENT_TYPES.has(item.itemType),
  );
  const attachments = items.filter((item) => item.isAttachment?.());
  const notes = items.filter((item) => item.isNote?.());
  const collections = await loadAllCollections(libraryID);

  const findings: AuditFinding[] = [
    ...findDuplicateCollections(collections),
    ...findDuplicateItems(contentItems),
    ...findMetadataPollution(contentItems),
    ...findEmptyCollections(collections),
    ...findOrphanAttachments(attachments),
    ...findItemsWithoutAttachment(contentItems),
    ...(await describeTrash(libraryID)),
  ];

  const report: AuditReport = {
    libraryID,
    libraryName,
    scannedAt: new Date().toISOString(),
    counts: {
      contentItems: contentItems.length,
      attachments: attachments.length,
      notes: notes.length,
      collections: collections.length,
    },
    findings,
    markdown: "",
  };
  report.markdown = renderMarkdown(report);
  return report;
}

/* ---- 0. 取出全部分类 ---- */

/**
 * 取出文库里的**全部存活分类**。
 *
 * ⚠️ 两个坑（都实测踩过）：
 *
 * 1. **不能用 `Zotero.Collections.getByLibrary(libraryID, true)`**：
 *    它遍历的是内存对象缓存 `_objectCache`（data/collections.js:96-103），
 *    只返回**已经加载进内存**的那些分类。实测在测试环境里它只返回 16 个，
 *    而库里实际有 31 个 —— 漏掉的正好是「重复的那一套」。
 *    正确做法是先拿 id 列表，再按 id 加载。
 *
 * 2. **必须排除回收站里的分类**（`collection.deleted`，对应 `deletedCollections` 表）。
 *    否则已经丢进回收站的重复树会被反复报成「待处理问题」——
 *    和条目那边一样，回收站里的东西等于已经处理过了。
 */
async function loadAllCollections(libraryID: number): Promise<any[]> {
  try {
    const ids: number[] = await (Zotero.Collections as any).getAllIDs(
      libraryID,
    );
    if (!ids?.length) {
      return [];
    }
    const collections = await (Zotero.Collections as any).getAsync(ids);
    return (collections ?? []).filter(
      (collection: any) => collection && !collection.deleted,
    );
  } catch (e) {
    Zotero.debug(`[MyZoteroTools] 加载全部分类失败，退回缓存查询: ${e}`);
    return (Zotero.Collections.getByLibrary(libraryID, true) ?? []).filter(
      (collection: any) => collection && !(collection as any).deleted,
    );
  }
}

/** 回收站里的分类（用于单独汇报，不计入问题清单） */
async function loadTrashedCollections(libraryID: number): Promise<any[]> {
  try {
    const ids: number[] = await (Zotero.Collections as any).getAllIDs(
      libraryID,
    );
    const collections = await (Zotero.Collections as any).getAsync(ids);
    return (collections ?? []).filter(
      (collection: any) => collection && collection.deleted,
    );
  } catch {
    return [];
  }
}

/* ---- 1. 重复分类树 ---- */

/**
 * 找出重复的分类。
 *
 * ⚠️ 关键：**必须按名称分组，不能按「父分类 + 名称」分组。**
 * 整棵分类树被复制时，副本里的子分类挂的是**另一份父分类**
 * （例如「国标」原本父分类是 id=3，副本的父分类是 id=20），
 * 所以按 (父分类, 名称) 分组只能查出顶层的那几个 —— 实测 15 组里只查出 8 组。
 *
 * 为了区分「整树重复」和「只是同名」，这里还给每个分类算一个**子树签名**
 * （自身与全部后代的名称集合）。签名相同的两份几乎可以确定是整树复制。
 */
function findDuplicateCollections(collections: any[]): AuditFinding[] {
  const byName = new Map<string, any[]>();
  for (const collection of collections) {
    const name = String(collection.name ?? "").trim();
    if (!name) {
      continue;
    }
    let list = byName.get(name);
    if (!list) {
      byName.set(name, (list = []));
    }
    list.push(collection);
  }

  const duplicates = [...byName.entries()].filter(
    ([, list]) => list.length > 1,
  );
  if (!duplicates.length) {
    return [];
  }

  const details: string[] = [];
  let extraCount = 0;
  let wholeTreeCount = 0;

  for (const [name, list] of duplicates) {
    const signatures = list.map((collection: any) =>
      subtreeSignature(collection, collections),
    );
    const isWholeTree = signatures.length > 1 && new Set(signatures).size === 1;
    if (isWholeTree) {
      wholeTreeCount++;
    }
    extraCount += list.length - 1;

    const parts = list.map((collection: any) => {
      const path = collectionPath(collection, collections);
      return `id=${collection.id}（路径 ${path}，直属 ${countDirectItems(collection.id)} 条）`;
    });
    details.push(
      `- **${name}**：${list.length} 份${isWholeTree ? "，**子树完全相同（整树复制）**" : ""}\n` +
        parts.map((part) => `  - ${part}`).join("\n"),
    );
  }

  return [
    {
      group: "重复分类树",
      summary:
        `发现 ${duplicates.length} 组同名分类（其中 ${wholeTreeCount} 组子树完全相同），` +
        `共多出 ${extraCount} 个分类。Zotero 和任何插件都不会检测这个。`,
      details,
      severity: "high",
    },
  ];
}

/** 分类的完整路径，例如「农药 / 国标」 */
function collectionPath(collection: any, all: any[]): string {
  const parts: string[] = [String(collection.name ?? "?")];
  let current = collection;
  let guard = 0;
  while (current?.parentID && guard++ < 20) {
    const parent = all.find((entry: any) => entry.id === current.parentID);
    if (!parent) {
      break;
    }
    parts.unshift(String(parent.name ?? "?"));
    current = parent;
  }
  return parts.join(" / ");
}

/** 子树签名：自身与全部后代的名称（排序后拼接），用于判断是否整树复制 */
function subtreeSignature(collection: any, all: any[]): string {
  const names: string[] = [];
  const walk = (node: any, depth: number) => {
    if (depth > 20) {
      return;
    }
    names.push(String(node.name ?? ""));
    for (const child of all) {
      if (child.parentID === node.id) {
        walk(child, depth + 1);
      }
    }
  };
  walk(collection, 0);
  return names.sort().join("\u0001");
}

function countDirectItems(collectionID: number): number {
  try {
    const collection = Zotero.Collections.get(collectionID) as any;
    return (collection?.getChildItems?.(false) ?? []).length;
  } catch {
    return 0;
  }
}

/* ---- 2. 重复条目 ---- */

interface DupePair {
  a: Zotero.Item;
  b: Zotero.Item;
  zoteroFinds: boolean;
  reason: string;
}

function findDuplicateItems(contentItems: Zotero.Item[]): AuditFinding[] {
  const norm = normalizeForDuplicates;
  const byKey = new Map<string, Zotero.Item[]>();

  for (const item of contentItems) {
    const doi = norm(safeField(item, "DOI")).replace(
      /^https?:\/\/(dx\.)?doi\.org\//,
      "",
    );
    const title = norm(safeField(item, "title"));
    const keys = [doi && `doi:${doi}`, title.length > 10 && `title:${title}`];
    for (const key of keys) {
      if (!key) {
        continue;
      }
      let list = byKey.get(key);
      if (!list) {
        byKey.set(key, (list = []));
      }
      list.push(item);
    }
  }

  const pairs: DupePair[] = [];
  const seen = new Set<string>();
  for (const list of byKey.values()) {
    if (list.length < 2) {
      continue;
    }
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        const pairKey = [a.id, b.id].sort().join("-");
        if (seen.has(pairKey)) {
          continue;
        }
        seen.add(pairKey);
        const verdict = zoteroWouldFindDuplicate(a, b);
        pairs.push({
          a,
          b,
          zoteroFinds: verdict.found,
          reason: verdict.reason,
        });
      }
    }
  }

  if (!pairs.length) {
    return [];
  }

  const missed = pairs.filter((pair) => !pair.zoteroFinds);
  const details = pairs.map((pair) => {
    const mark = pair.zoteroFinds ? "Zotero 可发现" : "⚠️ Zotero 会漏检";
    const attA = countAttachments(pair.a);
    const attB = countAttachments(pair.b);
    return (
      `- [${pair.a.key}] vs [${pair.b.key}] · 附件 ${attA} / ${attB} · **${mark}**` +
      `\n  - ${safeField(pair.a, "title").slice(0, 70) || "(无标题)"}` +
      (pair.zoteroFinds ? "" : `\n  - 漏检原因：${pair.reason}`)
    );
  });

  return [
    {
      group: "重复条目",
      summary:
        `发现 ${pairs.length} 对疑似重复，其中 **${missed.length} 对 Zotero 自带检测发现不了**。` +
        `两份副本的附件数常常不同，合并前请确认。` +
        `（已排除回收站里的条目 —— 那些副本等于已经处理过了。）`,
      details,
      severity: "high",
    },
  ];
}

/**
 * 复刻 `xpcom/duplicates.js` 的判定规则，用来区分
 * 「Zotero 自带面板能发现」和「只有我们能发现」。
 */
function zoteroWouldFindDuplicate(
  a: Zotero.Item,
  b: Zotero.Item,
): { found: boolean; reason: string } {
  // Zotero 明确排除附件与笔记（duplicates.js:283、:305）
  if (
    a.isAttachment?.() ||
    b.isAttachment?.() ||
    a.isNote?.() ||
    b.isNote?.()
  ) {
    return { found: false, reason: "Zotero 的重复检测明确排除附件和笔记" };
  }

  const titleA = normalizeForDuplicates(safeField(a, "title"));
  const titleB = normalizeForDuplicates(safeField(b, "title"));
  if (!titleA || !titleB || titleA !== titleB) {
    return {
      found: false,
      reason: "归一化标题不相等（标题里可能混入了 HTML 标签或标点差异）",
    };
  }

  const doiA = normalizeForDuplicates(safeField(a, "DOI"));
  const doiB = normalizeForDuplicates(safeField(b, "DOI"));
  if (doiA && doiB && doiA !== doiB) {
    return { found: false, reason: "两边都有 DOI 但不相同" };
  }

  const yearA = yearOf(a);
  const yearB = yearOf(b);
  if (yearA && yearB && Math.abs(yearA - yearB) > 1) {
    return { found: false, reason: "年份相差超过 1 年" };
  }

  const creatorsA = creatorsOf(a);
  const creatorsB = creatorsOf(b);
  if (!creatorsA.length && !creatorsB.length) {
    return { found: true, reason: "" };
  }
  if (!creatorsA.length || !creatorsB.length) {
    return { found: false, reason: "只有一边有作者" };
  }
  for (const x of creatorsA) {
    for (const y of creatorsB) {
      if (x.last === y.last && x.initial === y.initial) {
        return { found: true, reason: "" };
      }
    }
  }
  return { found: false, reason: "没有任何作者的「姓 + 名首字母」匹配" };
}

/** 复刻 duplicates.js:111-125 的 normalizeString */
function normalizeForDuplicates(value: unknown): string {
  const text = String(value ?? "");
  if (!text) {
    return "";
  }
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[ !-/:-@[-`{-~]+/g, " ")
    .trim()
    .toLowerCase();
}

function creatorsOf(
  item: Zotero.Item,
): Array<{ last: string; initial: string }> {
  try {
    return (item.getCreators() ?? []).map((creator: any) => ({
      last: normalizeForDuplicates(creator.lastName),
      initial:
        creator.fieldMode === 0
          ? normalizeForDuplicates(creator.firstName).charAt(0)
          : "",
    }));
  } catch {
    return [];
  }
}

/* ---- 3. 元数据污染 ---- */

function findMetadataPollution(contentItems: Zotero.Item[]): AuditFinding[] {
  const details: string[] = [];
  for (const item of contentItems) {
    for (const fieldName of ["title", "publicationTitle", "proceedingsTitle"]) {
      const value = safeField(item, fieldName);
      if (/<[a-z][^>]*>/i.test(value) || /&[a-z]+;/i.test(value)) {
        details.push(`- [${item.key}] ${fieldName}：\`${value.slice(0, 80)}\``);
      }
    }
  }
  if (!details.length) {
    return [];
  }
  return [
    {
      group: "元数据污染",
      summary:
        `发现 ${details.length} 处字段里混入了 HTML 标签或实体。` +
        `这还会**连带让 Zotero 的重复检测失效**（标题归一化后不相等）。`,
      details,
      severity: "medium",
    },
  ];
}

/* ---- 4. 空分类 ---- */

function findEmptyCollections(collections: any[]): AuditFinding[] {
  const details: string[] = [];
  for (const collection of collections) {
    const children = Zotero.Collections.getByParent(collection.id) ?? [];
    if (children.length) {
      continue;
    }
    const direct = countDirectItems(collection.id);
    if (direct === 0) {
      details.push(
        `- **${collection.name}**（id=${collection.id}）无条目、无子分类`,
      );
    }
  }
  if (!details.length) {
    return [];
  }
  return [
    {
      group: "空分类",
      summary: `发现 ${details.length} 个完全空的分类。`,
      details,
      severity: "low",
    },
  ];
}

/* ---- 5. 孤立附件 ---- */

function findOrphanAttachments(attachments: Zotero.Item[]): AuditFinding[] {
  const details: string[] = [];
  for (const attachment of attachments) {
    const parentID = (attachment as any).parentItemID;
    if (!parentID) {
      const title =
        safeField(attachment, "title") ||
        attachment.attachmentFilename ||
        "(无标题)";
      details.push(`- [${attachment.key}] ${String(title).slice(0, 70)}`);
    }
  }
  if (!details.length) {
    return [];
  }
  return [
    {
      group: "孤立附件",
      summary: `发现 ${details.length} 个没有父条目的附件。`,
      details,
      severity: "low",
    },
  ];
}

/* ---- 6. 缺附件的条目 ---- */

function findItemsWithoutAttachment(
  contentItems: Zotero.Item[],
): AuditFinding[] {
  const details: string[] = [];
  for (const item of contentItems) {
    const ids: number[] = item.getAttachments?.() ?? [];
    if (!ids.length) {
      details.push(
        `- [${item.key}] ${safeField(item, "title").slice(0, 70) || "(无标题)"}`,
      );
    }
  }
  if (!details.length) {
    return [];
  }
  return [
    {
      group: "缺附件的条目",
      summary: `发现 ${details.length} 条没有任何附件的条目。`,
      details,
      severity: "low",
    },
  ];
}

/* ---- 7. 回收站（单独汇报，不算问题） ---- */

/**
 * 汇报回收站里有什么。
 *
 * 这不是「问题」，而是**决策依据**：清空回收站会**永久删除**里面的附件文件，
 * 所以要先知道里面有没有「某个条目唯一的一份 PDF」。
 *
 * 顺带解决一个误导：重复的分类树/条目如果已经在回收站里，说明**已经处理过了**，
 * 不该再报成待办事项 —— 这里把它们单独列出来，并明确指出这一点。
 */
async function describeTrash(libraryID: number): Promise<AuditFinding[]> {
  const trashedItems: Zotero.Item[] = [];
  try {
    const ids: number[] = await Zotero.Items.getAllIDs(libraryID);
    for (const id of ids) {
      const item = (await Zotero.Items.getAsync(id)) as Zotero.Item | false;
      if (item && item.deleted) {
        trashedItems.push(item);
      }
    }
  } catch (e) {
    Zotero.debug(`[MyZoteroTools] 读取回收站失败: ${e}`);
  }
  const trashedCollections = await loadTrashedCollections(libraryID);

  if (!trashedItems.length && !trashedCollections.length) {
    return [];
  }

  const details: string[] = [];
  if (trashedCollections.length) {
    details.push(
      `- 回收站里有 **${trashedCollections.length} 个分类**：` +
        trashedCollections
          .slice(0, 20)
          .map((collection: any) => collection.name)
          .join("、") +
        (trashedCollections.length > 20 ? " …" : ""),
    );
    details.push(
      "  - 这些分类**不计入上面的问题清单** —— 它们已经在回收站里，等于已经处理过了。",
    );
  }

  const trashedContent = trashedItems.filter(
    (item) => !NON_CONTENT_TYPES.has(item.itemType),
  );
  const trashedAttachments = trashedItems.filter((item) =>
    item.isAttachment?.(),
  );
  if (trashedContent.length) {
    details.push(
      `- 回收站里有 **${trashedContent.length} 条内容条目**、${trashedAttachments.length} 个附件。`,
    );
  }

  // 关键风险：回收站里的附件，是不是某条存活条目「唯一的一份」
  const lastFile: string[] = [];
  for (const attachment of trashedAttachments) {
    const parentID = (attachment as any).parentItemID;
    if (!parentID) {
      continue;
    }
    const parent = await Zotero.Items.getAsync(parentID);
    if (!parent || parent.deleted) {
      continue; // 父条目也在回收站，那就是整条一起丢，不算「最后一份」
    }
    const liveSiblings = (parent.getAttachments?.() ?? []).filter((id) => {
      const sibling = Zotero.Items.get(id);
      return sibling && !sibling.deleted;
    });
    if (!liveSiblings.length) {
      lastFile.push(
        `[${parent.key}] ${safeField(parent, "title").slice(0, 50)} ← 它的唯一附件在回收站里`,
      );
    }
  }

  if (lastFile.length) {
    details.push(
      `- 🔴 **清空回收站前请注意**：有 ${lastFile.length} 条存活条目的唯一附件正在回收站里，` +
        `清空后这些条目就没有附件了：`,
    );
    details.push(...lastFile.map((line) => `  - ${line}`));
  } else {
    details.push(
      "- 没有「存活条目的唯一附件」落在回收站里，清空回收站不会让条目失去附件。",
    );
  }

  return [
    {
      group: "回收站（供决策，非问题）",
      summary:
        `回收站里有 ${trashedCollections.length} 个分类、${trashedItems.length} 个条目。` +
        `清空回收站会**永久删除**这些附件的文件，所以列出来供你判断。`,
      details,
      severity: "low",
    },
  ];
}

/* ------------------------------------------------------------------ */
/* 报告渲染                                                            */
/* ------------------------------------------------------------------ */

function renderMarkdown(report: AuditReport): string {
  const lines: string[] = [];
  lines.push("# MyZoteroTools 库体检报告", "");
  lines.push(`- 文库：${report.libraryName}`);
  lines.push(`- 扫描时间：${report.scannedAt}`);
  lines.push(
    `- 规模：内容条目 ${report.counts.contentItems}，附件 ${report.counts.attachments}，` +
      `笔记 ${report.counts.notes}，分类 ${report.counts.collections}`,
  );
  lines.push("");
  lines.push(
    `> 本报告**只读**生成，没有修改任何数据。修复动作请自行决定。`,
    "",
  );

  if (!report.findings.length) {
    lines.push("## 结果：未发现问题 ✅", "");
    return `${lines.join("\n")}\n`;
  }

  lines.push("## 发现汇总", "");
  lines.push("| 检查项 | 严重度 | 说明 |");
  lines.push("|---|---|---|");
  const severityLabel: Record<string, string> = {
    high: "🔴 高",
    medium: "🟡 中",
    low: "⚪ 低",
  };
  for (const finding of report.findings) {
    lines.push(
      `| ${finding.group} | ${severityLabel[finding.severity]} | ${finding.summary} |`,
    );
  }
  lines.push("");

  for (const finding of report.findings) {
    lines.push(`## ${finding.group}`, "");
    lines.push(finding.summary, "");
    lines.push(...finding.details, "");
  }

  lines.push("---", "");
  lines.push("## 修复建议", "");
  lines.push(
    "- **重复条目**：Zotero 能发现的那部分，用「重复条目」面板合并即可（合并会自动并集附件）。",
  );
  lines.push(
    "- **重复分类树**：Zotero 没有任何检测机制，需要人工合并或使用后续版本提供的合并功能。",
  );
  lines.push(
    "- **元数据污染**：清理标题里的 HTML 标签；顺带能让 Zotero 的重复检测恢复工作。",
  );
  return `${lines.join("\n")}\n`;
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function safeField(item: Zotero.Item, name: string): string {
  try {
    return String(item.getField(name as any) ?? "").trim();
  } catch {
    return "";
  }
}

function yearOf(item: Zotero.Item): number | null {
  const match = safeField(item, "date").match(/\b(1[6-9]\d{2}|20\d{2})\b/);
  return match ? Number(match[1]) : null;
}

function countAttachments(item: Zotero.Item): number {
  try {
    return (item.getAttachments?.() ?? []).length;
  } catch {
    return 0;
  }
}

function timestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

function notify(headline: string, text = ""): void {
  try {
    const pw = new (Zotero as any).ProgressWindow({ closeOnClick: true });
    pw.changeHeadline(headline);
    if (text) {
      pw.addDescription(text);
    }
    pw.show();
    pw.startCloseTimer(6000);
  } catch (e) {
    Zotero.debug(`[MyZoteroTools] 提示失败: ${e}`);
  }
}
