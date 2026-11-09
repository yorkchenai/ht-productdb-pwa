const PRODUCT_FIELDS = [
  ["manufacturer", "厂家", "Manufacturer"], ["product_category", "产品类别", "Product Category"],
  ["supplier_model", "型号", "Supplier Model"], ["neutral_model", "中性型号", "Art. NO."],
  ["product_name", "品名", "Product Name"], ["internal_code", "内部编号", "Internal Code"],
  ["composition_original", "成分原文", "Composition Original"], ["composition_code", "成分简写", "Composition"],
  ["width_original", "幅宽原文", "Width Original"], ["width_cm", "幅宽(cm)", "Width (cm)"],
  ["pattern_width_cm", "花宽(cm)", "Pattern Width (cm)"], ["pattern_height_cm", "花高(cm)", "Pattern Height (cm)"],
  ["width_mm", "宽度(mm)", "Width (mm)"], ["weight_original", "克重原文", "Weight Original"],
  ["weight_gsm", "克重(g/m²)", "Weight (g/m²)"], ["weight_gy", "码重(g/y)", "Weight (g/y)"],
  ["size", "尺寸", "Size"], ["machine_type", "机种类别", "Machine Type"],
  ["knit_type", "编织类型", "Knit Type"], ["application", "应用", "Application"],
  ["garment", "服装类型", "Garment"], ["technology", "工艺", "Technology"],
  ["purpose", "用途", "Purpose"], ["remark", "备注", "Remark"],
  ["moq", "MOQ", "MOQ"], ["moq_unit", "MOQ单位", "MOQ Unit"],
  ["mcq", "MCQ/起染量", "MCQ"], ["mcq_unit", "MCQ单位", "MCQ Unit"],
  ["yield_m_per_kg", "出率(m/kg)", "Yield (m/kg)"], ["trade_term", "贸易条款", "Trade Term"],
  ["data_status", "数据状态", "Data Status"], ["duplicate_group", "重复组", "Duplicate Group"],
  ["review_notes", "待确认事项", "Review Notes"], ["unmapped_fields", "未映射字段", "Unmapped Fields"]
].map(([key, zh, en]) => ({ key, zh, en }));

function valueOfCustom(value) {
  if (value?.value_number != null) return Number(value.value_number);
  return value?.value_text ?? null;
}

export function buildExhibitionRecords(products, snapshot) {
  const selectedIds = new Set((products || []).map((product) => product.id));
  const customByProduct = new Map();
  for (const value of snapshot?.productFieldValues || []) {
    if (!selectedIds.has(value.product_id)) continue;
    if (!customByProduct.has(value.product_id)) customByProduct.set(value.product_id, new Map());
    customByProduct.get(value.product_id).set(value.field_key, valueOfCustom(value));
  }
  const dynamicFields = (snapshot?.fieldDefinitions || [])
    .filter((field) => field.enabled !== 0 && !PRODUCT_FIELDS.some((item) => item.key === field.key))
    .map((field) => ({ key: field.key, zh: field.zh_name || field.zh || field.key, en: field.en_name || field.en || field.key }));
  const fields = [...PRODUCT_FIELDS, ...dynamicFields];
  const records = (products || []).map((product) => {
    const record = { ...product };
    for (const [key, value] of customByProduct.get(product.id) || []) record[key] = value;
    return record;
  });
  return { fields, records };
}

function styleSheet(sheet, columnCount) {
  sheet.views = [{ state: "frozen", ySplit: 2 }];
  if (sheet.rowCount >= 2) sheet.autoFilter = { from: { row: 2, column: 1 }, to: { row: Math.max(2, sheet.rowCount), column: columnCount } };
  for (const rowNumber of [1, 2]) {
    const row = sheet.getRow(rowNumber);
    row.height = 24;
    row.font = { bold: true, color: { argb: "FF14213D" } };
    row.alignment = { vertical: "middle", wrapText: true };
    row.eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: rowNumber === 1 ? "FFD9E8FB" : "FFEAF1FF" } };
      cell.border = { bottom: { style: "thin", color: { argb: "FFB8C7E5" } } };
    });
  }
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber > 2) row.alignment = { vertical: "top", wrapText: true };
  });
}

function latestUsd(productId, snapshot) {
  return (snapshot?.priceHistory || []).find((price) => price.product_id === productId && String(price.currency || "").toUpperCase() === "USD" && !price.field_key) || null;
}

function blobAsDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("图片读取失败"));
    reader.readAsDataURL(blob);
  });
}

async function addProductImage(workbook, sheet, product, rowNumber, getImage) {
  if (!product.image_filename || !getImage) return;
  const extension = String(product.image_filename).split(".").pop().toLowerCase().replace("jpg", "jpeg");
  if (!["png", "jpeg", "webp"].includes(extension)) return;
  const blob = await getImage(product.image_filename).catch(() => null);
  if (!blob) return;
  const imageId = workbook.addImage({ base64: await blobAsDataURL(blob), extension });
  sheet.addImage(imageId, { tl: { col: 0.08, row: rowNumber - 1 + 0.08 }, ext: { width: 82, height: 58 }, editAs: "oneCell" });
  sheet.getRow(rowNumber).height = 48;
}

async function addProductsSheet(workbook, products, snapshot, getImage) {
  const { fields, records } = buildExhibitionRecords(products, snapshot);
  const columns = [
    { key: "image", zh: "产品图片", en: "Pic." }, ...fields,
    { key: "latest_usd_price", zh: "最新美元报价", en: "Latest USD Price" },
    { key: "price_unit", zh: "报价单位", en: "Price Unit" },
    { key: "created_at", zh: "创建时间", en: "Created At" },
    { key: "updated_at", zh: "更新时间", en: "Updated At" }
  ];
  const sheet = workbook.addWorksheet("产品资料 Products");
  sheet.addRow(columns.map((field) => field.zh));
  sheet.addRow(columns.map((field) => field.en));
  for (const [index, product] of records.entries()) {
    const usd = latestUsd(product.id, snapshot);
    const record = { ...product, latest_usd_price: usd?.amount ?? null, price_unit: usd?.unit ?? null };
    sheet.addRow(columns.map((field) => record[field.key] ?? null));
    await addProductImage(workbook, sheet, product, index + 3, getImage);
  }
  columns.forEach((field, index) => {
    const long = ["composition_original", "purpose", "remark", "review_notes", "unmapped_fields"].includes(field.key);
    sheet.getColumn(index + 1).width = field.key === "image" ? 14 : long ? 30 : 17;
  });
  styleSheet(sheet, columns.length);
}

function addPriceHistorySheet(workbook, products, snapshot) {
  const selected = new Set(products.map((product) => product.id));
  const byId = new Map(products.map((product) => [product.id, product]));
  const fields = [["厂家", "Manufacturer"], ["型号", "Supplier Model"], ["中性型号", "Art. NO."], ["价格类型", "Price Type"], ["币种", "Currency"], ["单位", "Unit"], ["颜色深浅", "Shade"], ["价格", "Amount"], ["贸易条款", "Trade Term"], ["报价时间", "Quoted At"], ["来源", "Source"]];
  const sheet = workbook.addWorksheet("价格历史 Price History");
  sheet.addRow(fields.map(([zh]) => zh));
  sheet.addRow(fields.map(([, en]) => en));
  for (const price of snapshot?.priceHistory || []) {
    if (!selected.has(price.product_id)) continue;
    const product = byId.get(price.product_id) || {};
    sheet.addRow([product.manufacturer, product.supplier_model, product.neutral_model, price.price_label, price.currency, price.unit, price.shade, price.amount, price.trade_term, price.quoted_at, price.source]);
  }
  sheet.columns.forEach((column, index) => { column.width = [18, 18, 18, 20, 10, 10, 12, 14, 15, 20, 24][index]; });
  styleSheet(sheet, fields.length);
}

function addCompositionSheet(workbook, products, snapshot) {
  const selected = new Set(products.map((product) => product.id));
  const byId = new Map(products.map((product) => [product.id, product]));
  const fields = [["厂家", "Manufacturer"], ["型号", "Supplier Model"], ["中性型号", "Art. NO."], ["成分简写", "Composition"], ["百分比", "Percentage"], ["顺序", "Position"]];
  const sheet = workbook.addWorksheet("成分拆分 Composition");
  sheet.addRow(fields.map(([zh]) => zh));
  sheet.addRow(fields.map(([, en]) => en));
  for (const part of snapshot?.compositionParts || []) {
    if (!selected.has(part.product_id)) continue;
    const product = byId.get(part.product_id) || {};
    sheet.addRow([product.manufacturer, product.supplier_model, product.neutral_model, part.code, part.percentage, part.position]);
  }
  sheet.columns.forEach((column, index) => { column.width = [18, 18, 18, 18, 14, 10][index]; });
  styleSheet(sheet, fields.length);
}

function dateStamp() {
  const date = new Date();
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("");
}

export async function exportExhibitionWorkbook({ products, snapshot, getImage }) {
  if (!products?.length) throw new Error("请至少选择一个产品");
  const ExcelJS = globalThis.ExcelJS;
  if (!ExcelJS?.Workbook) throw new Error("Excel 导出组件尚未加载，请刷新页面后重试");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "HT Groups";
  workbook.created = new Date();
  await addProductsSheet(workbook, products, snapshot, getImage);
  addPriceHistorySheet(workbook, products, snapshot);
  addCompositionSheet(workbook, products, snapshot);
  const bytes = await workbook.xlsx.writeBuffer();
  const file = new File([bytes], `HT展会报价原始资料_${dateStamp()}.xlsx`, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  if (navigator.share && navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file], title: "HT 展会报价原始资料" });
    return "shared";
  }
  const url = URL.createObjectURL(file);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return "downloaded";
}
