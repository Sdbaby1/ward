import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  ["indexHtml", "index.html"],
  ["stylesCss", "styles.css"],
  ["appJs", "app.js"],
  ["faviconSvg", "favicon.svg"]
];

const body = files
  .map(([name, file]) => {
    const text = readFileSync(path.join(root, "public", file), "utf8");
    return `export const ${name} = ${JSON.stringify(text)};\n`;
  })
  .join("\n");

writeFileSync(path.join(root, "src", "site-assets.ts"), body);
