import zlib from "node:zlib";

export function docxExcerpt(data: Buffer): string {
  const xml = zipEntry(data, "word/document.xml");
  if (!xml) return "";
  return decodeXml(
    xml
      .replace(/<w:tab\/>/g, "\t")
      .replace(/<w:br\/>/g, "\n")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function xlsxExcerpt(data: Buffer): string {
  const shared = readSharedStrings(zipEntry(data, "xl/sharedStrings.xml"));
  const blocks: string[] = [];
  for (let sheet = 1; sheet <= 3; sheet += 1) {
    const xml = zipEntry(data, `xl/worksheets/sheet${sheet}.xml`);
    if (!xml) continue;
    const rows = readSheetRows(xml, shared);
    if (rows.length) blocks.push(rows.join("\n"));
  }
  return blocks.join("\n\n").trim();
}

function readSharedStrings(xml: string): string[] {
  if (!xml) return [];
  const strings: string[] = [];
  for (const item of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    const texts = [...item[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((part) => decodeXml(part[1]));
    strings.push(texts.join(""));
  }
  return strings;
}

function readSheetRows(xml: string, shared: string[]): string[] {
  const rows: string[] = [];
  for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const cell of row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      cells.push(cellText(cell[1], cell[2], shared));
    }
    const line = cells.join(" | ").trim();
    if (line.replace(/\|/g, "").trim()) rows.push(line);
    if (rows.length >= 40) break;
  }
  return rows;
}

function cellText(attrs: string, body: string, shared: string[]): string {
  const type = /t="([^"]+)"/.exec(attrs)?.[1] ?? "";
  const value = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "";
  const inline = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((part) => decodeXml(part[1])).join("");
  if (type === "s") return shared[Number(value)] ?? "";
  if (inline) return inline;
  return decodeXml(value);
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_item, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}

export function zipEntry(data: Buffer, name: string): string {
  const bytes = zipBytes(data, name);
  return bytes ? bytes.toString("utf8") : "";
}

function zipBytes(data: Buffer, name: string): Buffer | null {
  const eocd = findEocd(data);
  if (eocd < 0) return null;
  const count = data.readUInt16LE(eocd + 10);
  const offset = data.readUInt32LE(eocd + 16);
  if (offset === 0xffffffff || offset >= data.length) return null;
  let cursor = offset;
  for (let index = 0; index < count && cursor + 46 <= data.length; index += 1) {
    if (data.readUInt32LE(cursor) !== 0x02014b50) return null;
    const method = data.readUInt16LE(cursor + 10);
    const compSize = data.readUInt32LE(cursor + 20);
    const nameLen = data.readUInt16LE(cursor + 28);
    const extraLen = data.readUInt16LE(cursor + 30);
    const commentLen = data.readUInt16LE(cursor + 32);
    const localOff = data.readUInt32LE(cursor + 42);
    const entryName = data.subarray(cursor + 46, cursor + 46 + nameLen).toString("utf8");
    if (entryName === name) return inflateLocal(data, localOff, method, compSize);
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function findEocd(data: Buffer): number {
  const min = Math.max(0, data.length - (22 + 65535));
  for (let index = data.length - 22; index >= min; index -= 1) {
    if (data.readUInt32LE(index) === 0x06054b50) return index;
  }
  return -1;
}

function inflateLocal(data: Buffer, localOff: number, method: number, compSize: number): Buffer | null {
  if (localOff < 0 || localOff + 30 > data.length || data.readUInt32LE(localOff) !== 0x04034b50) return null;
  const nameLen = data.readUInt16LE(localOff + 26);
  const extraLen = data.readUInt16LE(localOff + 28);
  const start = localOff + 30 + nameLen + extraLen;
  if (compSize < 0 || start + compSize > data.length) return null;
  const slice = data.subarray(start, start + compSize);
  if (method === 0) return Buffer.from(slice);
  if (method !== 8) return null;
  try {
    return zlib.inflateRawSync(slice);
  } catch {
    return null;
  }
}
