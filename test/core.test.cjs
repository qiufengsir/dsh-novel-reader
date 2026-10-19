const { test } = require("node:test");
const assert = require("node:assert/strict");
const C = require("../src/core.cjs");
test("UTF8 BOM and CRLF normalization", () => {
  assert.deepEqual(C.decode(Buffer.from("\uFEFF第一章 春\r\n正文")), {
    text: "第一章 春\n正文",
    encoding: "utf-8",
  });
});
test("GBK automatic fallback", () => {
  assert.equal(
    C.decode(Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4]).buffer).text,
    "中文",
  );
});
test("UTF16 BOMs", () => {
  assert.equal(
    C.decode(Buffer.from([0xff, 0xfe, 0x2d, 0x4e, 0x87, 0x65])).text,
    "中文",
  );
  assert.equal(
    C.decode(Buffer.from([0xfe, 0xff, 0x4e, 0x2d, 0x65, 0x87])).text,
    "中文",
  );
});
test("reject binary", () => {
  assert.throws(() => C.decode(Buffer.from([0, 1, 0, 2])));
});
test("Chinese and English chapter boundaries preserve preface", () => {
  const t = "说明\n第一章 春天\n正文\n第2章 雨\n文字\nChapter 3 Dawn\nend";
  assert.deepEqual(
    C.chapters(t).map((x) => [x.start, x.end]),
    [
      [0, 1],
      [1, 3],
      [3, 5],
      [5, 7],
    ],
  );
});
test("unstructured long text splits into bounded sections", () => {
  const c = C.chapters(Array(501).fill("正文").join("\n"));
  assert.equal(c.length, 3);
  assert.equal(c[2].end, 501);
});
test("search literal special characters and cap", () => {
  assert.equal(C.search(["<script>", "abc.*", "ABC.*"], ".*").length, 2);
  assert.equal(C.search(Array(500).fill("a"), "a").length, 200);
  assert.equal(C.search(["abc"], "  ").length, 0);
});
test("narrative references and chapter-like words do not split prose", () => {
  const text = ['第一章 起程', '第一段', '尾声仍在回荡。', '番外的故事还没完。', '第一章的结尾，他转过身。', '第一卷的名字，是明月在天。', '第二段', '第二章 重逢', '最后一段'].join('\n');
  assert.deepEqual(C.chapters(text).map(c => c.title), ['第一章 起程', '第二章 重逢']);
});
test("legitimate compact, punctuated, bracketed and fullwidth headings remain chapters", () => {
  const titles = ['第一百六十三章三里闻臭，万国传名', '第35章 时间不等人，好景难留住。', '【第二卷·终】', '正文 第１２章 重逢', '番外·除夕（平等国篇）', '番外预告', '后记（完本感言）', 'Chapter IV — Return'];
  const text = titles.map(t => t+'\n这里是正文。').join('\n');
  assert.deepEqual(C.chapters(text).map(c => c.title), titles);
});
test("chapter ranges reconstruct every original line including preface, whitespace and ending", () => {
  for (const text of ['', '前言\n正文\n\n第一章 雨\n\n尾声仍在回荡。\n第二章 晴\n末尾不应丢失\n', '原文导语\n第一章 起\n第二章 终\n最后一段', Array.from({length:541},(_,i)=>'段落 '+i).join('\n')]) {
    const lines = text.split('\n'), chapters = C.chapters(text);
    let next=0; const reconstructed=[];
    for(const chapter of chapters){assert.equal(chapter.start,next);assert.ok(chapter.end>chapter.start);reconstructed.push(...lines.slice(chapter.start,chapter.end));next=chapter.end;}
    assert.equal(next,lines.length);assert.equal(reconstructed.join('\n'),text);
    for(const chapter of chapters) if(chapter.heading) assert.equal(chapter.title,lines[chapter.start].trim());
  }
});
