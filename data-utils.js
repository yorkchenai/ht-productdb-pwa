function parseJSON(value, fallback) {
  if (value && typeof value === "object") return value;
  try { return JSON.parse(value || ""); } catch { return fallback; }
}

function text(value) {
  return String(value ?? "").trim();
}

function quotationPrices(item, snapshot) {
  const columns = parseJSON(item.columns_json, []);
  const prices = [];
  if (columns.includes("latest_usd_price") || columns.includes("latest_usd_price_display")) {
    prices.push({ currency: "USD", amount: snapshot.latest_usd_price ?? null, unit: snapshot.price_unit ?? null, shade: null });
  }
  if (columns.includes("latest_rmb_price") || columns.includes("latest_rmb_price_display")) {
    prices.push({ currency: "RMB", amount: snapshot.latest_rmb_price ?? null, unit: snapshot.rmb_price_unit ?? null, shade: null });
  }
  for (const [key, shade] of [["latest_light_price", "浅色"], ["latest_medium_price", "中色"], ["latest_dark_price", "深色"]]) {
    if (columns.includes(key)) prices.push({ currency: "RMB", amount: snapshot[key] ?? null, unit: "kg", shade });
  }
  return prices;
}

export function buildCompositionRows(snapshot) {
  const counts = new Map();
  for (const part of snapshot?.compositionParts || []) {
    const code = text(part.code).toUpperCase();
    if (!code) continue;
    if (!counts.has(code)) counts.set(code, new Set());
    counts.get(code).add(part.product_id);
  }
  const dictionary = new Map();
  for (const item of snapshot?.compositionDictionary || []) {
    const code = text(item.code).toUpperCase();
    if (code) dictionary.set(code, { ...item, code: text(item.code) });
  }
  for (const code of counts.keys()) if (!dictionary.has(code)) dictionary.set(code, { code, english_name: "", chinese_name: "" });
  return [...dictionary.values()].map((item) => ({
    ...item,
    product_count: counts.get(text(item.code).toUpperCase())?.size || 0
  })).sort((left, right) => right.product_count - left.product_count || text(left.code).localeCompare(text(right.code), "en"));
}

export function buildQuotationRows(snapshot) {
  const products = new Map((snapshot?.products || []).map((product) => [product.id, product]));
  return (snapshot?.quotationItems || []).map((item) => {
    const quotedSnapshot = parseJSON(item.snapshot_json, {});
    const current = products.get(item.product_id) || {};
    const product = { ...current, ...quotedSnapshot };
    const row = {
      ...item,
      product,
      quotation_id: item.quotation_id,
      groups: item.groups_name || "",
      quotation_no: item.quotation_no || "",
      quoted_prices: quotationPrices(item, quotedSnapshot),
      title: product.neutral_model || product.supplier_model || product.product_name || "未命名产品"
    };
    row.search_text = [
      item.customer, item.groups_name, item.quotation_no, item.file_name,
      product.manufacturer, product.product_category, product.supplier_model,
      product.neutral_model, product.product_name, product.composition_code,
      product.composition_original, product.purpose, product.application
    ].map(text).filter(Boolean).join(" ").toLowerCase();
    return row;
  });
}

export function filterQuotationRows(rows, filters = {}) {
  const terms = text(filters.keyword).toLowerCase().split(/[\s,，;；]+/).filter(Boolean);
  const startDate = text(filters.startDate);
  const endDate = text(filters.endDate);
  const customer = text(filters.customer);
  return rows.filter((row) => {
    if (terms.length && !terms.some((term) => row.search_text.includes(term))) return false;
    const date = text(row.quoted_at).slice(0, 10);
    if (startDate && (!date || date < startDate)) return false;
    if (endDate && (!date || date > endDate)) return false;
    if (customer && text(row.customer) !== customer) return false;
    return true;
  });
}

export function filterExhibitionProducts(products, filters = {}, options = {}) {
  const terms = text(filters.keyword).toLowerCase().split(/[\s,，;；]+/).filter(Boolean);
  const manufacturer = text(filters.manufacturer);
  const category = text(filters.category);
  const composition = text(filters.composition).toUpperCase();
  const partsByProduct = options.partsByProduct || new Map();
  const searchText = options.searchText || ((product) => Object.values(product || {}).map(text).join(" ").toLowerCase());

  return (products || []).filter((product) => {
    const haystack = searchText(product);
    if (terms.length && !terms.every((term) => haystack.includes(term))) return false;
    if (manufacturer && text(product.manufacturer) !== manufacturer) return false;
    if (category && text(product.product_category) !== category) return false;
    if (composition) {
      const parts = partsByProduct.get(product.id) || [];
      if (!parts.some((part) => text(part.code).toUpperCase() === composition)) return false;
    }
    return true;
  });
}
