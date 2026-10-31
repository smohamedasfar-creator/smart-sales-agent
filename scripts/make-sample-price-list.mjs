// Creates data/price-list.xlsx with a few example rows, to try the app before using your real price list.
import { mkdirSync } from "node:fs";
import ExcelJS from "exceljs";

const workbook = new ExcelJS.Workbook();
const sheet = workbook.addWorksheet("Price List");
sheet.addRow(["Item Code", "Item Name", "Category", "Unit", "Selling Price", "Cost Price", "Stock"]);
sheet.addRows([
  ["PVC-110", 'PVC Pipe 4" (110mm) 6m', "Pipes", "pcs", 12.5, 9, 200],
  ["PVC-160", 'PVC Pipe 6" (160mm) 6m', "Pipes", "pcs", 24, 18, 40],
  ["ELB-110", 'PVC Elbow 4" 90 degree', "Fittings", "pcs", 3.2, 2.1, 5],
  ["TEE-110", 'PVC Tee 4"', "Fittings", "pcs", 4.1, 2.8, 100],
  ["GV-050", 'Gate Valve Brass 2"', "Valves", "pcs", 65, 48, 12],
]);
sheet.columns.forEach((column) => (column.width = 24));
mkdirSync("data", { recursive: true });
await workbook.xlsx.writeFile("data/price-list.xlsx");
console.log("Created data/price-list.xlsx");
