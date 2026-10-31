import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { normalize, searchCatalog } from "../src/catalog/catalog.js";
import { ExcelCatalog } from "../src/catalog/excel.js";
import { CATALOG } from "./helpers.js";

describe("catalog search", () => {
  it("treats 4\", 4in and 4 inch the same", () => {
    expect(normalize('PVC 4" pipe')).toEqual(normalize("pvc 4in pipe"));
    expect(normalize("pvc 4 inch pipe")).toEqual(["pvc", "4inch", "pipe"]);
    expect(normalize("PVC Pipe 4\" (110mm) 6m")).toEqual(["pvc", "pipe", "4inch", "110mm", "6m"]);
  });

  it("puts the right size first", () => {
    expect(searchCatalog(CATALOG, "6 inch pvc pipe")[0].sku).toBe("PVC-160");
    expect(searchCatalog(CATALOG, "elbow 4\"")[0].sku).toBe("ELB-110");
  });

  it("returns nothing for unrelated products", () => {
    expect(searchCatalog(CATALOG, "copper cable")).toEqual([]);
  });
});

describe("Excel price list", () => {
  it("reads common column names and skips blank rows", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "catalog-")), "prices.xlsx");
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Prices");
    sheet.addRow(["Item Code", "Description", "Group", "UOM", "Selling Price", "Cost Price", "Qty"]);
    sheet.addRow(["PVC-110", 'PVC Pipe 4"', "Pipes", "pcs", 12.5, 9, 200]);
    sheet.addRow([]);
    sheet.addRow(["", "Tape", "", "", "AED 2.50", "", ""]);
    await workbook.xlsx.writeFile(path);

    const items = await new ExcelCatalog(path).items();
    expect(items).toMatchObject([
      { sku: "PVC-110", name: 'PVC Pipe 4"', category: "Pipes", brand: null, unit: "pcs", price: 12.5, cost: 9, stock: 200 },
      { sku: "ROW-4", name: "Tape", category: null, unit: null, price: 2.5, cost: null, stock: null },
    ]);
  });

  it("reads every brand sheet, with brands from a column or the sheet name, and skips notes", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "catalog-")), "stock.xlsx");
    const workbook = new ExcelJS.Workbook();
    // Like a supplier's stock list: a sheet named after its brand, with the header on the second row.
    const opterna = workbook.addWorksheet("OPTERNA");
    opterna.addRow([]);
    opterna.addRow(["CATEGORY", "CATEGORY 2", "Part Number", "Description", "UOM", "Remark", "Reseller Price", "Cost Price", "AVAILABLE QTY"]);
    opterna.addRow(["PIGTAIL", "OS2", "CALCU09", "OPTERNA OS2 LC/UPC Pigtail 1.5mtr", "EA", "MOQ,MPQ-10", 8, 6.9, 165]);
    const ugreen = workbook.addWorksheet("UGREEN");
    ugreen.addRow(["PRODUCT CATEGORY", "CATEGORY", "BRAND", "SKU", "PART NUMBER", "Name", "LAST PURCHASE", "MARGIN RE SELLER", "RESELLER PRICE", "MARGIN CUSTOMER", "CUSTOMER PRICE", "FINAL PRICE", "QTY"]);
    ugreen.addRow([null, "CABLE", "UGREEN", "UG-HD-1M", 10106, "UGREEN HDMI CABLE 1M", 9, 0.5, 13.5, 1, 18, 15.75, 7]);
    ugreen.addRow([null, "CABLE", "UGREEN", null, 10170, "UGREEN HDMI ROUND CABLE 10M", null, null, null, null, null, null, 1]);
    const notes = workbook.addWorksheet("NOTES");
    notes.addRow(["Note:-", "MINIMUM ORDER QUANTITY"]);
    await workbook.xlsx.writeFile(path);

    const items = await new ExcelCatalog(path).items();
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ sku: "CALCU09", brand: "OPTERNA", category: "PIGTAIL", unit: "EA", price: null, resellerPrice: 8, cost: 6.9, stock: 165, remark: "MOQ,MPQ-10" });
    expect(items[1]).toMatchObject({ sku: "UG-HD-1M", brand: "UGREEN", category: "CABLE", price: 18, resellerPrice: 13.5, cost: 9, stock: 7, marginCustomer: 100, marginReseller: 50 });
    // No SKU: the part number stands in.
    expect(items[2]).toMatchObject({ sku: "10170", name: "UGREEN HDMI ROUND CABLE 10M", stock: 1 });
  });
});
