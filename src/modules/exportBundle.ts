/**
 * 功能⑤：导出文献数据包
 *
 * 解决的问题：把 Zotero 里的文献交给大模型做结构化抽取时，一篇篇复制标题、
 * 摘要、正文非常费事。这个功能把选中的文献一次性导成一个「数据包」：
 *
 *   输出目录/
 *     index.csv              全部文献的元数据总表（Excel 可直接打开）
 *     papers/0001-<key>.md   每篇一个文件：元数据 + 摘要 + 全文
 *
 * 每篇一个文件是刻意的：这样可以直接把不同文件分给不同的 agent 并行处理。
 *
 * 全文取自 Zotero 自己的全文索引缓存（`.zotero-ft-cache`），
 * 所以不需要重新解析 PDF，也不会因为 PDF 是扫描件而卡住（那种情况会记为无全文）。
 *
 * 导出格式里的字段名固定用英文（Title / Creators / DOI …）：
 * 数据包是要被程序和大模型读的，字段名跟着界面语言变会破坏下游流程。
 */

import { config } from "../../package.json";
import { getPref } from "../utils/prefs";
import { getLocaleID, getString } from "../utils/locale";

const MENU_ID = `${config.addonRef}-export-bundle-menu`;

let menuKey: string | false = false;

export { register, unregister, exportSelectedItems, buildBundle };

/* ------------------------------------------------------------------ */
/* 注册 / 注销                                                         */
/* ------------------------------------------------------------------ */

function register(): void {
  registerMenu();
}

function unregister(): void {
  if (menuKey) {
    // 必须传注册时返回的 key：MenuManager 内部存的是
    // CSS.escape(pluginID + "-" + menuID)，传原始 id 会注销失败。
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
    target: "main/library/item",
    menus: [
      {
        menuType: "menuitem",
        l10nID: getLocaleID("menu-export-bundle"),
        onShowing: (event: any) => {
          const element = event?.target as any;
          if (element) {
            element.hidden =
              !getPref("exportBundle.enabled") ||
              selectedRegularItems().length === 0;
          }
        },
        onCommand: () => {
          void exportSelectedItems();
        },
      },
    ],
  } as any);
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function exportSelectedItems(): Promise<void> {
  const items = selectedRegularItems();
  if (!items.length) {
    return;
  }

  const parentDir = await resolveOutputDir();
  if (!parentDir) {
    return; // 用户取消
  }

  notify(
    getString("export-bundle-start"),
    getString("export-bundle-count", {
      args: { count: items.length },
    }),
  );

  try {
    const result = await buildBundle(items, parentDir);
    notify(
      getString("export-bundle-done"),
      getString("export-bundle-result", {
        args: { count: result.count, dir: result.dir },
      }),
    );
    Zotero.debug(`[MyZoteroTools] 数据包已导出到 ${result.dir}`);
  } catch (e) {
    Zotero.logError(e as Error);
    notify(getString("export-bundle-failed"), String(e));
  }
}

/** 决定输出到哪个目录：设置里指定了就直接用，否则弹目录选择框 */
async function resolveOutputDir(): Promise<string | null> {
  const configured = String(getPref("exportBundle.outputDir") ?? "").trim();
  if (configured) {
    try {
      await Zotero.File.createDirectoryIfMissingAsync(configured);
      return configured;
    } catch (e) {
      Zotero.debug(`[MyZoteroTools] 导出目录不可用，改为手动选择: ${e}`);
    }
  }
  return chooseFolder();
}

async function chooseFolder(): Promise<string | null> {
  try {
    const { FilePicker } = ChromeUtils.importESModule(
      "chrome://zotero/content/modules/filePicker.mjs",
    );
    const fp = new FilePicker();
    const win = Zotero.getMainWindow() as any;
    fp.init(win, getString("export-bundle-choose-folder"), fp.modeGetFolder);
    const rv = await fp.show();
    if (rv !== fp.returnOK || !fp.file) {
      return null;
    }
    return String(fp.file);
  } catch (e) {
    Zotero.debug(`[MyZoteroTools] 打开目录选择框失败: ${e}`);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 生成数据包                                                          */
/* ------------------------------------------------------------------ */

interface BundleResult {
  dir: string;
  count: number;
}

async function buildBundle(
  items: Zotero.Item[],
  parentDir: string,
): Promise<BundleResult> {
  const dir = childPath(parentDir, `DaxiangZoteroTools-export-${timestamp()}`);
  await Zotero.File.createDirectoryIfMissingAsync(dir);
  await Zotero.File.createDirectoryIfMissingAsync(childPath(dir, "papers"));

  const includeFulltext = !!getPref("exportBundle.includeFulltext");
  const rows: string[][] = [CSV_HEADER];

  for (const [index, item] of items.entries()) {
    const fulltext = includeFulltext ? await getFulltext(item) : "";
    const fileName = `${String(index + 1).padStart(4, "0")}-${item.key}.md`;

    await Zotero.File.putContentsAsync(
      childPath(dir, "papers", fileName),
      itemToMarkdown(item, fulltext),
    );

    rows.push([
      item.key,
      field(item, "title"),
      creatorsText(item),
      yearOf(item),
      field(item, "publicationTitle") || field(item, "proceedingsTitle"),
      field(item, "DOI"),
      itemTypeName(item),
      collectionsText(item),
      tagsText(item),
      fulltext ? "yes" : "no",
      `papers/${fileName}`,
    ]);
  }

  // 带 BOM，Excel 打开中文才不会乱码
  await Zotero.File.putContentsAsync(
    childPath(dir, "index.csv"),
    `\ufeff${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`,
  );

  return { dir, count: items.length };
}

const CSV_HEADER = [
  "key",
  "title",
  "creators",
  "year",
  "publication",
  "doi",
  "itemType",
  "collections",
  "tags",
  "hasFulltext",
  "file",
];

function itemToMarkdown(item: Zotero.Item, fulltext: string): string {
  const lines: string[] = [];
  lines.push(`# ${field(item, "title") || "(untitled)"}`, "");

  const meta: Array<[string, string]> = [
    ["Creators", creatorsText(item)],
    ["Year", yearOf(item)],
    [
      "Publication",
      field(item, "publicationTitle") || field(item, "proceedingsTitle"),
    ],
    ["DOI", field(item, "DOI")],
    ["URL", field(item, "url")],
    ["ItemType", itemTypeName(item)],
    ["Collections", collectionsText(item)],
    ["Tags", tagsText(item)],
    ["ZoteroKey", item.key],
  ];
  for (const [name, value] of meta) {
    if (value) {
      lines.push(`- **${name}**: ${value}`);
    }
  }

  const abstract = field(item, "abstractNote");
  if (abstract) {
    lines.push("", "## Abstract", "", abstract);
  }

  lines.push("", "## Fulltext", "");
  lines.push(
    fulltext ||
      "(No indexed fulltext available. Either the attachment is missing or it has not been indexed yet.)",
  );

  return `${lines.join("\n")}\n`;
}

/* ------------------------------------------------------------------ */
/* 条目信息读取                                                        */
/* ------------------------------------------------------------------ */

function field(item: Zotero.Item, name: string): string {
  try {
    return String(item.getField(name as any) ?? "").trim();
  } catch {
    return "";
  }
}

function yearOf(item: Zotero.Item): string {
  const date = field(item, "date");
  const match = date.match(/\b(1[6-9]\d{2}|20\d{2})\b/);
  return match ? match[1] : "";
}

function itemTypeName(item: Zotero.Item): string {
  try {
    return Zotero.ItemTypes.getName(item.itemTypeID);
  } catch {
    return "";
  }
}

function creatorsText(item: Zotero.Item): string {
  try {
    return (item.getCreators() ?? [])
      .map((creator: any) => {
        // fieldMode = 1 表示「单字段」模式（机构作者等），整名都在 lastName 里
        if (creator.fieldMode === 1) {
          return creator.lastName ?? "";
        }
        const first = creator.firstName ?? "";
        const last = creator.lastName ?? "";
        return first ? `${last}, ${first}` : last;
      })
      .filter(Boolean)
      .join("; ");
  } catch {
    return "";
  }
}

function collectionsText(item: Zotero.Item): string {
  try {
    return (item.getCollections() ?? [])
      .map((id: number) => collectionPath(id))
      .filter(Boolean)
      .join(" | ");
  } catch {
    return "";
  }
}

function collectionPath(collectionID: number): string {
  const parts: string[] = [];
  let current: any = Zotero.Collections.get(collectionID);
  let guard = 0;
  while (current && guard++ < 20) {
    parts.unshift(current.name);
    current = current.parentID
      ? Zotero.Collections.get(current.parentID)
      : null;
  }
  return parts.join(" / ");
}

function tagsText(item: Zotero.Item): string {
  try {
    return (item.getTags() ?? [])
      .map((entry: any) => entry.tag)
      .filter(Boolean)
      .join("; ");
  } catch {
    return "";
  }
}

/** 取 Zotero 全文索引里缓存的正文（不需要重新解析 PDF） */
async function getFulltext(item: Zotero.Item): Promise<string> {
  try {
    const attachmentIDs: number[] = item.getAttachments?.() ?? [];
    for (const id of attachmentIDs) {
      const attachment = (await Zotero.Items.getAsync(id)) as any;
      if (!attachment) {
        continue;
      }
      if (!attachment.isPDF?.() && !attachment.isSnapshot?.()) {
        continue;
      }
      const cacheFile = Zotero.Fulltext.getItemCacheFile(attachment);
      if (!cacheFile?.exists?.()) {
        continue;
      }
      const text = await Zotero.File.getContentsAsync(cacheFile.path);
      if (text) {
        return String(text);
      }
    }
  } catch (e) {
    Zotero.debug(`[MyZoteroTools] 读取全文失败 (${item.key}): ${e}`);
  }
  return "";
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function selectedRegularItems(): Zotero.Item[] {
  try {
    const pane = Zotero.getActiveZoteroPane() as any;
    const items: Zotero.Item[] = pane?.getSelectedItems?.() ?? [];
    return items.filter((item) => item && item.isRegularItem?.());
  } catch (e) {
    Zotero.debug(`[MyZoteroTools] 读取选中条目失败: ${e}`);
    return [];
  }
}

/** 用 nsIFile.append 拼路径，交给平台处理分隔符，避免手写分隔符出错 */
function childPath(dir: string, ...parts: string[]): string {
  const file = Zotero.File.pathToFile(dir);
  for (const part of parts) {
    file.append(part);
  }
  return file.path;
}

function timestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

function csvCell(value: string): string {
  const text = String(value ?? "");
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function notify(headline: string, text = ""): void {
  try {
    const pw = new (Zotero as any).ProgressWindow({ closeOnClick: true });
    pw.changeHeadline(headline);
    if (text) {
      pw.addDescription(text);
    }
    pw.show();
    pw.startCloseTimer(5000);
  } catch (e) {
    Zotero.debug(`[MyZoteroTools] 提示失败: ${e}`);
  }
}
