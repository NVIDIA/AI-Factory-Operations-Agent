// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {renderTeamsMessages} from './format.mjs';

test('report headings, bold, code and all table cells become readable HTML',()=>{
  const input='## 调查报告\n\n**证据**\n\n| 时间 | 操作 | 结果 |\n|---|---|---|\n| 07:53 | `cat a \\| b` | 全部正常 |\n| 07:54 | 下一项 | 0 |\n\n```sh\necho "<GPU>"\nnext command\n```\n- 建议';
  const html=renderTeamsMessages(input).map(p=>p.content).join('');
  for(const t of ['调查报告','证据','时间','操作','结果','07:53','07:54','全部正常','下一项','next command','建议'])assert.ok(html.includes(t),t);
  assert.match(html,/<p><strong>调查报告<\/strong><\/p>/);
  assert.match(html,/<code>cat a \| b<\/code>/);assert.match(html,/<pre><code>echo &quot;&lt;GPU&gt;&quot;\nnext command/);
  assert.doesNotMatch(html,/\|---|## |\*\*证据/);
});
test('model HTML and unsafe URLs are not executable',()=>{
  const html=renderTeamsMessages('<script>alert(1)</script>\n[x](javascript:alert)\n[ok](https://example.com/?a=1&b=2)\n`**literal**`')[0].content;
  assert.ok(!html.includes('<script>'));assert.ok(!html.includes('href="javascript:'));
  assert.match(html,/href="https:\/\/example.com\/\?a=1&amp;b=2"/);
  assert.match(html,/<code>\*\*literal\*\*<\/code>/);
});
test('long Unicode reports split after rendering without broken tags or lost data',()=>{
  const payload='中😀&<>'.repeat(2000),parts=renderTeamsMessages('```\n'+payload+'\n```',1000);
  assert.ok(parts.length>1);assert.ok(parts.every(x=>Buffer.byteLength(x.content)<=1000));
  const decoded=parts.map(p=>p.content.replace(/<p><strong>Report \(\d+\/\d+\)<\/strong><\/p>/,'').replace(/<pre><code>|<\/code><\/pre>/g,'').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&')).join('');
  assert.equal(decoded,payload);assert.ok(parts.every(p=>p.content.endsWith('</code></pre>')));
});
