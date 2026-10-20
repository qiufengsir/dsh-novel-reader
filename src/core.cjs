(function (root) {
  "use strict";
  function decode(buffer, encoding = "auto") {
    const bytes = new Uint8Array(buffer);
    let label = encoding;
    if (label === "auto") {
      if (bytes[0] === 255 && bytes[1] === 254) label = "utf-16le";
      else if (bytes[0] === 254 && bytes[1] === 255) label = "utf-16be";
      else {
        try {
          const text = clean(
            new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          );
          if (text.includes("\u0000")) throw Error("binary");
          return { text, encoding: "utf-8" };
        } catch {
          label = "gb18030";
        }
      }
    }
    const text = clean(new TextDecoder(label, { fatal: true }).decode(bytes));
    if (text.includes("\u0000"))
      throw Error("文件包含二进制数据，或编码选择不正确。");
    return { text, encoding: label };
  }
  function clean(text) {
    return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  }
  // Recognize standalone headings; ordinary prose beginning with 后记/番外 etc.
  // must stay in its chapter. Source line indexes always refer to the original text.
  function chapterHeading(source) {
    let title = source.trim().normalize("NFKC");
    if (!title || title.length > 90) return false;
    title = title.replace(/^正文[\s:：]+/u, "");
    const bracketed = title.match(/^[【\[]([^】\]]+)[】\]]\s*(.*)$/u);
    if (bracketed) title = bracketed[1] + (bracketed[2] ? " " + bracketed[2] : "");
    const numbered = title.match(/^(第[零〇一二三四五六七八九十百千万两壹贰叁肆伍陆柒捌玖拾佰仟\d]+[章回节卷部篇集])(.*)$/u);
    if (numbered) {
      const tail = numbered[2];
      if (!tail) return true;
      // Explicitly separated chapter names may contain expressive punctuation.
      if (/^[\s:：、.．·]/u.test(tail)) return tail.trim().length <= 64;
      return tail.length <= 45 && !/^(?:的|里|是|最后|已经|之后|之前|卷末|开卷后|流下|中[，,。])/u.test(tail);
    }
    if (/^(?:chapter|book|part)\s+(?:\d+|[ivxlcdm]+)(?:\s|[.:：—-]|$)/i.test(title))
      return !/[。；;]/u.test(title);
    return /^(?:序章|序言|楔子|引子|前言|后记|尾声|终章|番外)(?:$|[\s:：、—·-]+[^。；;]{1,60}$|[（(][^）)]{1,60}[）)]$)/u.test(title) || /^番外(?:预告|[零〇一二三四五六七八九十\d]+(?:[\s:：、·-].{1,50})?)$/u.test(title);
  }
  function chapters(text) {
    const lines = text.split("\n"), out = [];
    lines.forEach((line, i) => {
      if (chapterHeading(line)) out.push({ title: line.trim(), start: i, heading: true });
    });
    if (!out.length) {
      for (let i = 0; i < lines.length; i += 180)
        out.push({ title: i === 0 ? "正文" : `正文 · ${out.length + 1}`, start: i, heading: false });
    } else if (out[0].start > 0) out.unshift({ title: "卷首", start: 0, heading: false });
    return out.map((c, i) => ({ ...c, end: out[i + 1]?.start ?? lines.length }));
  }
  function search(lines, query, limit = 200) {
    const q = query.trim().toLocaleLowerCase();
    if (!q) return [];
    const out = [];
    for (let i = 0; i < lines.length && out.length < limit; i++)
      if (lines[i].toLocaleLowerCase().includes(q))
        out.push({ line: i, text: lines[i] });
    return out;
  }
  const api = { decode, chapters, search };
  if (typeof module !== "undefined") module.exports = api;
  else root.ZhijianReaderCore = api;
})(globalThis);
