import { statSync } from "node:fs";
import ExcelJS from "exceljs";
import type { Catalog, CatalogItem } from "./catalog.js";

// Reads the price list from an Excel file. The first row holds the column names;
// common names are recognised, e.g. "Item Code", "Description", "Selling Price", "Qty".
// The file is read again whenever it changes on disk.

const COLUMNS: Record<keyof Omit<CatalogItem, "zohoItemId">, string[]> = {
  sku: ["sku", "code", "item code", "product code", "part no", "part number", "item no"],
  name: ["name", "item", "item name", "description", "product", "product name", "material"],
  category: ["category", "group", "item group", "type", "brand"],
  unit: ["unit", "uom", "units"],
  price: ["price", "selling price", "sale price", "rate", "unit price", "sales price", "mrp"],
  cost: ["cost", "cost price", "purchase price", "buying price", "purchase rate"],
  stock: ["stock", "qty", "quantity", "available", "stock on hand", "in stock", "balance", "stock qty"],
};

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

export async function readExcelCatalog(path: string, sheetName = ""): Promise<CatalogItem[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  const sheet = sheetName ? workbook.getWorksheet(sheetName) : workbook.worksheets[0];
  if (!sheet) throw new Error(`Sheet "${sheetName}" not found in ${path}`);

  const header = sheet.getRow(1);
  const columnOf: Partial<Record<keyof typeof COLUMNS, number>> = {};
  header.eachCell((cell, column) => {
    const title = cellText(cell.value).toLowerCase();
    for (const [field, names] of Object.entries(COLUMNS) as [keyof typeof COLUMNS, string[]][]) {
      if (columnOf[field] === undefined && names.includes(title)) columnOf[field] = column;
    }
  });
  if (columnOf.name === undefined) {
    throw new Error(`${path}: no item name column found. Name a column "Item Name" or "Description".`);
  }

  const items: CatalogItem[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const read = (field: keyof typeof COLUMNS) =>
      columnOf[field] === undefined ? null : row.getCell(columnOf[field]).value;
    const name = cellText(read("name"));
    if (!name) return;
    items.push({
      sku: cellText(read("sku")) || `ROW-${rowNumber}`,
      name,
      category: cellText(read("category")) || null,
      unit: cellText(read("unit")) || null,
      price: cellNumber(read("price")),
      cost: cellNumber(read("cost")),
      stock: cellNumber(read("stock")),
    });
  });
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
