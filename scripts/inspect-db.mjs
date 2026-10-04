// 直查快照数据库，核对分类树与条目数（仅用于诊断，不属于插件代码）
import { DatabaseSync } from "node:sqlite";

const dbPath = process.argv[2];
const db = new DatabaseSync(dbPath, { readOnly: true });

const collections = db
  .prepare(
    `SELECT c.collectionID AS id, c.collectionName AS name, c.parentCollectionID AS parent, c.libraryID
     FROM collections c
     LEFT JOIN deletedCollections dc ON dc.collectionID = c.collectionID
     WHERE dc.collectionID IS NULL
     ORDER BY c.collectionID`,
  )
  .all();

const counts = new Map();
for (const row of db
  .prepare(
    `SELECT collectionID AS id, COUNT(*) AS n, COUNT(DISTINCT itemID) AS d
     FROM collectionItems GROUP BY collectionID`,
  )
  .all()) {
  counts.set(row.id, { n: row.n, d: row.d });
}

console.log("id | parent | 直属条目(含重复) | 直属去重 | name");
for (const c of collections) {
  const cnt = counts.get(c.id) ?? { n: 0, d: 0 };
  console.log(
    `${c.id} | ${c.parent ?? "-"} | ${cnt.n} | ${cnt.d} | ${c.name}`,
  );
}

const descendantsOf = (id) => {
  const out = [];
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    for (const c of collections.filter((x) => x.parent === cur)) {
      out.push(c);
      stack.push(c.id);
    }
  }
  return out;
};

console.log("\n==== 顶层分类的聚合核对 ====");
for (const c of collections.filter((x) => x.parent === null)) {
  const desc = descendantsOf(c.id);
  const ids = [c.id, ...desc.map((d) => d.id)];
  const placeholders = ids.map(() => "?").join(",");
  const total = db
    .prepare(
      `SELECT COUNT(DISTINCT itemID) AS d FROM collectionItems WHERE collectionID IN (${placeholders})`,
    )
    .get(...ids).d;
  const direct = counts.get(c.id)?.d ?? 0;
  console.log(
    `「${c.name}」直属=${direct} 后代分类数=${desc.length} 聚合去重条目=${total}`,
  );
}

db.close();
