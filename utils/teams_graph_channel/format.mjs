// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Graph v1.0 accepts text/HTML, not Bot Framework textFormat or Markdown.
// Render a conservative Markdown subset. Raw HTML is always escaped.
export const escapeHtml = s => String(s).replace(/[&<>"']/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);

function inline(s) {
  const tokens = [];
  const token = html => `\u0000${tokens.push(html)-1}\u0000`;
  // Remove token delimiters from untrusted input before introducing our own.
  s = s.replace(/\u0000/g, '\ufffd');
  s = s.replace(/`([^`\n]+)`/g, (_, code) => token(`<code>${escapeHtml(code)}</code>`));
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, href) => {
    try {
      const u = new URL(href);
      if (u.username || u.password) return `${label} (${href})`;
      return token(`<a href="${escapeHtml(u.href)}">${escapeHtml(label)}</a>`);
    } catch { return `${label} (${href})`; }
  });
  s = escapeHtml(s).replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, n) => tokens[Number(n)]);
}

function cells(line) {
  line = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const result = []; let cell = '', code = false;
  for (let i=0; i<line.length; i++) {
    const c = line[i];
    if (c === '\\' && line[i+1] === '|') { cell += '|'; i++; continue; }
    if (c === '`') code = !code;
    if (c === '|' && !code) { result.push(cell.trim()); cell=''; }
    else cell += c;
  }
  result.push(cell.trim()); return result;
}

function blocks(markdown) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n'), result = [];
  const add = (html, plain, code=false) => result.push({html, plain, code});
  for (let i=0; i<lines.length;) {
    const line=lines[i];
    if (!line.trim()) { i++; continue; }
    const fence=line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fence) {
      const content=[]; i++;
      while (i<lines.length && !lines[i].trim().startsWith(fence[1])) content.push(lines[i++]);
      if (i<lines.length) i++;
      const plain=content.join('\n');
      add(`<pre><code>${escapeHtml(plain)}</code></pre>`,plain,true); continue;
    }
    if (i+1<lines.length && line.includes('|')) {
      const heads=cells(line), separators=cells(lines[i+1]);
      if (heads.length===separators.length && separators.every(x=>/^:?-{3,}:?$/.test(x))) {
        // Label/value records remain readable on narrow Teams clients. Every
        // row and column is retained, including empty cells and extra columns.
        i+=2; let count=0;
        while(i<lines.length && lines[i].includes('|') && lines[i].trim()) {
          const values=cells(lines[i++]), labels=values.map((_,j)=>heads[j] || `Column ${j+1}`);
          while(values.length<heads.length) {labels.push(heads[values.length]);values.push('');}
          add(`<p>${values.map((v,j)=>`<strong>${inline(labels[j])}:</strong> ${inline(v)}`).join('<br>')}</p>`,
            values.map((v,j)=>`${labels[j]}: ${v}`).join('\n'));
          count++;
        }
        if (!count) add(`<p>${heads.map(inline).join(' | ')}</p>`,heads.join(' | '));
        continue;
      }
    }
    const heading=line.match(/^\s*#{1,6}\s+(.+?)\s*#*$/);
    if (heading) {add(`<p><strong>${inline(heading[1])}</strong></p>`,heading[1]);i++;continue;}
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {add('<hr>','');i++;continue;}
    const bullet=line.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) {add(`<p>• ${inline(bullet[1])}</p>`,`• ${bullet[1]}`);i++;continue;}
    const ordered=line.match(/^\s*(\d+[.)])\s+(.*)$/);
    if (ordered) {add(`<p>${ordered[1]} ${inline(ordered[2])}</p>`,`${ordered[1]} ${ordered[2]}`);i++;continue;}
    add(`<p>${inline(line)}</p>`,line);i++;
  }
  return result;
}

function bounded(block, maxBytes) {
  if (Buffer.byteLength(block.html)<=maxBytes) return [block.html];
  // Oversized individual blocks become escaped text split at Unicode boundaries.
  // This may simplify inline styling, but never truncates a cell or code line.
  const open=block.code?'<pre><code>':'<p>',close=block.code?'</code></pre>':'</p>';
  const available=maxBytes-Buffer.byteLength(open+close), output=[];
  let part='', size=0;
  for (const ch of block.plain) {
    const escaped=ch==='\n'&&!block.code?'<br>':escapeHtml(ch), n=Buffer.byteLength(escaped);
    if(size+n>available){output.push(open+part+close);part='';size=0;}
    part+=escaped;size+=n;
  }
  if(part)output.push(open+part+close);
  return output;
}

export function renderTeamsMessages(markdown,maxBytes=18000) {
  if (!Number.isInteger(maxBytes)||maxBytes<256) throw new Error('invalid_message_limit');
  const limit=maxBytes-128, parts=[];let part='';
  for (const block of blocks(String(markdown))) {
    for(const html of bounded(block,limit)) {
      if(Buffer.byteLength(part+html)>limit){parts.push(part);part='';}
      part+=html;
    }
  }
  if(part)parts.push(part);
  return parts.map((content,i)=>({contentType:'html',content:
    (parts.length>1?`<p><strong>Report (${i+1}/${parts.length})</strong></p>`:'')+content}));
}
