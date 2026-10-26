#!/usr/bin/env node
'use strict';
/* 构建题库名录：扫描 data/q*.js，生成
 *  - data/manifest.json  [{code,name,type,file}]（服务端每日一题选题用）
 *  - data/manifest.js    window.QFILES = [{file,n}]（前端懒加载清单）
 */
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, 'data');

const files = fs.readdirSync(DIR).filter(f => /^q\d+\.js$/.test(f))
  .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));

const entries = [];
const qfiles = [];
for (const f of files) {
  const src = fs.readFileSync(path.join(DIR, f), 'utf8');
  const metas = [];
  const re = /"code":"([^"]+)","name":"([^"]+)","type":"([^"]+)"/g;
  let m;
  while ((m = re.exec(src))) metas.push({ code: m[1], name: m[2], type: m[3] });
  if (!metas.length) { console.error('WARN: 未解析到题目', f); continue; }
  qfiles.push({ file: f, n: metas.length });
  for (const q of metas) entries.push({ code: q.code, name: q.name, type: q.type, file: f });
}

fs.writeFileSync(path.join(DIR, 'manifest.json'), JSON.stringify(entries));
fs.writeFileSync(path.join(DIR, 'manifest.js'),
  'window.QFILES = ' + JSON.stringify(qfiles) + ';\n' +
  'window.QMANIFEST = ' + JSON.stringify(entries.map(e => ({ code: e.code, file: e.file }))) + ';\n');
console.log(`OK: ${files.length} 个数据文件, ${entries.length} 道题`);
