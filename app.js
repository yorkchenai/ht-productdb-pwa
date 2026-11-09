import { getCurrentImage, getCurrentSnapshot, hasPreviousSnapshot, requestPersistentStorage, restorePreviousSnapshot, saveSnapshot } from "./storage.js";
import { prepareBackup } from "./importer.js";
import { buildCompositionRows, buildExhibitionPublicProduct, buildQuotationRows, filterExhibitionProducts, filterQuotationRows } from "./data-utils.js?v=4";
import { exportExhibitionWorkbook } from "./exhibition-export.js?v=4";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const PAGE_SIZE = 24;
const HISTORY_PAGE_SIZE = 20;

const state = {
  snapshot: null,
  products: [],
  filtered: [],
  page: 1,
  dictionaryRows: [],
  quotationRows: [],
  filteredQuotations: [],
  quotationPage: 1,
  exhibitionFiltered: [],
  exhibitionPage: 1,
  exhibitionSelected: new Map(),
  pendingImport: null,
  maps: {},
  objectURLs: new Set()
};

function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function blank(value) {
  return value == null || String(value).trim() === "";
}

function numberOrNull(value) {
  if (blank(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function displayNumber(value, maximum = 4) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: maximum }).format(number);
}

function displayDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function priceDisplay(price) {
  if (!price || price.amount == null) return "—";
  const currency = price.currency ? `${price.currency} ` : "";
  const unit = price.unit ? ` / ${price.unit}` : "";
  return `${currency}${displayNumber(price.amount)}${unit}`;
}

function currentPrice(productId, predicate) {
  return (state.maps.pricesByProduct.get(productId) || []).find(predicate) || null;
}

function standardPrice(productId, currency, shade = "") {
  const normalizedShade = shade.toLowerCase();
  return currentPrice(productId, (price) => {
    if (String(price.currency || "").toUpperCase() !== currency) return false;
    if (!blank(price.field_key)) return false;
    return String(price.shade || "").trim().toLowerCase() === normalizedShade;
  });
}

function buildMaps(snapshot) {
  const pricesByProduct = new Map();
  for (const price of snapshot?.priceHistory || []) {
    if (!pricesByProduct.has(price.product_id)) pricesByProduct.set(price.product_id, []);
    pricesByProduct.get(price.product_id).push(price);
  }
  const partsByProduct = new Map();
  for (const part of snapshot?.compositionParts || []) {
    if (!partsByProduct.has(part.product_id)) partsByProduct.set(part.product_id, []);
    partsByProduct.get(part.product_id).push(part);
  }
  const customByProduct = new Map();
  for (const value of snapshot?.productFieldValues || []) {
    if (!customByProduct.has(value.product_id)) customByProduct.set(value.product_id, []);
    customByProduct.get(value.product_id).push(value);
  }
  const quotationRows = buildQuotationRows(snapshot);
  const quotesByProduct = new Map();
  for (const quote of quotationRows) {
    if (!quote.product_id) continue;
    if (!quotesByProduct.has(quote.product_id)) quotesByProduct.set(quote.product_id, []);
    quotesByProduct.get(quote.product_id).push(quote);
  }
  const fieldDefinitions = new Map((snapshot?.fieldDefinitions || []).map((field) => [field.key, field]));
  const productsById = new Map((snapshot?.products || []).map((product) => [product.id, product]));
  state.maps = { pricesByProduct, partsByProduct, customByProduct, quotesByProduct, fieldDefinitions, productsById };
  state.dictionaryRows = buildCompositionRows(snapshot);
  state.quotationRows = quotationRows;
}

function productTitle(product) {
  return product.neutral_model || product.supplier_model || product.product_name || "未命名产品";
}

function productKeywordText(product) {
  const customs = (state.maps.customByProduct.get(product.id) || []).map((value) => `${value.value_text || ""} ${value.value_number ?? ""}`).join(" ");
  return [
    product.manufacturer, product.product_category, product.supplier_model, product.neutral_model,
    product.product_name, product.internal_code, product.composition_original, product.composition_code,
    product.application, product.purpose, product.remark, customs
  ].filter(Boolean).join(" ").toLowerCase();
}

function clearObjectURLs() {
  for (const url of state.objectURLs) URL.revokeObjectURL(url);
  state.objectURLs.clear();
}

async function loadImageInto(element, filename) {
  if (!element || !filename) return;
  const blob = await getCurrentImage(filename);
  if (!blob || !document.contains(element)) return;
  const url = URL.createObjectURL(blob);
  state.objectURLs.add(url);
  const image = document.createElement("img");
  image.src = url;
  image.alt = "产品图片";
  element.replaceChildren(image);
}

function populateSelect(select, values, placeholder) {
  select.replaceChildren(new Option(placeholder, ""));
  for (const value of values) select.add(new Option(value, value));
}

function populateFilters() {
  const products = state.products;
  const distinct = (key) => [...new Set(products.map((product) => String(product[key] || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  populateSelect($("#manufacturer"), distinct("manufacturer"), "全部厂家");
  populateSelect($("#category"), distinct("product_category"), "全部类别");
  populateSelect($("#exhibitionManufacturer"), distinct("manufacturer"), "全部厂家");
  populateSelect($("#exhibitionCategory"), distinct("product_category"), "全部类别");
  const dictionary = new Map((state.snapshot?.compositionDictionary || []).map((item) => [String(item.code).toUpperCase(), item]));
  const codes = [...new Set((state.snapshot?.compositionParts || []).map((part) => String(part.code || "").trim()).filter(Boolean))].sort();
  const select = $("#composition");
  select.replaceChildren(new Option("选择成分", ""));
  const exhibitionSelect = $("#exhibitionComposition");
  exhibitionSelect.replaceChildren(new Option("全部成分", ""));
  for (const code of codes) {
    const item = dictionary.get(code.toUpperCase());
    const suffix = [item?.english_name, item?.chinese_name].filter(Boolean).join(" / ");
    const label = suffix ? `${code} · ${suffix}` : code;
    select.add(new Option(label, code));
    exhibitionSelect.add(new Option(label, code));
  }
}

function activeFilters() {
  return {
    keyword: $("#keyword").value.trim().toLowerCase(),
    manufacturer: $("#manufacturer").value,
    category: $("#category").value,
    widthMin: numberOrNull($("#widthMin").value), widthMax: numberOrNull($("#widthMax").value),
    weightMin: numberOrNull($("#weightMin").value), weightMax: numberOrNull($("#weightMax").value),
    priceMin: numberOrNull($("#priceMin").value), priceMax: numberOrNull($("#priceMax").value),
    composition: $("#composition").value,
    compositionMin: numberOrNull($("#compositionMin").value), compositionMax: numberOrNull($("#compositionMax").value)
  };
}

function inRange(value, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return false;
  return (minimum == null || number >= minimum) && (maximum == null || number <= maximum);
}

function filterProducts() {
  const filter = activeFilters();
  state.filtered = state.products.filter((product) => {
    if (filter.keyword && !productKeywordText(product).includes(filter.keyword)) return false;
    if (filter.manufacturer && product.manufacturer !== filter.manufacturer) return false;
    if (filter.category && product.product_category !== filter.category) return false;
    if ((filter.widthMin != null || filter.widthMax != null) && !inRange(product.width_cm, filter.widthMin, filter.widthMax)) return false;
    if ((filter.weightMin != null || filter.weightMax != null) && !inRange(product.weight_gsm, filter.weightMin, filter.weightMax)) return false;
    if (filter.composition) {
      const match = (state.maps.partsByProduct.get(product.id) || []).find((part) => String(part.code).toUpperCase() === filter.composition.toUpperCase());
      if (!match || !inRange(match.percentage, filter.compositionMin, filter.compositionMax)) return false;
    }
    if (filter.priceMin != null || filter.priceMax != null) {
      const values = ["", "light", "medium", "dark", "浅色", "中色", "深色"]
        .map((shade) => standardPrice(product.id, "RMB", shade)?.amount)
        .filter((value) => value != null);
      if (!values.some((value) => inRange(value, filter.priceMin, filter.priceMax))) return false;
    }
    return true;
  });
  state.page = 1;
  renderProducts();
}

function renderProducts() {
  clearObjectURLs();
  const list = $("#productList");
  const pagination = $("#pagination");
  $("#resultCount").textContent = state.filtered.length.toLocaleString();
  $("#emptyData").classList.toggle("hidden", Boolean(state.snapshot));

  if (!state.snapshot) {
    list.replaceChildren();
    pagination.classList.add("hidden");
    return;
  }
  if (!state.filtered.length) {
    list.innerHTML = '<div class="empty-card"><h2>没有符合条件的产品</h2><p>可以放宽筛选范围后再查询。</p></div>';
    pagination.classList.add("hidden");
    return;
  }

  const pageCount = Math.max(1, Math.ceil(state.filtered.length / PAGE_SIZE));
  state.page = Math.min(state.page, pageCount);
  const products = state.filtered.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);
  list.innerHTML = products.map((product) => {
    const usd = standardPrice(product.id, "USD");
    return `
      <button class="product-card" type="button" data-product-id="${escapeHTML(product.id)}">
        <span class="product-image" data-image="${escapeHTML(product.image_filename || "")}">${product.image_filename ? "加载中" : "暂无"}</span>
        <span class="product-summary">
          <strong>${escapeHTML(productTitle(product))}</strong>
          <span class="sub">${escapeHTML([product.manufacturer, product.product_category, product.product_name].filter(Boolean).join(" · ") || "—")}</span>
          <span class="composition">${escapeHTML(product.composition_code || product.composition_original || "成分未填写")}</span>
        </span>
        <span class="product-metrics">
          <em>${escapeHTML(priceDisplay(usd))}</em>
          <span>${escapeHTML(product.width_cm == null ? "— cm" : `${displayNumber(product.width_cm)} cm`)}</span>
          <span>${escapeHTML(product.weight_gsm == null ? "— g/m²" : `${displayNumber(product.weight_gsm)} g/m²`)}</span>
        </span>
      </button>`;
  }).join("");
  for (const element of $$('[data-image]', list)) loadImageInto(element, element.dataset.image);
  pagination.classList.toggle("hidden", pageCount <= 1);
  $("#pageStatus").textContent = `第 ${state.page} / ${pageCount} 页`;
  $("#previousPage").disabled = state.page <= 1;
  $("#nextPage").disabled = state.page >= pageCount;
}

function exhibitionFilters() {
  return {
    keyword: $("#exhibitionKeyword").value,
    manufacturer: $("#exhibitionManufacturer").value,
    category: $("#exhibitionCategory").value,
    composition: $("#exhibitionComposition").value
  };
}

function applyExhibitionFilters() {
  state.exhibitionFiltered = filterExhibitionProducts(state.products, exhibitionFilters(), {
    partsByProduct: state.maps.partsByProduct,
    searchText: productKeywordText
  });
  state.exhibitionPage = 1;
  renderExhibition();
}

function currentExhibitionPageProducts() {
  return state.exhibitionFiltered.slice((state.exhibitionPage - 1) * PAGE_SIZE, state.exhibitionPage * PAGE_SIZE);
}

function renderExhibitionSelection() {
  const products = [...state.exhibitionSelected.values()];
  $("#selectedCount").textContent = products.length.toLocaleString();
  $("#clearSelection").disabled = !products.length;
  $("#exportSelection").disabled = !products.length;
  $("#selectedProducts").innerHTML = products.length
    ? products.map((product) => `<button type="button" class="selected-chip" data-remove-selected="${escapeHTML(product.id)}" title="移除"><span>${escapeHTML(productTitle(product))}</span><b>×</b></button>`).join("")
    : '<span class="selection-placeholder">可跨多次查询持续勾选产品</span>';
}

function renderExhibition() {
  clearObjectURLs();
  const list = $("#exhibitionList");
  const pagination = $("#exhibitionPagination");
  $("#exhibitionCount").textContent = state.exhibitionFiltered.length.toLocaleString();
  $("#exhibitionEmpty").classList.toggle("hidden", Boolean(state.snapshot));
  renderExhibitionSelection();
  if (!state.snapshot) {
    list.replaceChildren();
    pagination.classList.add("hidden");
    $("#selectExhibitionPage").checked = false;
    $("#selectExhibitionPage").disabled = true;
    return;
  }
  if (!state.exhibitionFiltered.length) {
    list.innerHTML = '<div class="empty-card"><h2>没有符合条件的产品</h2><p>可以重置条件后再搜索。</p></div>';
    pagination.classList.add("hidden");
    $("#selectExhibitionPage").checked = false;
    $("#selectExhibitionPage").disabled = true;
    return;
  }

  const pageCount = Math.max(1, Math.ceil(state.exhibitionFiltered.length / PAGE_SIZE));
  state.exhibitionPage = Math.min(state.exhibitionPage, pageCount);
  const products = currentExhibitionPageProducts();
  list.innerHTML = products.map((product) => {
    const visible = buildExhibitionPublicProduct(product);
    const selected = state.exhibitionSelected.has(product.id);
    const internalItems = [
      ["厂家 · Manufacturer", product.manufacturer],
      ["美元单价 · USD", priceDisplay(standardPrice(product.id, "USD"))],
      ["人民币单价 · RMB", priceDisplay(standardPrice(product.id, "RMB"))],
      ["浅色价 · Light", priceDisplay(standardPrice(product.id, "RMB", "light") || standardPrice(product.id, "RMB", "浅色"))],
      ["中色价 · Medium", priceDisplay(standardPrice(product.id, "RMB", "medium") || standardPrice(product.id, "RMB", "中色"))],
      ["深色价 · Dark", priceDisplay(standardPrice(product.id, "RMB", "dark") || standardPrice(product.id, "RMB", "深色"))],
      ["贸易条款 · Trade Term", product.trade_term]
    ].map(([name, value]) => detailItem(name, value)).join("");
    return `<article class="exhibition-product-card${selected ? " selected" : ""}">
      <label class="product-selector" aria-label="选择 ${escapeHTML(productTitle(visible))}"><input type="checkbox" data-select-product="${escapeHTML(visible.id)}" ${selected ? "checked" : ""}><span></span></label>
      <span class="product-image" data-image="${escapeHTML(visible.image_filename || "")}">${visible.image_filename ? "加载中" : "暂无"}</span>
      <div class="exhibition-public">
        <div class="exhibition-category">${escapeHTML(visible.product_category || "类别未填写")}</div>
        <div class="exhibition-models"><strong>${escapeHTML(visible.supplier_model || "型号未填写")}</strong><span>${escapeHTML(visible.neutral_model || "中性型号未填写")}</span></div>
        <div class="exhibition-code"><small>内部编号</small><strong>${escapeHTML(visible.internal_code || "—")}</strong></div>
        <div class="exhibition-name"><strong>${escapeHTML(visible.product_name || "品名未填写")}</strong><span>${escapeHTML(visible.composition_code || visible.composition_original || "成分未填写")}</span></div>
        <div class="exhibition-specs">
          <span><small>幅宽 / 克重</small><strong>${escapeHTML(visible.width_cm == null ? "— cm" : `${displayNumber(visible.width_cm)} cm`)}</strong><em>${escapeHTML(visible.weight_gsm == null ? "— g/m²" : `${displayNumber(visible.weight_gsm)} g/m²`)}</em></span>
          <span><small>MOQ / MCQ</small><strong>${escapeHTML(visible.moq == null ? "—" : `${displayNumber(visible.moq)} ${visible.moq_unit || ""}`.trim())}</strong><em>${escapeHTML(visible.mcq == null ? "—" : `${displayNumber(visible.mcq)} ${visible.mcq_unit || ""}`.trim())}</em></span>
        </div>
        <details class="exhibition-internal">
          <summary>展开内部资料（含厂家、价格）</summary>
          <div class="exhibition-internal-grid">${internalItems || '<p class="muted">暂无内部资料</p>'}</div>
          <button class="secondary exhibition-full-detail" type="button" data-exhibition-detail="${escapeHTML(product.id)}">查看全部原始资料</button>
        </details>
      </div>
    </article>`;
  }).join("");
  for (const element of $$('[data-image]', list)) loadImageInto(element, element.dataset.image);
  const allSelected = products.length > 0 && products.every((product) => state.exhibitionSelected.has(product.id));
  $("#selectExhibitionPage").disabled = false;
  $("#selectExhibitionPage").checked = allSelected;
  pagination.classList.toggle("hidden", pageCount <= 1);
  $("#exhibitionPageStatus").textContent = `第 ${state.exhibitionPage} / ${pageCount} 页`;
  $("#exhibitionPreviousPage").disabled = state.exhibitionPage <= 1;
  $("#exhibitionNextPage").disabled = state.exhibitionPage >= pageCount;
}

function toggleExhibitionProduct(productId, selected) {
  const product = state.maps.productsById.get(productId);
  if (!product) return;
  if (selected) state.exhibitionSelected.set(productId, product);
  else state.exhibitionSelected.delete(productId);
  renderExhibition();
}

async function exportExhibitionSelection() {
  const button = $("#exportSelection");
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "正在生成 Excel…";
  try {
    const result = await exportExhibitionWorkbook({ products: [...state.exhibitionSelected.values()], snapshot: state.snapshot, getImage: getCurrentImage });
    if (result === "downloaded") showMessage("Excel 已生成", "文件已下载到手机，可在 Safari 下载项目或“文件”App中查看。");
  } catch (error) {
    if (error?.name !== "AbortError") showMessage("导出失败", error.message || String(error));
  } finally {
    button.textContent = originalText;
    button.disabled = state.exhibitionSelected.size === 0;
  }
}

function renderDictionary() {
  const keyword = $("#dictionaryKeyword").value.trim().toLowerCase();
  const rows = state.dictionaryRows.filter((row) => !keyword || [row.code, row.english_name, row.chinese_name, row.aliases]
    .some((value) => String(value || "").toLowerCase().includes(keyword)));
  $("#dictionaryCount").textContent = rows.length.toLocaleString();
  $("#dictionaryEmpty").classList.toggle("hidden", Boolean(state.snapshot));
  if (!state.snapshot) {
    $("#dictionaryList").replaceChildren();
    return;
  }
  $("#dictionaryList").innerHTML = rows.length ? rows.map((row) => `
    <article class="dictionary-card">
      <strong>${escapeHTML(row.code || "—")}</strong>
      <span><b>${escapeHTML(row.english_name || "英文名称未填写")}</b><small>${escapeHTML(row.chinese_name || "中文名称未填写")}</small></span>
      <em>${Number(row.product_count || 0).toLocaleString()} 个产品</em>
    </article>`).join("") : '<div class="empty-card"><h2>没有符合条件的成分</h2><p>可以尝试简写、英文或中文名称。</p></div>';
}

function quotedPriceText(price) {
  const shade = price.shade ? `${price.shade} ` : "";
  if (price.amount == null) return `${shade}${price.currency || ""} 价格空白`.trim();
  return `${shade}${priceDisplay(price)}`;
}

function quotationFilters() {
  return {
    keyword: $("#quotationKeyword").value,
    startDate: $("#quotationStartDate").value,
    endDate: $("#quotationEndDate").value,
    customer: $("#quotationCustomer").value
  };
}

function applyQuotationFilters() {
  state.filteredQuotations = filterQuotationRows(state.quotationRows, quotationFilters());
  state.quotationPage = 1;
  renderQuotationHistory();
}

function renderQuotationHistory() {
  const list = $("#quotationList");
  const pagination = $("#quotationPagination");
  $("#quotationCount").textContent = state.filteredQuotations.length.toLocaleString();
  $("#quotationEmpty").classList.toggle("hidden", Boolean(state.snapshot));
  if (!state.snapshot) {
    list.replaceChildren();
    pagination.classList.add("hidden");
    return;
  }
  if (!state.filteredQuotations.length) {
    list.innerHTML = '<div class="empty-card"><h2>没有符合条件的产品报价历史</h2><p>客户名称只需输入其中一个单词即可搜索。</p></div>';
    pagination.classList.add("hidden");
    return;
  }
  const pageCount = Math.max(1, Math.ceil(state.filteredQuotations.length / HISTORY_PAGE_SIZE));
  state.quotationPage = Math.min(state.quotationPage, pageCount);
  const rows = state.filteredQuotations.slice((state.quotationPage - 1) * HISTORY_PAGE_SIZE, state.quotationPage * HISTORY_PAGE_SIZE);
  list.innerHTML = rows.map((row) => {
    const product = row.product || {};
    const prices = row.quoted_prices.map(quotedPriceText).join("；") || "报价表未选择价格栏";
    return `<button class="quotation-card" type="button" ${row.product_id ? `data-quotation-product="${escapeHTML(row.product_id)}"` : ""}>
      <span class="quotation-heading"><strong>${escapeHTML(row.customer || "客户未填写")}</strong><time>${escapeHTML(displayDate(row.quoted_at))}</time></span>
      <span class="quotation-groups">${escapeHTML(row.groups || row.quotation_no || "Groups 未填写")}</span>
      <span class="quotation-product"><b>${escapeHTML(row.title)}</b><small>${escapeHTML([product.manufacturer, product.product_category, product.product_name, product.composition_code || product.composition_original].filter(Boolean).join(" · ") || "—")}</small></span>
      <em>${escapeHTML(prices)}</em>
    </button>`;
  }).join("");
  pagination.classList.toggle("hidden", pageCount <= 1);
  $("#quotationPageStatus").textContent = `第 ${state.quotationPage} / ${pageCount} 页`;
  $("#quotationPreviousPage").disabled = state.quotationPage <= 1;
  $("#quotationNextPage").disabled = state.quotationPage >= pageCount;
}

function detailItem(name, value) {
  if (blank(value)) return "";
  return `<div class="detail-item"><small>${escapeHTML(name)}</small><strong>${escapeHTML(value)}</strong></div>`;
}

function priceRows(prices) {
  if (!prices.length) return '<p class="muted">暂无记录</p>';
  const rows = prices.map((price) => `
    <div class="history-row">
      <span><small>${escapeHTML(price.price_label || price.shade || price.source || "价格记录")}</small>${escapeHTML(priceDisplay(price))}</span>
      <span><small>${escapeHTML(price.trade_term || "")}</small>${escapeHTML(displayDate(price.quoted_at))}</span>
    </div>`);
  return foldedHistory(rows);
}

function foldedHistory(rows) {
  if (!rows.length) return '<p class="muted">暂无记录</p>';
  if (rows.length <= 3) return rows.join("");
  return `${rows.slice(0, 3).join("")}<details class="history-more"><summary>展开其余 ${rows.length - 3} 条</summary><div class="history-more-rows">${rows.slice(3).join("")}</div></details>`;
}

function quoteRows(quotes) {
  const rows = quotes.map((quote) => {
    const prices = quote.quoted_prices.map(quotedPriceText).join("；") || "报价表未选择价格栏";
    return `<div class="quotation-history-row">
      <strong>${escapeHTML(quote.customer || "客户未填写")}</strong>
      <span>${escapeHTML(quote.groups || quote.quotation_no || "Groups 未填写")}</span>
      <span>${escapeHTML(prices)}</span>
      <time>${escapeHTML(displayDate(quote.quoted_at))}</time>
    </div>`;
  });
  return foldedHistory(rows);
}

function detailSection(title, items) {
  const html = items.map(([name, value]) => detailItem(name, value)).join("");
  return html ? `<section class="detail-section"><h3>${escapeHTML(title)}</h3><div class="detail-grid">${html}</div></section>` : "";
}

async function openProductDetail(productId) {
  const product = state.maps.productsById.get(productId);
  if (!product) return;
  const prices = state.maps.pricesByProduct.get(productId) || [];
  const quotes = state.maps.quotesByProduct.get(productId) || [];
  const customValues = state.maps.customByProduct.get(productId) || [];
  const customHTML = customValues.map((value) => {
    const field = state.maps.fieldDefinitions.get(value.field_key);
    const amount = value.value_number == null ? value.value_text : `${value.currency ? `${value.currency} ` : ""}${displayNumber(value.value_number)}${value.unit ? ` / ${value.unit}` : ""}`;
    return detailItem([field?.zh_name, field?.en_name].filter(Boolean).join(" · ") || value.field_key, amount);
  }).join("");
  const basicItems = [
    ["厂家 · Manufacturer", product.manufacturer], ["产品类别 · Product Category", product.product_category],
    ["型号 · Supplier Model", product.supplier_model], ["中性型号 · Art. NO.", product.neutral_model],
    ["品名 · Product Name", product.product_name], ["内部编号 · Internal Code", product.internal_code]
  ];
  const compositionItems = [
    ["成分 · Composition", product.composition_code], ["成分原文 · Composition Original", product.composition_original],
    ["幅宽 · Width", product.width_cm == null ? null : `${displayNumber(product.width_cm)} cm`],
    ["花宽 · Pattern Width", product.pattern_width_cm == null ? null : `${displayNumber(product.pattern_width_cm)} cm`],
    ["花高 · Pattern Height", product.pattern_height_cm == null ? null : `${displayNumber(product.pattern_height_cm)} cm`],
    ["宽度 · Width", product.width_mm == null ? null : `${displayNumber(product.width_mm)} mm`],
    ["克重 · Weight", product.weight_gsm == null ? null : `${displayNumber(product.weight_gsm)} g/m²`],
    ["码重 · Weight", product.weight_gy == null ? null : `${displayNumber(product.weight_gy)} g/y`],
    ["尺寸 · Size", product.size]
  ];
  const businessItems = [
    ["MOQ", product.moq == null ? null : `${displayNumber(product.moq)} ${product.moq_unit || ""}`.trim()],
    ["MCQ", product.mcq == null ? null : `${displayNumber(product.mcq)} ${product.mcq_unit || ""}`.trim()],
    ["出率 · Yield", product.yield_m_per_kg == null ? null : `${displayNumber(product.yield_m_per_kg, 2)} m/kg`],
    ["贸易条款 · Trade Term", product.trade_term]
  ];
  const processItems = [
    ["机种类别 · Machine Type", product.machine_type],
    ["编织类型 · Knit Type", product.knit_type], ["应用 · Application", product.application],
    ["服装类型 · Garment", product.garment], ["工艺 · Technology", product.technology],
    ["用途 · Purpose", product.purpose], ["备注 · Remark", product.remark]
  ];
  const supplementaryItems = [
    ["幅宽原文 · Width Original", product.width_original], ["克重原文 · Weight Original", product.weight_original],
    ["数据状态 · Data Status", product.data_status], ["重复组 · Duplicate Group", product.duplicate_group],
    ["待确认事项 · Review Notes", product.review_notes], ["未映射字段 · Unmapped Fields", product.unmapped_fields],
    ["录入时间 · Created", product.created_at ? displayDate(product.created_at) : null],
    ["更新时间 · Updated", product.updated_at ? displayDate(product.updated_at) : null]
  ];
  const parts = state.maps.partsByProduct.get(productId) || [];
  const compositionSplitHTML = parts.length ? `<section class="detail-section"><h3>成分拆分</h3><div class="composition-parts">${parts.map((part) => `<span><b>${escapeHTML(part.code || "—")}</b>${escapeHTML(displayNumber(part.percentage, 2))}%</span>`).join("")}</div></section>` : "";

  const latestPrices = [
    ["美元单价", standardPrice(productId, "USD")], ["人民币单价", standardPrice(productId, "RMB")],
    ["浅色价", standardPrice(productId, "RMB", "light") || standardPrice(productId, "RMB", "浅色")],
    ["中色价", standardPrice(productId, "RMB", "medium") || standardPrice(productId, "RMB", "中色")],
    ["深色价", standardPrice(productId, "RMB", "dark") || standardPrice(productId, "RMB", "深色")]
  ].map(([name, price]) => detailItem(name, priceDisplay(price))).join("");

  $("#detailTitle").textContent = productTitle(product);
  $("#detailContent").innerHTML = `
    <section class="detail-hero">
      <div><h3>${escapeHTML(productTitle(product))}</h3><p>${escapeHTML([product.manufacturer, product.product_category, product.product_name].filter(Boolean).join(" · ") || "—")}</p></div>
      <div class="detail-photo product-image" id="detailImage">${product.image_filename ? "加载中" : "暂无图片"}</div>
    </section>
    <section class="detail-section"><h3>当前价格</h3><div class="detail-grid">${latestPrices || '<p class="muted">暂无价格</p>'}</div></section>
    ${detailSection("基础信息", basicItems)}
    ${compositionSplitHTML}
    ${detailSection("规格", compositionItems)}
    ${detailSection("商务条件", businessItems)}
    ${detailSection("工艺与用途", processItems)}
    ${customHTML ? `<section class="detail-section"><h3>自定义栏目</h3><div class="detail-grid">${customHTML}</div></section>` : ""}
    ${detailSection("补充资料", supplementaryItems)}
    <section class="detail-section"><h3>全部价格变动历史 · ${prices.length}</h3><div class="history-list">${priceRows(prices)}</div></section>
    <section class="detail-section"><h3>客户报价记录 · ${quotes.length}</h3><div class="history-list">${quotes.length ? quoteRows(quotes) : '<p class="muted">暂无记录</p>'}</div></section>`;
  $("#detailDialog").showModal();
  if (product.image_filename) loadImageInto($("#detailImage"), product.image_filename);
}

function renderMetadata() {
  const metadata = state.snapshot?.metadata;
  if (!metadata) {
    $("#metadataList").innerHTML = "<div><dt>状态</dt><dd>尚未导入</dd></div>";
  } else {
    $("#metadataList").innerHTML = [
      ["资料版本", displayDate(metadata.exportedAt)], ["Windows 导出时间", displayDate(metadata.exportedAt)],
      ["产品", `${metadata.productCount.toLocaleString()} 个`], ["价格历史", `${metadata.priceCount.toLocaleString()} 条`],
      ["客户报价", `${metadata.quotationCount.toLocaleString()} 份`], ["产品图片", `${metadata.imageCount.toLocaleString()} 张`],
      ["自定义栏目", `${metadata.customFieldCount.toLocaleString()} 项`]
    ].map(([name, value]) => `<div><dt>${escapeHTML(name)}</dt><dd>${escapeHTML(value)}</dd></div>`).join("");
  }
  hasPreviousSnapshot().then((hasPrevious) => $("#restorePrevious").classList.toggle("hidden", !hasPrevious));
}

async function applySnapshot(snapshot) {
  state.snapshot = snapshot;
  state.products = snapshot?.products || [];
  buildMaps(snapshot);
  populateFilters();
  const customers = [...new Set(state.quotationRows.map((row) => String(row.customer || "").trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, "zh-CN"));
  populateSelect($("#quotationCustomer"), customers, "全部客户");
  state.filtered = [...state.products];
  state.page = 1;
  state.filteredQuotations = [...state.quotationRows];
  state.quotationPage = 1;
  state.exhibitionFiltered = [...state.products];
  state.exhibitionPage = 1;
  state.exhibitionSelected.clear();
  renderMetadata();
  renderProducts();
  renderExhibition();
  renderDictionary();
  renderQuotationHistory();
}

function showPage(pageId) {
  $$(".page").forEach((page) => page.classList.toggle("active", page.id === pageId));
  $$(".tab-bar button").forEach((button) => button.classList.toggle("active", button.dataset.page === pageId));
  if (pageId === "exhibitionPage") renderExhibition();
  if (pageId === "dictionaryPage") renderDictionary();
  if (pageId === "quotationPage") renderQuotationHistory();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function showMessage(title, text) {
  $("#messageTitle").textContent = title;
  $("#messageText").textContent = text;
  $("#messageDialog").showModal();
}

async function chooseBackup(file) {
  if (!file) return;
  const progress = $("#importProgress");
  progress.classList.remove("hidden");
  try {
    const prepared = await prepareBackup(file, (message) => $("#importProgress p").textContent = message);
    state.pendingImport = prepared;
    const currentDate = state.snapshot?.metadata?.exportedAt;
    const rollback = currentDate && new Date(prepared.snapshot.metadata.exportedAt) < new Date(currentDate);
    const metadata = prepared.snapshot.metadata;
    $("#importPreview").innerHTML = `
      ${rollback ? '<p class="warning">这是较旧的资料版本，确认后会执行资料回退。</p>' : ""}
      <dl>
        <div><dt>文件</dt><dd>${escapeHTML(file.name)}</dd></div>
        <div><dt>导出时间</dt><dd>${escapeHTML(displayDate(metadata.exportedAt))}</dd></div>
        <div><dt>产品</dt><dd>${metadata.productCount.toLocaleString()} 个</dd></div>
        <div><dt>价格历史</dt><dd>${metadata.priceCount.toLocaleString()} 条</dd></div>
        <div><dt>客户报价</dt><dd>${metadata.quotationCount.toLocaleString()} 份</dd></div>
        <div><dt>产品图片</dt><dd>${metadata.imageCount.toLocaleString()} 张</dd></div>
        <div><dt>自定义栏目</dt><dd>${metadata.customFieldCount.toLocaleString()} 项</dd></div>
      </dl>`;
    $("#importDialog").showModal();
  } catch (error) {
    showMessage("无法导入资料", error.message || String(error));
  } finally {
    progress.classList.add("hidden");
    $("#backupFile").value = "";
  }
}

function bindEvents() {
  $("#exhibitionFilterForm").addEventListener("submit", (event) => { event.preventDefault(); applyExhibitionFilters(); });
  $("#resetExhibitionFilters").addEventListener("click", () => {
    $("#exhibitionFilterForm").reset();
    state.exhibitionFiltered = [...state.products];
    state.exhibitionPage = 1;
    renderExhibition();
  });
  $("#exhibitionPreviousPage").addEventListener("click", () => { state.exhibitionPage -= 1; renderExhibition(); window.scrollTo({ top: 0, behavior: "smooth" }); });
  $("#exhibitionNextPage").addEventListener("click", () => { state.exhibitionPage += 1; renderExhibition(); window.scrollTo({ top: 0, behavior: "smooth" }); });
  $("#exhibitionList").addEventListener("change", (event) => {
    const checkbox = event.target.closest("[data-select-product]");
    if (checkbox) toggleExhibitionProduct(checkbox.dataset.selectProduct, checkbox.checked);
  });
  $("#exhibitionList").addEventListener("click", (event) => {
    const detail = event.target.closest("[data-exhibition-detail]");
    if (detail) openProductDetail(detail.dataset.exhibitionDetail);
  });
  $("#selectExhibitionPage").addEventListener("change", (event) => {
    for (const product of currentExhibitionPageProducts()) {
      if (event.target.checked) state.exhibitionSelected.set(product.id, product);
      else state.exhibitionSelected.delete(product.id);
    }
    renderExhibition();
  });
  $("#selectedProducts").addEventListener("click", (event) => {
    const chip = event.target.closest("[data-remove-selected]");
    if (chip) toggleExhibitionProduct(chip.dataset.removeSelected, false);
  });
  $("#clearSelection").addEventListener("click", () => { state.exhibitionSelected.clear(); renderExhibition(); });
  $("#exportSelection").addEventListener("click", exportExhibitionSelection);
  $("#filterForm").addEventListener("submit", (event) => { event.preventDefault(); filterProducts(); });
  $("#resetFilters").addEventListener("click", () => {
    $("#filterForm").reset();
    state.filtered = [...state.products];
    state.page = 1;
    renderProducts();
  });
  $("#previousPage").addEventListener("click", () => { state.page -= 1; renderProducts(); window.scrollTo({ top: 0, behavior: "smooth" }); });
  $("#nextPage").addEventListener("click", () => { state.page += 1; renderProducts(); window.scrollTo({ top: 0, behavior: "smooth" }); });
  $("#productList").addEventListener("click", (event) => {
    const card = event.target.closest("[data-product-id]");
    if (card) openProductDetail(card.dataset.productId);
  });
  $("#dictionaryKeyword").addEventListener("input", renderDictionary);
  $("#quotationFilterForm").addEventListener("submit", (event) => {
    event.preventDefault();
    applyQuotationFilters();
  });
  $("#resetQuotationFilters").addEventListener("click", () => {
    $("#quotationFilterForm").reset();
    state.filteredQuotations = [...state.quotationRows];
    state.quotationPage = 1;
    renderQuotationHistory();
  });
  $("#quotationPreviousPage").addEventListener("click", () => {
    state.quotationPage -= 1;
    renderQuotationHistory();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  $("#quotationNextPage").addEventListener("click", () => {
    state.quotationPage += 1;
    renderQuotationHistory();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  $("#quotationList").addEventListener("click", (event) => {
    const card = event.target.closest("[data-quotation-product]");
    if (card) openProductDetail(card.dataset.quotationProduct);
  });
  $$(".tab-bar button").forEach((button) => button.addEventListener("click", () => showPage(button.dataset.page)));
  $$('[data-open-data]').forEach((button) => button.addEventListener("click", () => showPage("dataPage")));
  $$(".dialog-close").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
  $("#chooseBackup").addEventListener("click", () => $("#backupFile").click());
  $("#backupFile").addEventListener("change", () => chooseBackup($("#backupFile").files[0]));
  $("#confirmImport").addEventListener("click", async () => {
    if (!state.pendingImport) return;
    $("#confirmImport").disabled = true;
    try {
      await saveSnapshot(state.pendingImport.snapshot, state.pendingImport.images);
      await requestPersistentStorage();
      await applySnapshot(await getCurrentSnapshot());
      state.pendingImport = null;
      $("#importDialog").close();
      showMessage("资料更新完成", "新资料已经保存在这台 iPhone，本程序断网后仍可查询。\n后续更新网页程序不会覆盖已导入的资料。");
    } catch (error) {
      showMessage("资料保存失败", `${error.message || error}\n当前资料没有被改变。`);
    } finally {
      $("#confirmImport").disabled = false;
    }
  });
  $("#restorePrevious").addEventListener("click", async () => {
    if (!confirm("确定恢复上一版手机资料吗？当前版本会保留为可再次恢复的版本。")) return;
    try {
      await applySnapshot(await restorePreviousSnapshot());
      showMessage("已恢复上一版资料", "产品查询已经切换到上一版资料。");
    } catch (error) { showMessage("恢复失败", error.message || String(error)); }
  });
  $("#installHelpButton").addEventListener("click", () => showMessage("安装到 iPhone", "请用 Safari 打开本页面，点击“分享”，选择“添加到主屏幕”，并开启“作为网页 App 打开”。安装后没有7天时间限制。"));
  window.addEventListener("online", updateConnectionStatus);
  window.addEventListener("offline", updateConnectionStatus);
}

function updateConnectionStatus() {
  $("#connectionStatus").textContent = navigator.onLine ? "资料保存在本机 · 可离线使用" : "当前离线 · 本机资料可用";
}

async function initialize() {
  bindEvents();
  updateConnectionStatus();
  await applySnapshot(await getCurrentSnapshot());
  if ("serviceWorker" in navigator) {
    try { await navigator.serviceWorker.register("./service-worker.js"); } catch (error) { console.warn("Service Worker registration failed", error); }
  }
}

initialize().catch((error) => showMessage("启动失败", error.message || String(error)));
