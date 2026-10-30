import { statSync } from "node:fs";
import ExcelJS from "exceljs";
import type { Catalog, CatalogItem } from "./catalog.js";

// Reads the price list from an Excel file: every sheet that has an item name column, or one named sheet.
// Column names are recognised in the first rows, e.g. "Part Number", "Description", "Customer Price", "Qty".
// A sheet named after a brand (e.g. "OPTERNA") gives that brand to rows without a Brand column.
// The file is read again whenever it changes on disk.

type Field = Exclude<keyof CatalogItem, "zohoItemId">;

// Each field lists column names in order of preference; on each row the first one with a value is used.
const COLUMNS: Record<Field, string[]> = {
  sku: ["sku", "item code", "code", "product code", "part number", "part no", "item no"],
  name: ["name", "item name", "description", "item", "product name", "product", "material"],
  brand: ["brand", "make", "manufacturer", "brand name"],
  category: ["category", "item group", "group", "type", "product category"],
  unit: ["unit", "uom", "units"],
  price: ["customer price", "selling price", "sale price", "sales price", "price", "unit price", "mrp", "final price", "rate"],
  resellerPrice: ["reseller price", "dealer price", "trade price", "wholesale price"],
  cost: ["cost", "cost price", "purchase price", "buying price", "purchase rate", "last purchase", "last purchase price"],
  stock: ["available qty", "available quantity", "stock", "qty", "quantity", "available", "stock on hand", "in stock", "balance", "stock qty"],
  marginCustomer: ["margin customer", "customer margin", "margin", "margin %", "margin%"],
  marginReseller: ["margin re seller", "margin reseller", "reseller margin", "margin re-seller"],
  remark: ["remark", "remarks", "note", "notes", "moq"],
};

/** Sheet names that are not brands. */
const GENERIC_SHEET = /^(sheet|page|data|prices?|price ?list|stock( ?list)?|items?|products?|inventory|catalog(ue)?)\s*\d*$/i;

function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (typeof value === "object") {
    if ("result" in value) return cellText(value.result as ExcelJS.CellValue);
    if ("richText" in value) return value.richText.map((part) => part.text).join("");
    if ("text" in value) return String(value.text);
  }
  return String(value).trim();
}

function cellNumber(value: ExcelJS.CellValue): number | null {
  const text = cellText(value).replace(/[^0-9.-]/g, "");
  if (text === "") return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

/** Margins written as fractions (0.5) become percents (50); numbers of 5 and over are percents already. */
function percent(value: number | null): number | null {
  if (value == null) return null;
  return value < 5 ? Math.round(value * 10000) / 100 : value;
}

/** Reads one sheet; returns null when none of its first 10 rows has an item name column. */
function readSheet(sheet: ExcelJS.Worksheet, skuPrefix: string): CatalogItem[] | null {
  for (let headerRow = 1; headerRow <= Math.min(10, sheet.rowCount); headerRow++) {
    const titles = new Map<string, number>();
    sheet.getRow(headerRow).eachCell((cell, column) => {
      const title = cellText(cell.value).toLowerCase();
      if (title && !titles.has(title)) titles.set(title, column);
    });
    const columns = {} as Record<Field, number[]>;
    for (const [field, names] of Object.entries(COLUMNS) as [Field, string[]][]) {
      columns[field] = names.map((name) => titles.get(name)).filter((c): c is number => c !== undefined);
    }
    if (columns.name.length === 0) continue;

    const sheetBrand = GENERIC_SHEET.test(sheet.name.trim()) ? null : sheet.name.trim();
    const items: CatalogItem[] = [];
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber <= headerRow) return;
      const read = (field: Field): ExcelJS.CellValue => {
        for (const column of columns[field]) {
          const value = row.getCell(column).value;
          if (cellText(value) !== "") return value;
        }
        return null;
      };
      const name = cellText(read("name"));
      if (!name) return;
      items.push({
        sku: cellText(read("sku")) || `${skuPrefix}ROW-${rowNumber}`,
        name,
        category: cellText(read("category")) || null,
        brand: cellText(read("brand")) || sheetBrand,
        unit: cellText(read("unit")) || null,
        price: cellNumber(read("price")),
        resellerPrice: cellNumber(read("resellerPrice")),
        cost: cellNumber(read("cost")),
        stock: cellNumber(read("stock")),
        marginCustomer: percent(cellNumber(read("marginCustomer"))),
        marginReseller: percent(cellNumber(read("marginReseller"))),
        remark: cellText(read("remark")) || null,
      });
    });
    return items;
  }
  return null;
}

export async function readExcelCatalog(path: string, sheetName = ""): Promise<CatalogItem[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  const sheets = sheetName ? [workbook.getWorksheet(sheetName)] : workbook.worksheets;
  if (sheetName && !sheets[0]) throw new Error(`Sheet "${sheetName}" not found in ${path}`);

  const items: CatalogItem[] = [];
  for (const sheet of sheets) {
    const found = readSheet(sheet!, workbook.worksheets.length > 1 ? `${sheet!.name}-` : "");
    if (found) items.push(...found);
  }
  if (items.length === 0) {
    throw new Error(`${path}: no sheet has an item name column. Name a column "Name", "Item Name" or "Description".`);
  }
  return items;
}

export class ExcelCatalog implements Catalog {
  private cache: CatalogItem[] = [];
  private loadedMtime = 0;

  constructor(
    private readonly path: string,
    private readonly sheet = "",
  ) {}

  async items(): Promise<CatalogItem[]> {
    const mtime = statSync(this.path).mtimeMs;
    if (mtime !== this.loadedMtime) {
      this.cache = await readExcelCatalog(this.path, this.sheet);
      this.loadedMtime = mtime;
    }
    return this.cache;
  }
}
