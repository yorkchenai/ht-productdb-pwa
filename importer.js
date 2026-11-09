const MAXIMUM_COMPRESSED_BYTES = 750 * 1024 * 1024;
const REQUIRED_TABLES = ["products", "price_history", "quotations"];

function base64ToBytes(value) {
  const binary = atob(String(value || ""));
  const bytes = new Uint8Array(binary.length);
  const chunkSize = 64 * 1024;
  for (let start = 0; start < binary.length; start += chunkSize) {
    const end = Math.min(start + chunkSize, binary.length);
    for (let index = start; index < end; index += 1) bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function gunzip(bytes) {
  if (typeof DecompressionStream !== "function") {
    throw new Error("当前 iPhone 系统版本不支持读取压缩备份，请先更新 iOS");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function tableNames(database) {
  return new Set(queryRows(database, "SELECT name FROM sqlite_master WHERE type='table'").map((row) => row.name));
}

function tableColumns(database, tableName) {
  return new Set(queryRows(database, `PRAGMA table_info(${tableName})`).map((row) => row.name));
}

function queryRows(database, sql, parameters = []) {
  const statement = database.prepare(sql);
  try {
    if (parameters.length) statement.bind(parameters);
    const rows = [];
    while (statement.step()) rows.push(statement.getAsObject());
    return rows;
  } finally {
    statement.free();
  }
}

function imageMimeType(name) {
  const extension = name.split(".").pop()?.toLowerCase();
  if (extension === "png") return "image/png";
  if (extension === "webp") return "image/webp";
  if (extension === "gif") return "image/gif";
  if (extension === "heic" || extension === "heif") return "image/heic";
  return "image/jpeg";
}

function safeImageName(path) {
  if (typeof path !== "string" || !path || path.includes("\\") || path.includes("\0")) return null;
  const parts = path.split("/").filter(Boolean);
  const name = parts.at(-1);
  if (!name || name === "." || name === "..") return null;
  return name;
}

function optionalRows(database, tables, tableName, sql) {
  return tables.has(tableName) ? queryRows(database, sql) : [];
}

export async function prepareBackup(file, onProgress = () => {}) {
  if (!file || !file.name.toLowerCase().endsWith(".pdbfullbackup")) throw new Error("请选择 .pdbfullbackup 完整资料库备份");
  if (file.size > MAXIMUM_COMPRESSED_BYTES) throw new Error("备份文件过大，无法在手机中安全处理");

  onProgress("正在读取备份文件…");
  const compressed = new Uint8Array(await file.arrayBuffer());
  onProgress("正在解压并验证备份…");
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(await gunzip(compressed)));
  } catch (error) {
    if (error?.message?.includes("iPhone")) throw error;
    throw new Error("无法读取备份文件，文件可能已损坏或格式不正确");
  }

  const manifest = payload?.manifest;
  if (manifest?.format !== "HTGROUPS-PDB-FULL-BACKUP" || manifest?.formatVersion !== 1 || manifest?.mode !== "full") {
    throw new Error("这不是有效的 HT Groups 完整资料库备份");
  }

  onProgress("正在校验数据库…");
  const databaseBytes = base64ToBytes(payload.database);
  if (databaseBytes.length < 100 || await sha256(databaseBytes) !== String(manifest.databaseSha256 || "").toLowerCase()) {
    throw new Error("备份内数据库校验失败，文件可能已损坏");
  }

  const SQL = await globalThis.initSqlJs({
    locateFile: (name) => {
      const url = new URL(`./vendor/${name}`, import.meta.url);
      return url.protocol === "file:" ? decodeURIComponent(url.pathname) : url.href;
    }
  });
  const database = new SQL.Database(databaseBytes);
  let snapshot;
  let images;
  try {
    const integrity = queryRows(database, "PRAGMA integrity_check")[0];
    if (!integrity || Object.values(integrity)[0] !== "ok") throw new Error("备份内数据库完整性检查失败");
    const tables = tableNames(database);
    for (const table of REQUIRED_TABLES) {
      if (!tables.has(table)) throw new Error(`备份缺少必要数据表：${table}`);
    }

    onProgress("正在提取只读产品资料…");
    const products = queryRows(database, "SELECT * FROM products");
    const priceHistory = queryRows(database, "SELECT * FROM price_history ORDER BY quoted_at DESC, created_at DESC");
    const compositionParts = optionalRows(database, tables, "composition_parts", "SELECT * FROM composition_parts ORDER BY product_id, position");
    const compositionDictionary = optionalRows(database, tables, "composition_dictionary", "SELECT * FROM composition_dictionary ORDER BY code COLLATE NOCASE");
    const fieldDefinitionColumns = tables.has("field_definitions") ? tableColumns(database, "field_definitions") : new Set();
    const fieldDefinitions = optionalRows(
      database,
      tables,
      "field_definitions",
      `SELECT * FROM field_definitions ${fieldDefinitionColumns.has("enabled") ? "WHERE coalesce(enabled,1)=1" : ""} ORDER BY created_at, zh_name`
    );
    const productFieldValues = optionalRows(database, tables, "product_field_values", "SELECT * FROM product_field_values");
    const quotationColumns = tableColumns(database, "quotations");
    const quotationItems = tables.has("quotation_items")
      ? queryRows(database, `
          SELECT qi.id, qi.quotation_id, qi.product_id, qi.position, qi.snapshot_json,
                 ${quotationColumns.has("groups_name") ? "q.groups_name" : "NULL AS groups_name"},
                 q.customer, q.quoted_at, q.file_name
          FROM quotation_items qi JOIN quotations q ON q.id=qi.quotation_id
          ORDER BY q.quoted_at DESC, q.created_at DESC, qi.position`)
      : [];

    if (manifest.counts?.products != null && Number(manifest.counts.products) !== products.length) {
      throw new Error("产品数量与备份清单不一致");
    }

    const referencedImages = new Set(products.map((product) => product.image_filename).filter(Boolean));
    const imageEntries = new Map();
    for (const entry of payload.files?.images || []) {
      const name = safeImageName(entry?.path);
      if (name && referencedImages.has(name)) imageEntries.set(name, entry);
    }

    images = [];
    for (const [name, entry] of imageEntries) {
      const bytes = base64ToBytes(entry.data);
      if (bytes.length !== Number(entry.size) || await sha256(bytes) !== String(entry.sha256 || "").toLowerCase()) {
        throw new Error(`产品图片校验失败：${name}`);
      }
      images.push({ name, blob: new Blob([bytes], { type: imageMimeType(name) }) });
    }

    const customFieldCount = fieldDefinitions.length;
    const quotationCount = Number(queryRows(database, "SELECT COUNT(*) AS count FROM quotations")[0]?.count || 0);
    snapshot = {
      id: crypto.randomUUID(),
      importedAt: new Date().toISOString(),
      sourceFileName: file.name,
      metadata: {
        dataVersion: manifest.exportedAt,
        exportedAt: manifest.exportedAt,
        applicationVersion: manifest.applicationVersion || "—",
        formatVersion: manifest.formatVersion,
        databaseSha256: manifest.databaseSha256,
        productCount: products.length,
        priceCount: priceHistory.length,
        quotationCount,
        imageCount: images.length,
        customFieldCount
      },
      products,
      priceHistory,
      compositionParts,
      compositionDictionary,
      fieldDefinitions,
      productFieldValues,
      quotationItems
    };
  } finally {
    database.close();
  }
  onProgress("验证完成，等待确认…");
  return { snapshot, images };
}
