/**
 * 功能⑦：结构化字段（抽取结果落库 + 编辑 + 跨论文对比表）
 *
 * ## 为什么做这个
 *
 * 生态调研结论：**跨论文结构化变量抽取至今没有成熟方案**。最接近的
 * Zotero-Exitem 仅 3★、单次上限 5 篇、抽取列固定不可自定义。
 * 根因是 **Zotero 十年未实现自定义字段**（论坛从 2016 问到 2026-04），
 * 插件也无法向字段注册表添加字段。
 *
 * 于是链路上出现了断层：
 *
 *     论文 → [抽取] → [落库] → [审核] → [增量] → [跨论文对比表]
 *             ↑ 上游已解决          ↑↑↑↑ 这一段没人做 ↑↑↑↑
 *
 * 本模块补的就是下游这一段。落库位置用 Zotero 生态的通行做法 ——
 * **Extra 字段里的 `key: value` 行**（自建字段的唯一可行位置），
 * 呈现与编辑用官方 API `Zotero.ItemPaneManager.registerSection`。
 *
 * ## 数据格式
 *
 * 在条目的 Extra 里写入形如下面的一行（前缀可配置）：
 *
 *     mzt.载体类型: 聚脲微囊
 *     mzt.粒径: 200 nm
 *
 * 用 Zotero 自己的 `key: value` 约定而不是自定义分隔符，是为了让别的工具
 * （以及 Zotero 的 Extra 面板）也能读懂这些行。
 */

import { config } from "../../package.json";
import { getPref } from "../utils/prefs";
import { getLocaleID, getString } from "../utils/locale";

const MENU_ID = `${config.addonRef}-structured-fields-menu`;
const SECTION_ID = `${config.addonRef}-structured-fields-section`;

let menuKey: string | false = false;
let sectionKey: string | false = false;

export {
  register,
  unregister,
  readFields,
  writeFields,
  collectTable,
  exportTable,
  importFromCsv,
};
// 纯函数单独导出，便于测试
export { toCsv, toMarkdown, parseCsv };
export type { FieldTable };

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

interface FieldTable {
  /** 列名（字段名），按首次出现顺序 */
  columns: string[];
  /** 行：每条文献一行 */
  rows: Array<{
    key: string;
    title: string;
    year: string;
    values: Record<string, string>;
  }>;
}

/* ------------------------------------------------------------------ */
/* 注册 / 注销                                                         */
/* ------------------------------------------------------------------ */

function register(): void {
  registerMenu();
  registerSection();
}

function unregister(): void {
  if (menuKey) {
    Zotero.MenuManager.unregisterMenu(menuKey);
    menuKey = false;
  }
  if (sectionKey) {
    (Zotero as any).ItemPaneManager?.unregisterSection(sectionKey);
    sectionKey = false;
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
        menuType: "submenu",
        l10nID: getLocaleID("menu-structured-fields"),
        onShowing: (event: any) => {
          const element = event?.target as any;
          if (element) {
            element.hidden = !getPref("structuredFields.enabled");
          }
        },
        menus: [
          {
            menuType: "menuitem",
            l10nID: getLocaleID("menu-export-selected-table"),
            onCommand: () => {
              void exportTable(selectedItems());
            },
          },
          {
            menuType: "menuitem",
            l10nID: getLocaleID("menu-export-collection-table"),
            onCommand: () => {
              void exportTable(itemsInCurrentView());
            },
          },
          {
            menuType: "menuitem",
            l10nID: getLocaleID("menu-import-fields-csv"),
            onCommand: () => {
              void importFromCsv();
            },
          },
        ],
      },
    ],
  } as any);
  if (!menuKey) {
    Zotero.debug("[MyZoteroTools] 注册结构化字段菜单失败");
  }
}

/**
 * 条目信息面板里的「结构化字段」区块。
 *
 * 用官方 `ItemPaneManager.registerSection`（Zotero 7+），不做任何 monkey-patch。
 *
 * ⚠️ 两个坑（都实测踩过）：
 *  1. **`sidenav` 是必填的**（itemPaneManager.js:246-264 的 schema 没标 optional）。
 *     漏了它 `registerSection` 只返回 `false`，只在 `Zotero.warn` 里留一句
 *     「Option must have ["sidenav"]」—— 界面上就是静默地少一块。
 *  2. 注册失败**不抛异常**，所以必须检查返回值。
 */
function registerSection(): void {
  if (sectionKey) {
    return;
  }
  const manager = (Zotero as any).ItemPaneManager;
  if (!manager?.registerSection) {
    Zotero.debug(
      "[MyZoteroTools] 当前 Zotero 没有 ItemPaneManager，跳过结构化字段区块",
    );
    return;
  }

  const icon = `chrome://${config.addonRef}/content/icons/favicon.png`;
  sectionKey = manager.registerSection({
    paneID: SECTION_ID,
    pluginID: config.addonID,
    header: {
      l10nID: getLocaleID("section-structured-fields"),
      icon,
    },
    // 必填：会在条目面板左侧栏给这个区块一个入口
    sidenav: {
      l10nID: getLocaleID("sidenav-structured-fields"),
      icon,
    },
    onItemChange: ({ item, setEnabled }: any) => {
      setEnabled(
        !!getPref("structuredFields.enabled") && !!item?.isRegularItem?.(),
      );
    },
    onRender: ({ doc, body, item, editable }: any) => {
      renderSection(doc, body, item, !!editable);
    },
  } as any);

  if (!sectionKey) {
    Zotero.debug(
      "[MyZoteroTools] 注册结构化字段区块失败（检查 Zotero.warn 的输出；" +
        "常见原因是缺少必填的 sidenav，或 paneID 与内置面板冲突）",
    );
  }
}

/* ------------------------------------------------------------------ */
/* Extra 读写                                                          */
/* ------------------------------------------------------------------ */

function fieldPrefix(): string {
  return String(getPref("structuredFields.prefix") ?? "") || "mzt.";
}

/** 从条目的 Extra 里读出全部结构化字段 */
function readFields(item: Zotero.Item | null | undefined): Map<string, string> {
  const result = new Map<string, string>();
  if (!item) {
    return result;
  }
  const prefix = fieldPrefix();
  let extra: string;
  try {
    extra = String(item.getField("extra") ?? "");
  } catch {
    return result;
  }
  for (const rawLine of extra.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith(prefix)) {
      continue;
    }
    const body = line.slice(prefix.length);
    const separator = body.indexOf(":");
    if (separator < 0) {
      continue;
    }
    const name = body.slice(0, separator).trim();
    const value = body.slice(separator + 1).trim();
    if (name) {
      result.set(name, value);
    }
  }
  return result;
}

/**
 * 写回结构化字段。
 * @param updates 要设置或更新的字段（值为空字符串表示删除）
 */
async function writeFields(
  item: Zotero.Item,
  updates: Record<string, string>,
): Promise<void> {
  const prefix = fieldPrefix();
  const current = readFields(item);
  for (const [name, value] of Object.entries(updates)) {
    const trimmed = String(value ?? "").trim();
    if (trimmed) {
      current.set(name, trimmed);
    } else {
      current.delete(name);
    }
  }

  // 保留 Extra 里所有非本插件管理的行，只替换我们自己的行
  let extra: string;
  try {
    extra = String(item.getField("extra") ?? "");
  } catch {
    extra = "";
  }
  const kept = extra
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith(prefix));

  const ours = [...current.entries()].map(
    ([name, value]) => `${prefix}${name}: ${value}`,
  );
  const merged = [...kept.filter((line) => line.trim()), ...ours].join("\n");

  item.setField("extra", merged);
  await item.saveTx();
}

/* ------------------------------------------------------------------ */
/* 对比表                                                              */
/* ------------------------------------------------------------------ */

/** 把一组条目汇成一张「文献 × 字段」的表 */
function collectTable(items: Zotero.Item[]): FieldTable {
  const columns: string[] = [];
  const rows: FieldTable["rows"] = [];

  for (const item of items) {
    const fields = readFields(item);
    for (const name of fields.keys()) {
      if (!columns.includes(name)) {
        columns.push(name);
      }
    }
    rows.push({
      key: item.key,
      title: safeField(item, "title"),
      year: (safeField(item, "date").match(/\b(1[6-9]\d{2}|20\d{2})\b/) ?? [
        "",
      ])[0],
      values: Object.fromEntries(fields),
    });
  }

  return { columns, rows };
}

/** 导出对比表：CSV（Excel 友好）+ Markdown 各一份 */
async function exportTable(items: Zotero.Item[]): Promise<void> {
  if (!items.length) {
    notify(getString("structured-no-items"));
    return;
  }

  const dir = await resolveOutputDir();
  if (!dir) {
    return;
  }

  const table = collectTable(items);
  if (!table.columns.length) {
    notify(
      getString("structured-empty"),
      getString("structured-empty-hint", { args: { prefix: fieldPrefix() } }),
    );
    return;
  }

  try {
    const base = Zotero.File.pathToFile(dir);
    base.append(`DaxiangZoteroTools-fields-${timestamp()}`);
    await Zotero.File.createDirectoryIfMissingAsync(base.path);

    const csvFile = Zotero.File.pathToFile(base.path);
    csvFile.append("comparison.csv");
    await Zotero.File.putContentsAsync(csvFile.path, `\ufeff${toCsv(table)}`);

    const mdFile = Zotero.File.pathToFile(base.path);
    mdFile.append("comparison.md");
    await Zotero.File.putContentsAsync(mdFile.path, toMarkdown(table));

    notify(
      getString("structured-exported"),
      getString("structured-exported-detail", {
        args: { count: table.rows.length, dir: base.path },
      }),
    );
  } catch (e) {
    Zotero.logError(e as Error);
    notify(getString("structured-failed"), String(e));
  }
}

function toCsv(table: FieldTable): string {
  const header = ["key", "title", "year", ...table.columns];
  const lines = [header.map(csvCell).join(",")];
  for (const row of table.rows) {
    lines.push(
      [
        row.key,
        row.title,
        row.year,
        ...table.columns.map((column) => row.values[column] ?? ""),
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

function toMarkdown(table: FieldTable): string {
  const header = ["Zotero Key", "标题", "年份", ...table.columns];
  const lines = [
    "# 结构化字段对比表",
    "",
    `共 ${table.rows.length} 篇文献、${table.columns.length} 个字段。`,
    "",
    `| ${header.join(" | ")} |`,
    `|${header.map(() => "---").join("|")}|`,
  ];
  for (const row of table.rows) {
    const cells = [
      row.key,
      row.title.replace(/\|/g, "\\|"),
      row.year,
      ...table.columns.map((column) =>
        String(row.values[column] ?? "").replace(/\|/g, "\\|"),
      ),
    ];
    lines.push(`| ${cells.join(" | ")} |`);
  }
  return `${lines.join("\n")}\n`;
}

/* ------------------------------------------------------------------ */
/* CSV 导入（把外部抽取结果写回库）                                     */
/* ------------------------------------------------------------------ */

async function importFromCsv(): Promise<void> {
  const path = await chooseCsvFile();
  if (!path) {
    return;
  }

  let text: string;
  try {
    text = String((await Zotero.File.getContentsAsync(path)) ?? "");
  } catch (e) {
    notify(getString("structured-failed"), String(e));
    return;
  }

  const rows = parseCsv(text.replace(/^\ufeff/, ""));
  if (rows.length < 2) {
    notify(getString("structured-import-empty"));
    return;
  }

  const header = rows[0].map((cell) => cell.trim());
  const keyIndex = header.findIndex((name) => name.toLowerCase() === "key");
  if (keyIndex < 0) {
    notify(
      getString("structured-import-no-key"),
      getString("structured-import-no-key-hint"),
    );
    return;
  }
  const fieldColumns = header
    .map((name, index) => ({ name, index }))
    .filter((column) => column.index !== keyIndex && column.name);

  let updated = 0;
  let skipped = 0;
  for (const row of rows.slice(1)) {
    const itemKey = String(row[keyIndex] ?? "").trim();
    if (!itemKey) {
      continue;
    }
    const item = await findItemByKey(itemKey);
    if (!item) {
      skipped++;
      continue;
    }
    const updates: Record<string, string> = {};
    for (const column of fieldColumns) {
      const value = String(row[column.index] ?? "").trim();
      if (value) {
        updates[column.name] = value;
      }
    }
    if (!Object.keys(updates).length) {
      continue;
    }
    try {
      await writeFields(item, updates);
      updated++;
    } catch (e) {
      Zotero.debug(`[MyZoteroTools] 写入 ${itemKey} 失败: ${e}`);
      skipped++;
    }
  }

  notify(
    getString("structured-imported"),
    getString("structured-imported-detail", {
      args: { count: updated, skipped },
    }),
  );
}

async function findItemByKey(itemKey: string): Promise<Zotero.Item | null> {
  const libraryID = Zotero.Libraries.userLibraryID;
  try {
    // getByLibraryAndKeyAsync 找不到时返回 false（不是 null）
    const item = (await Zotero.Items.getByLibraryAndKeyAsync(
      libraryID,
      itemKey,
    )) as Zotero.Item | false | null;
    return item ? item : null;
  } catch (e) {
    Zotero.debug(`[MyZoteroTools] 找不到条目 ${itemKey}: ${e}`);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 条目面板区块渲染                                                    */
/* ------------------------------------------------------------------ */

function renderSection(
  doc: Document,
  body: HTMLElement,
  item: Zotero.Item | null,
  editable: boolean,
): void {
  body.textContent = "";
  if (!item?.isRegularItem?.()) {
    return;
  }

  const fields = readFields(item);
  const container = doc.createElement("div");
  container.className = "mzt-fields";

  if (!fields.size && !editable) {
    const empty = doc.createElement("div");
    empty.className = "mzt-fields-empty";
    empty.textContent = getString("section-structured-fields-empty");
    container.append(empty);
  }

  for (const [name, value] of fields) {
    const row = doc.createElement("div");
    row.className = "mzt-field-row";

    const label = doc.createElement("span");
    label.className = "mzt-field-name";
    label.textContent = name;
    row.append(label);

    if (editable) {
      const input = doc.createElement("input");
      input.className = "mzt-field-input";
      input.value = value;
      input.addEventListener("change", () => {
        void writeFields(item, { [name]: input.value });
      });
      row.append(input);

      const remove = doc.createElement("button");
      remove.className = "mzt-field-remove";
      remove.textContent = "✕";
      remove.title = getString("section-structured-fields-remove");
      remove.addEventListener("click", () => {
        void writeFields(item, { [name]: "" });
      });
      row.append(remove);
    } else {
      const span = doc.createElement("span");
      span.className = "mzt-field-value";
      span.textContent = value;
      row.append(span);
    }

    container.append(row);
  }

  if (editable) {
    container.append(buildAddRow(doc, item));
  }

  body.append(container);
}

function buildAddRow(doc: Document, item: Zotero.Item): HTMLElement {
  const row = doc.createElement("div");
  row.className = "mzt-field-row mzt-field-add";

  const nameInput = doc.createElement("input");
  nameInput.className = "mzt-field-input";
  nameInput.placeholder = getString("section-structured-fields-name");
  row.append(nameInput);

  const valueInput = doc.createElement("input");
  valueInput.className = "mzt-field-input";
  valueInput.placeholder = getString("section-structured-fields-value");
  row.append(valueInput);

  const add = doc.createElement("button");
  add.className = "mzt-field-add-button";
  add.textContent = getString("section-structured-fields-add");
  const commit = () => {
    const name = nameInput.value.trim();
    const value = valueInput.value.trim();
    if (!name || !value) {
      return;
    }
    void writeFields(item, { [name]: value });
  };
  add.addEventListener("click", commit);
  valueInput.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Enter") {
      commit();
    }
  });
  row.append(add);

  return row;
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

function selectedItems(): Zotero.Item[] {
  try {
    const pane = Zotero.getActiveZoteroPane() as any;
    const items: Zotero.Item[] = pane?.getSelectedItems?.() ?? [];
    return items.filter((item) => item?.isRegularItem?.());
  } catch (e) {
    Zotero.debug(`[MyZoteroTools] 读取选中条目失败: ${e}`);
    return [];
  }
}

/** 当前视图里的全部条目（选中分类下的，或选中条目所属的分类） */
function itemsInCurrentView(): Zotero.Item[] {
  try {
    const pane = Zotero.getActiveZoteroPane() as any;
    const items: Zotero.Item[] = pane?.getSortedItems?.() ?? [];
    const regular = items.filter((item) => item?.isRegularItem?.());
    if (regular.length) {
      return regular;
    }
  } catch (e) {
    Zotero.debug(`[MyZoteroTools] 读取当前视图条目失败: ${e}`);
  }
  // 退回到「选中条目所在的全部分类」
  const selected = selectedItems();
  const collectionIDs = new Set<number>();
  for (const item of selected) {
    for (const id of item.getCollections()) {
      collectionIDs.add(id);
    }
  }
  const collected: Zotero.Item[] = [];
  const seen = new Set<number>();
  for (const id of collectionIDs) {
    const collection = Zotero.Collections.get(id) as any;
    for (const item of collection?.getChildItems?.(false) ?? []) {
      if (!seen.has(item.id) && item.isRegularItem?.()) {
        seen.add(item.id);
        collected.push(item);
      }
    }
  }
  return collected;
}

async function resolveOutputDir(): Promise<string | null> {
  const configured = String(getPref("structuredFields.outputDir") ?? "").trim();
  if (configured) {
    try {
      await Zotero.File.createDirectoryIfMissingAsync(configured);
      return configured;
    } catch (e) {
      Zotero.debug(`[MyZoteroTools] 输出目录不可用，改为手动选择: ${e}`);
    }
  }
  return chooseFolder();
}

async function chooseFolder(): Promise<string | null> {
  try {
    const { FilePicker } = ChromeUtils.importESModule(
      "chrome://zotero/content/modules/filePicker.mjs",
    );
    const picker = new FilePicker();
    picker.init(
      Zotero.getMainWindow() as any,
      getString("structured-choose-folder"),
      picker.modeGetFolder,
    );
    const result = await picker.show();
    return result === picker.returnOK && picker.file
      ? String(picker.file)
      : null;
  } catch (e) {
    Zotero.debug(`[MyZoteroTools] 打开目录选择框失败: ${e}`);
    return null;
  }
}

async function chooseCsvFile(): Promise<string | null> {
  try {
    const { FilePicker } = ChromeUtils.importESModule(
      "chrome://zotero/content/modules/filePicker.mjs",
    );
    const picker = new FilePicker();
    picker.init(
      Zotero.getMainWindow() as any,
      getString("structured-choose-csv"),
      picker.modeOpen,
    );
    picker.appendFilter("CSV", "*.csv");
    const result = await picker.show();
    return result === picker.returnOK && picker.file
      ? String(picker.file)
      : null;
  } catch (e) {
    Zotero.debug(`[MyZoteroTools] 打开文件选择框失败: ${e}`);
    return null;
  }
}

function csvCell(value: string): string {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 极简 CSV 解析：支持双引号包裹、逗号与换行、双引号转义 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((entry) => entry.some((value) => value.trim()));
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
