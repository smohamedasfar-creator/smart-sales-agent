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
    expect(items).toEqual([
      { sku: "PVC-110", name: 'PVC Pipe 4"', category: "Pipes", unit: "pcs", price: 12.5, cost: 9, stock: 200 },
      { sku: "ROW-4", name: "Tape", category: null, unit: null, price: 2.5, cost: null, stock: null },
    ]);
  });
});
