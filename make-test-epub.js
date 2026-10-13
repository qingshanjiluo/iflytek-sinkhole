// 生成最小测试 EPUB(测试电子书预览端点用);用法: node make-test-epub.js [输出路径]
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const out = process.argv[2] || path.join(__dirname, 'storage', '测试电子书.epub');

const files = {
  'mimetype': 'application/epub+zip',
  'META-INF/container.xml':
    `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
 <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
  'OEBPS/content.opf':
    `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
 <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:title>测试电子书</dc:title><dc:identifier id="id">t1</dc:identifier><dc:language>zh</dc:language>
 </metadata>
 <manifest>
  <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
  <item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/>
 </manifest>
 <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>`,
  'OEBPS/c1.xhtml': `<?xml version="1.0" encoding="utf-8"?><html><body><h1>第一章</h1><p>中继站电子书预览测试内容,第一章正文。</p></body></html>`,
  'OEBPS/c2.xhtml': `<?xml version="1.0" encoding="utf-8"?><html><body><h1>第二章</h1><p>第二章正文:断点续传与网页中转。</p></body></html>`,
};

// 极简 ZIP(store/deflate 混合) —— mimetype 用 store,其余 deflate
const chunks = [];
const central = [];
let offset = 0;
const crcTable = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
for (const [name, text] of Object.entries(files)) {
  const nameBuf = Buffer.from(name, 'utf8');
  const data = Buffer.from(text, 'utf8');
  const store = name === 'mimetype';
  const comp = store ? data : zlib.deflateRawSync(data);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(store ? 0 : 8, 8);
  local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(comp.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  const rec = Buffer.alloc(46);
  rec.writeUInt32LE(0x02014b50, 0);
  rec.writeUInt16LE(20, 4); rec.writeUInt16LE(20, 6);
  rec.writeUInt16LE(0, 8);
  rec.writeUInt16LE(store ? 0 : 8, 10);
  rec.writeUInt16LE(0, 12); rec.writeUInt16LE(0, 14);
  rec.writeUInt32LE(crc, 16);
  rec.writeUInt32LE(comp.length, 20);
  rec.writeUInt32LE(data.length, 24);
  rec.writeUInt16LE(nameBuf.length, 28);
  rec.writeUInt16LE(0, 30); rec.writeUInt16LE(0, 32);
  rec.writeUInt16LE(0, 34); rec.writeUInt16LE(0, 36);
  rec.writeUInt32LE(0, 38);
  rec.writeUInt32LE(offset, 42);
  const localRec = Buffer.concat([local, nameBuf, comp]);
  chunks.push(localRec);
  central.push(Buffer.concat([rec, nameBuf]));
  offset += localRec.length;
}
const cdStart = offset;
const cdBuf = Buffer.concat(central);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(Object.keys(files).length, 8);
eocd.writeUInt16LE(Object.keys(files).length, 10);
eocd.writeUInt32LE(cdBuf.length, 12);
eocd.writeUInt32LE(cdStart, 16);
eocd.writeUInt16LE(0, 20);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.concat([...chunks, cdBuf, eocd]));
console.log('EPUB 已生成:', out, fs.statSync(out).size, 'B');
