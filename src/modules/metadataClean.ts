/**
 * 功能⑧：元数据清洗
 *
 * 补的是「没装 Linter」留下的缺口。只做两件**纯文本**的事，不碰任何结构：
 *
 * 1. **去掉标题/期刊名里的 HTML 标签与实体**
 *    从网页抓取（尤其知网、出版商页面）时经常把 `<span style="…">` 带进标题。
 *    危害不只是难看 —— **它会让 Zotero 自带的重复条目检测失效**：
 *    Zotero 的标题归一化只处理 ASCII 标点、不剥离标签，于是两份「看起来一样」
 *    的标题归一化后不相等，重复条目就检不出来。
 *
 * 2. **规范化 `language` 字段**
 *    同一个语言常有多种写法（`zh` / `zh-CN` / `chi` / `中文` / `en` / `eng` / `English`）。
 *    这个字段会影响 CSL 的引用格式（例如中文文献用「等」还是「et al.」），
 *    所以统一成 BCP-47 形式（`zh-CN` / `en`）。
 *
 * ⚠️ 设计上刻意保守：
 *   - 只改这三个字段（title / publicationTitle / proceedingsTitle）+ language
 *   - **先扫描再确认**，确认框里列出会改什么、改多少
 *   - 只处理「确实需要改」的条目，不会整库重写
 */

import { config } from "../../package.json";
import { getPref } from "../utils/prefs";
import { getLocaleID, getString } from "../utils/locale";

const MENU_ID = `${config.addonRef}-metadata-clean-menu`;

/** 会被清理 HTML 的字段 */
const HTML_FIELDS = ["title", "publicationTitle", "proceedingsTitle"];

/**
 * language 字段的规范化映射。
 * 只做「同一语言的常见写法 → BCP-47」的收敛，不做语言识别（那是 Linter 的活）。
 */
const LANGUAGE_MAP: Record<string, string> = {
  zh: "zh-CN",
  "zh-cn": "zh-CN",
  "zh-hans": "zh-CN",
  "zh-hant": "zh-TW",
  chi: "zh-CN",
  chinese: "zh-CN",
  中文: "zh-CN",
  汉语: "zh-CN",
  简体中文: "zh-CN",
  en: "en",
  eng: "en",
  english: "en",
  英文: "en",
  英语: "en",
  jp: "ja",
  jpn: "ja",
  japanese: "ja",
  日文: "ja",
  日语: "ja",
};

let menuKey: string | false = false;

export {
  register,
  unregister,
  planCleanup,
  applyCleanup,
  cleanHtml,
  normalizeLanguage,
};
export type { CleanupPlan };

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

interface FieldChange {
  item: Zotero.Item;
  field: string;
  before: string;
  after: string;
}

interface CleanupPlan {
  htmlChanges: FieldChange[];
  languageChanges: FieldChange[];
  /** 受影响的条目数（去重） */
  affectedItems: number;
}

/* ------------------------------------------------------------------ */
/* 注册 / 注销                                                         */
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
    target: "main/menubar/tools",
    menus: [
      {
        menuType: "menuitem",
        l10nID: getLocaleID("menu-metadata-clean"),
        onShowing: (event: any) => {
          const element = event?.target as any;
          if (element) {
            element.hidden = !getPref("metadataClean.enabled");
          }
        },
        onCommand: () => {
          void runCleanup();
        },
      },
    ],
  } as any);
  if (!menuKey) {
    Zotero.debug("[MyZoteroTools] 注册元数据清洗菜单失败");
  }
}

/* ------------------------------------------------------------------ */
/* 主流程：先扫描 → 确认 → 再改                                         */
/* ------------------------------------------------------------------ */

async function runCleanup(): Promise<void> {
  const plan = await planCleanup();
  const total = plan.htmlChanges.length + plan.languageChanges.length;

  if (!total) {
    notify(getString("clean-nothing"), "");
    return;
  }

  // 确认框：把要改的东西列清楚再动手
  const preview = [...plan.htmlChanges, ...plan.languageChanges]
    .slice(0, 6)
    .map(
      (change) =>
        `${change.item.key} ${change.field}\n  ${truncate(change.before)}\n→ ${truncate(change.after)}`,
    )
    .join("\n\n");

  const confirmed = confirmDialog(
    getString("clean-confirm-title"),
    getString("clean-confirm-body", {
      args: {
        items: plan.affectedItems,
        html: plan.htmlChanges.length,
        language: plan.languageChanges.length,
      },
    }) +
      (total > 6 ? `\n\n${getString("clean-confirm-more")}` : "") +
      `\n\n${preview}`,
  );
  if (!confirmed) {
    return;
  }

  const changed = await applyCleanup(plan);
  notify(
    getString("clean-done"),
    getString("clean-done-detail", { args: { count: changed } }),
  );
}

/* ------------------------------------------------------------------ */
/* 扫描                                                                */
/* ------------------------------------------------------------------ */

async function planCleanup(): Promise<CleanupPlan> {
  const libraryID = Zotero.Libraries.userLibraryID;
  const ids: number[] = await Zotero.Items.getAllIDs(libraryID);

  const htmlChanges: FieldChange[] = [];
  const languageChanges: FieldChange[] = [];
  const affected = new Set<number>();

  const fixHtml = !!getPref("metadataClean.fixHtml");
  const fixLanguage = !!getPref("metadataClean.normalizeLanguage");

  for (const id of ids) {
    let item: Zotero.Item | false;
    try {
      item = (await Zotero.Items.getAsync(id)) as Zotero.Item | false;
    } catch {
      continue;
    }
    // 只处理存活的内容条目（回收站里的不动）
    if (!item || item.deleted || NON_CONTENT_TYPES.has(item.itemType)) {
      continue;
    }

    if (fixHtml) {
      for (const fieldName of HTML_FIELDS) {
        const before = safeField(item, fieldName);
        if (!before) {
          continue;
        }
        const after = cleanHtml(before);
        if (after !== before) {
          htmlChanges.push({ item, field: fieldName, before, after });
          affected.add(item.id);
        }
      }
    }

    if (fixLanguage) {
      const before = safeField(item, "language");
      if (before) {
        const after = normalizeLanguage(before);
        if (after && after !== before) {
          languageChanges.push({ item, field: "language", before, after });
          affected.add(item.id);
        }
      }
    }
  }

  return {
    htmlChanges,
    languageChanges,
    affectedItems: affected.size,
  };
}

/* ------------------------------------------------------------------ */
/* 应用                                                                */
/* ------------------------------------------------------------------ */

async function applyCleanup(plan: CleanupPlan): Promise<number> {
  const byItem = new Map<number, FieldChange[]>();
  for (const change of [...plan.htmlChanges, ...plan.languageChanges]) {
    let list = byItem.get(change.item.id);
    if (!list) {
      byItem.set(change.item.id, (list = []));
    }
    list.push(change);
  }

  let changed = 0;
  for (const [, changes] of byItem) {
    const item = changes[0].item;
    try {
      for (const change of changes) {
        item.setField(change.field as any, change.after);
      }
      await item.saveTx();
      changed++;
    } catch (e) {
      Zotero.debug(`[MyZoteroTools] 清洗 ${item.key} 失败: ${e}`);
    }
  }
  return changed;
}

/* ------------------------------------------------------------------ */
/* 纯函数（可单测）                                                     */
/* ------------------------------------------------------------------ */

/** 去掉字段里的 HTML 标签与常见实体，并收拾多余空白 */
function cleanHtml(value: string): string {
  let text = String(value ?? "");
  if (!text) {
    return text;
  }

  // 1. 标签：<span style="…">…</span>、<br>、<i> 等一律去掉（保留标签内的文字）
  text = text.replace(/<\/?[a-z][^>]*>/gi, "");
  // 2. 注释
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  // 3. 常见实体
  text = text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)));
  // 4. 标签被删掉后可能留下多余空格
  text = text.replace(/[ \t]{2,}/g, " ").trim();

  return text;
}

/** 把 language 收敛成 BCP-47；认不出来就原样返回（不猜） */
function normalizeLanguage(value: string): string {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return raw;
  }
  const key = raw.toLowerCase();
  return LANGUAGE_MAP[key] ?? raw;
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

const NON_CONTENT_TYPES = new Set(["attachment", "note", "annotation"]);

function safeField(item: Zotero.Item, name: string): string {
  try {
    return String(item.getField(name as any) ?? "").trim();
  } catch {
    return "";
  }
}

function truncate(value: string): string {
  return value.length > 70 ? `${value.slice(0, 70)}…` : value;
}

function confirmDialog(title: string, body: string): boolean {
  try {
    const win = Zotero.getMainWindow() as any;
    const ps = (win as any).Services.prompt;
    // 0 = OK, 1 = Cancel
    return (
      ps.confirmEx(
        win,
        title,
        body,
        ps.BUTTON_POS_0 * ps.BUTTON_TITLE_IS_STRING +
          ps.BUTTON_POS_1 * ps.BUTTON_TITLE_CANCEL,
        getString("clean-confirm-ok"),
        null,
        null,
        null,
        {},
      ) === 0
    );
  } catch (e) {
    Zotero.debug(`[MyZoteroTools] 确认框失败: ${e}`);
    return false;
  }
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
