function mountReader(root) {
  const C = globalThis.NovelReaderCore;
  let db,
    books = [],
    book,
    lines = [],
    toc = [],
    view = "shelf",
    query = "",
    disposed = false,
    write = Promise.resolve(),
    saveTimer,
    restoreFrame,
    restoring = false,
    renderRevision = 0,
    readingChapter = 0,
    scrubOrigin,
    chapterSlider,
    chapterLabel,
    bookLabel,
    returnButton;
  const jumpHistory = [];
  let settings = {
    theme: "paper",
    font: "serif",
    size: 18,
    leading: 1.9,
    encoding: "auto",
    background: "",
  };
  const el = (tag, attrs = {}, ...children) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith("on")) n.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === "text") n.textContent = v;
      else n.setAttribute(k, v);
    }
    for (const child of children.flat())
      if (child != null)
        n.append(
          child instanceof Node
            ? child
            : document.createTextNode(String(child)),
        );
    return n;
  };
  const button = (text, fn, attrs = {}) =>
    el("button", { type: "button", onClick: fn, ...attrs }, text);
  root.className = "nr";
  root.setAttribute("aria-label", "拾页 · 小说阅读器");
  const header = el(
    "header",
    {},
    el(
      "div",
      {},
      el("div", { class: "brand" }, "拾页 ", el("small", {}, "READER")),
      el("small", {}, "让故事，慢慢发生。"),
    ),
  );
  const input = el("input", {
    type: "file",
    accept: ".txt,.text,.md",
    multiple: "",
    hidden: "",
    onChange: (e) => {
      importFiles(e.target.files);
      e.target.value = "";
    },
  });
  header.append(
    button("＋ 导入", () => input.click(), { class: "primary" }),
    input,
  );
  const nav = el("nav", { "aria-label": "阅读器功能" }),
    notice = el("div", { class: "notice", role: "status", hidden: "" }),
    main = el("main", { tabindex: "0" }),
    footer = el("footer");
  root.append(header, nav, notice, main, footer);
  function message(text) {
    notice.replaceChildren(
      el("span", {}, text),
      button("关闭", () => (notice.hidden = true)),
    );
    notice.hidden = false;
  }
  function transaction(store, mode, action) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      let result;
      const r = action(tx.objectStore(store));
      if (r) r.onsuccess = () => (result = r.result);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || Error("存储操作已取消"));
    });
  }
  function persistBook() {
    if (!book || !db) return;
    const snapshot = structuredClone(book);
    write = write
      .catch(() => {})
      .then(() => transaction("books", "readwrite", (s) => s.put(snapshot)))
      .catch((e) => message("保存失败，请检查磁盘空间：" + e.message));
  }
  // Save small position records instead of rewriting a large novel while scrolling.
  function persistPosition() {
    if (!book || !db) return;
    const position = {
      kind: "reading-position", bookId: book.id, line: book.line || 0,
      offset: book.offset || 0, atTop: book.atTop === true, updated: book.updated,
    };
    write = write.catch(() => {}).then(() =>
      transaction("settings", "readwrite", (s) => s.put(position, "position:" + position.bookId)),
    ).catch((e) => message("阅读进度保存失败：" + e.message));
  }
  function persistSettings() {
    write = write
      .catch(() => {})
      .then(() =>
        transaction("settings", "readwrite", (s) =>
          s.put(settings, "preferences"),
        ),
      )
      .catch((e) => message("设置保存失败：" + e.message));
  }
  function appearance() {
    root.dataset.theme = settings.theme;
    root.style.setProperty(
      "--reader-font",
      settings.font === "sans"
        ? 'system-ui,"Microsoft YaHei",sans-serif'
        : '"Songti SC",SimSun,serif',
    );
    root.style.setProperty("--reader-size", settings.size + "px");
    root.style.setProperty("--reader-leading", settings.leading);
    if (settings.background)
      root.style.setProperty("--paper", settings.background);
    else root.style.removeProperty("--paper");
  }
  function checkpoint() {
    if (view !== "read" || !book || restoring) return;
    const paras = main.querySelectorAll("[data-line]");
    const top = main.getBoundingClientRect().top;
    let found;
    for (const p of paras) {
      if (p.getBoundingClientRect().bottom >= top) {
        found = p;
        break;
      }
    }
    found ??= paras[paras.length - 1];
    if (found) {
      book.line = Number(found.dataset.line);
      const rect = found.getBoundingClientRect();
      book.offset = Math.max(0, Math.min(1, (top - rect.top) / Math.max(1, rect.height)));
    }
    book.atTop = main.scrollTop <= 1;
    book.updated = Date.now();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persistPosition, 350);
    updateFooterValues();
  }
  main.addEventListener("scroll", checkpoint, { passive: true });
  function updateFooter() {
    footer.replaceChildren();
    chapterSlider = chapterLabel = bookLabel = returnButton = undefined;
    if (!book) {
      footer.append("本地书架 · 内容仅存于此设备");
      return;
    }
    bookLabel = el("span", { class: "reading-context" });
    returnButton = button("返回跳转前", () => {
      const previous = jumpHistory.pop();
      if (!previous || previous.bookId !== book.id) return;
      const { bookId, ...position } = previous;
      Object.assign(book, position);
      view = "read";
      persistPosition();
      render();
    }, { class: "return-position", "aria-label": "返回上次跳转前的阅读位置" });
    if (view === "read") {
      chapterLabel = el("span", { class: "chapter-progress-label" });
      chapterSlider = el("input", {
        type: "range", min: 0, max: 1000, step: 1,
        "aria-label": "本章阅读进度",
        onPointerdown: () => { scrubOrigin = capturePosition(); },
        onInput: (e) => {
          const targetValue = Number(e.target.value);
          scrubOrigin ??= capturePosition();
          main.scrollTop = targetValue / 1000 * Math.max(0, main.scrollHeight - main.clientHeight);
          checkpoint();
        },
        onChange: () => {
          rememberPosition(scrubOrigin);
          scrubOrigin = undefined;
          checkpoint();
          persistPosition();
        },
      });
      footer.append(el("div", { class: "chapter-progress" }, chapterLabel, chapterSlider));
    }
    footer.append(el("div", { class: "reading-summary" }, bookLabel, returnButton));
    updateFooterValues();
  }
  function updateFooterValues() {
    if (!book || !bookLabel) return;
    const index = view === "read" ? readingChapter : chapterAt(book.line || 0);
    bookLabel.textContent = `第 ${index + 1} / ${toc.length} 章 · 全书 ${Math.round((book.line || 0) / Math.max(1, lines.length - 1) * 100)}%`;
    returnButton.hidden = !jumpHistory.length;
    if (!chapterSlider) return;
    const distance = Math.max(0, main.scrollHeight - main.clientHeight);
    const percent = distance > 1 ? Math.round(main.scrollTop / distance * 100) : 100;
    chapterLabel.textContent = `本章 ${percent}%`;
    chapterSlider.value = String(distance > 1 ? Math.round(main.scrollTop / distance * 1000) : 1000);
    chapterSlider.disabled = restoring || distance <= 1;
    chapterSlider.setAttribute("aria-valuetext", `本章 ${percent}%`);
  }
  function capturePosition() {
    checkpoint();
    return book && { bookId: book.id, line: book.line || 0, offset: book.offset || 0, atTop: book.atTop === true };
  }
  function rememberPosition(position) {
    if (!position || position.bookId !== book?.id) return;
    jumpHistory.push(position);
    if (jumpHistory.length > 20) jumpHistory.shift();
    updateFooterValues();
  }
  function chapterAt(line) {
    return Math.max(
      0,
      toc.findIndex((c) => line >= c.start && line < c.end),
    );
  }
  function open(b) {
    if (book) persistPosition();
    if (book?.id !== b.id) jumpHistory.length = 0;
    book = b;
    book.updated = Date.now();
    lines = book.text.split("\n");
    toc = C.chapters(book.text);
    view = "read";
    persistPosition();
    render();
  }
  function jump(line) {
    if (!book) return;
    rememberPosition(capturePosition());
    book.line = Math.max(0, Math.min(lines.length - 1, line));
    book.offset = 0;
    book.atTop = book.line === toc[chapterAt(book.line)].start;
    view = "read";
    persistPosition();
    render();
  }
  function render() {
    if (disposed) return;
    cancelAnimationFrame(restoreFrame);
    const revision = ++renderRevision;
    restoring = view === "read" && !!book;
    scrubOrigin = undefined;
    appearance();
    nav.replaceChildren();
    for (const [id, title] of [
      ["shelf", "书架"],
      ["read", "阅读"],
      ["toc", "目录"],
      ["search", "搜索"],
      ["notes", "摘记"],
      ["settings", "外观"],
    ])
      nav.append(
        button(
          title,
          () => {
            checkpoint();
            view = id;
            render();
          },
          { "aria-pressed": String(view === id) },
        ),
      );
    main.replaceChildren();
    main.scrollTop = 0;
    if (view === "shelf") {
      main.append(
        el(
          "section",
          { class: "hero" },
          el("div", { class: "eyebrow" }, "YOUR PRIVATE LIBRARY"),
          el("h1", {}, "在字里行间，\n遇见另一个世界。"),
          el("p", { class: "muted" }, "导入一本好书，从上次停下的地方继续。"),
        ),
      );
      const filter = el("input", {
          type: "search",
          placeholder: "搜索书名…",
          "aria-label": "搜索书架",
        }),
        list = el("div");
      filter.addEventListener("input", () => shelfList(list, filter.value));
      main.append(filter, list);
      shelfList(list, "");
    } else if (view === "settings") {
      settingsView();
    } else if (!book) {
      main.append(
        el(
          "div",
          { class: "empty" },
          el("b", {}, "☷"),
          "先从书架选择一本书，或导入 TXT 文本。",
        ),
      );
    } else if (view === "read") {
      const index = chapterAt(book.line || 0),
        chapter = toc[index];
      readingChapter = index;
      const bar = el(
        "div",
        { class: "row" },
        el("small", {}, `第 ${index + 1} / ${toc.length} 章`),
        button("＋ 书签", () => addNote()),
        button("划线摘记", () => addNote(true)),
      );
      const article = el(
        "article",
        {},
        el("div", { class: "eyebrow" }, book.title),
        el("h2", chapter.heading ? { "data-line": chapter.start } : {},
          chapter.heading ? lines[chapter.start] : chapter.title),
      );
      main.append(bar, article);
      const fragment = document.createDocumentFragment();
      for (
        let i =
          chapter.start + (chapter.heading ? 1 : 0);
        i < chapter.end;
        i++
      ) {
        const p = el("p", {
          "data-line": i,
          class: book.notes.some((n) => n.line === i) ? "marked" : "",
        });
        const text = lines[i] || "\u00a0";
        if (
          query &&
          text.toLocaleLowerCase().includes(query.toLocaleLowerCase())
        ) {
          let offset = 0,
            at;
          const lower = text.toLocaleLowerCase(),
            q = query.toLocaleLowerCase();
          while ((at = lower.indexOf(q, offset)) >= 0) {
            p.append(
              text.slice(offset, at),
              el("mark", {}, text.slice(at, at + query.length)),
            );
            offset = at + query.length;
          }
          p.append(text.slice(offset));
        } else p.textContent = text;
        fragment.append(p);
      }
      article.append(fragment);
      const chapterText = lines.slice(chapter.start, chapter.end).join("\n");
      const raw = el("details", { class: "chapter-source" },
        el("summary", {}, "查看本章原文"));
      raw.addEventListener("toggle", () => {
        if (raw.open && !raw.querySelector("pre")) raw.append(el("pre", {}, chapterText));
      });
      main.append(el("section", { class: "chapter-end", "aria-label": "章节末尾导航" },
        el("p", { class: "muted" }, `本章完 · ${chapterText.length.toLocaleString()} 字符`),
        el("div", { class: "chapter-navigation" },
          button("‹ 上一章", () => jump(toc[index - 1].start), index === 0 ? { disabled: "" } : {}),
          button(index < toc.length - 1 ? "下一章 ›" : "已读至全书末尾",
            () => jump(toc[index + 1].start),
            index < toc.length - 1 ? { class: "primary" } : { disabled: "" })),
        index < toc.length - 1 ? el("small", {}, `接下来：${toc[index + 1].title}`) : null,
        raw));
      const target = book.line || 0;
      const offset = book.offset || 0;
      const atTop = book.atTop === true;
      restoreFrame = requestAnimationFrame(() => {
        if (revision !== renderRevision || disposed) return;
        const targetElement = main.querySelector(`[data-line="${target}"]`);
        if (!atTop && targetElement && (target > chapter.start || offset > 0)) {
          const rect = targetElement.getBoundingClientRect();
          main.scrollTop += rect.top - main.getBoundingClientRect().top + rect.height * offset;
        } else main.scrollTop = 0;
        restoreFrame = requestAnimationFrame(() => {
          if (revision !== renderRevision || disposed) return;
          restoring = false;
          updateFooterValues();
        });
      });
    } else if (view === "toc") {
      main.append(
        el("h2", {}, book.title),
        el("p", { class: "muted" }, `${toc.length} 个章节 · ${book.encoding}`),
      );
      toc.forEach((c, i) =>
        main.append(
          button(`${i + 1}. ${c.title}`, () => jump(c.start), {
            class: "listitem",
            "aria-current": i === chapterAt(book.line) ? "true" : "false",
          }),
        ),
      );
    } else if (view === "search") {
      const field = el("input", {
          type: "search",
          value: query,
          placeholder: "搜索正文（最多显示 200 条）",
          "aria-label": "搜索正文",
        }),
        results = el("div");
      let timer;
      const show = () => {
        query = field.value.trim();
        results.replaceChildren();
        const hits = C.search(lines, query);
        results.append(
          el(
            "p",
            { class: "muted" },
            query
              ? `${hits.length}${hits.length === 200 ? "+" : ""} 条结果`
              : "输入文字开始搜索",
          ),
        );
        for (const hit of hits)
          results.append(
            button(
              `${toc[chapterAt(hit.line)].title} · ${hit.text.slice(Math.max(0, hit.text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) - 30), Math.max(0, hit.text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) - 30) + 160)}`,
              () => jump(hit.line),
              { class: "listitem" },
            ),
          );
      };
      field.addEventListener("input", () => {
        clearTimeout(timer);
        timer = setTimeout(show, 200);
      });
      main.append(field, results);
      show();
    } else if (view === "notes") {
      main.append(el("h2", {}, "书签与摘记"));
      if (!book.notes.length)
        main.append(
          el(
            "p",
            { class: "empty" },
            "阅读时添加书签，或选中文字后点击「划线摘记」。",
          ),
        );
      for (const n of book.notes) {
        const card = el(
          "section",
          { class: "card" },
          el(
            "div",
            { class: "info" },
            button(toc[chapterAt(n.line)].title, () => jump(n.line), {
              class: "listitem",
            }),
            el("p", { class: "note" }, n.quote),
            el("p", { class: "muted note" }, n.note || "阅读书签"),
            el("small", {}, new Date(n.created).toLocaleString()),
          ),
        );
        card.append(
          button("删除", () => {
            book.notes = book.notes.filter((x) => x.id !== n.id);
            persistBook();
            render();
          }),
        );
        main.append(card);
      }
    }
    updateFooter();
  }
  function shelfList(list, filter) {
    list.replaceChildren();
    const shown = books
      .filter((b) =>
        b.title.toLocaleLowerCase().includes(filter.toLocaleLowerCase()),
      )
      .sort((a, b) => b.updated - a.updated);
    if (!shown.length)
      list.append(
        el(
          "div",
          { class: "empty" },
          el("b", {}, "▤"),
          books.length ? "没有匹配的书籍" : "书架还是空的",
          el("p", {}, "支持 TXT / TEXT / MD，可拖放多个文件。"),
        ),
      );
    for (const b of shown) {
      const percent = Math.round(
        ((b.line || 0) / Math.max(1, b.text.split("\n").length - 1)) * 100,
      );
      list.append(
        el(
          "section",
          { class: "card" },
          el(
            "div",
            { class: "cover", "aria-hidden": "true" },
            Array.from(b.title)[0],
          ),
          el(
            "div",
            { class: "info" },
            el("span", { class: "title" }, b.title),
            el(
              "small",
              {},
              `${percent}% · ${Math.round(b.text.length / 1000)} 千字 · ${b.encoding}`,
            ),
            el("progress", { value: percent, max: 100 }),
          ),
          button("继续", () => open(b)),
          button(
            "移除",
            () => {
              if (
                !confirm(
                  `从本地书架移除《${b.title}》及其摘记？原文件不会删除。`,
                )
              )
                return;
              clearTimeout(saveTimer);
              write = write
                .catch(() => {})
                .then(() =>
                  transaction("books", "readwrite", (s) => s.delete(b.id)),
                )
                .then(() => {
                  books = books.filter((x) => x.id !== b.id);
                  if (book?.id === b.id) {
                    book = undefined;
                    lines = [];
                    toc = [];
                  }
                  render();
                })
                .catch((e) => message(e.message));
            },
            { class: "danger" },
          ),
        ),
      );
    }
  }
  function addNote(selection = false) {
    const selected = window.getSelection();
    let quote = "",
      line = book.line || 0;
    if (selection) {
      if (
        !selected ||
        !main.querySelector("article")?.contains(selected.anchorNode) ||
        !main.querySelector("article")?.contains(selected.focusNode) ||
        !selected.toString().trim()
      ) {
        message("请先选中正文中的文字。");
        return;
      }
      quote = selected.toString().slice(0, 10000);
      const anchor =
        selected.anchorNode.nodeType === 1
          ? selected.anchorNode
          : selected.anchorNode.parentElement;
      line = Number(anchor.closest("[data-line]")?.dataset.line ?? line);
    }
    view = "editor";
    render();
    const field = el("textarea", {
      rows: 5,
      maxlength: 5000,
      placeholder: "写下此刻的想法（可留空）",
      "aria-label": "摘记内容",
    });
    main.append(
      el("h2", {}, selection ? "划线摘记" : "添加书签"),
      el("p", { class: "note" }, quote || lines[line]?.slice(0, 200) || ""),
      field,
      el(
        "div",
        { class: "row" },
        button(
          "保存",
          () => {
            book.notes.push({
              id: crypto.randomUUID(),
              line,
              quote: quote || lines[line]?.slice(0, 200) || "",
              note: field.value,
              created: Date.now(),
            });
            persistBook();
            view = "read";
            render();
            message("已保存到摘记。");
          },
          { class: "primary" },
        ),
        button("取消", () => {
          view = "read";
          render();
        }),
      ),
    );
    field.focus();
  }
  function settingsView() {
    main.append(
      el("h2", {}, "让阅读更合心意"),
      el("p", { class: "muted" }, "设置自动保存，适用于整个本地书架。"),
    );
    const stack = el("div", { class: "stack" });
    main.append(stack);
    function select(label, key, options) {
      const s = el("select", {
        "aria-label": label,
        onChange: (e) => {
          settings[key] = e.target.value;
          if (key === "theme") settings.background = "";
          appearance();
          persistSettings();
        },
      });
      for (const [value, title] of options)
        s.append(
          el(
            "option",
            { value, ...(settings[key] === value ? { selected: "" } : {}) },
            title,
          ),
        );
      stack.append(el("label", {}, label, s));
    }
    select("主题", "theme", [
      ["paper", "暖纸"],
      ["white", "素白"],
      ["green", "青竹"],
      ["night", "夜读"],
    ]);
    select("字体", "font", [
      ["serif", "宋体 / 衬线"],
      ["sans", "黑体 / 无衬线"],
    ]);
    for (const [key, label, min, max, step] of [
      ["size", "字号", 12, 32, 1],
      ["leading", "行距", 1.3, 2.8, 0.1],
    ]) {
      const output = el("span", {}, settings[key]);
      const slider = el("input", {
        type: "range",
        min,
        max,
        step,
        value: settings[key],
        "aria-label": label,
        onInput: (e) => {
          settings[key] = Number(e.target.value);
          output.textContent = settings[key];
          appearance();
          persistSettings();
        },
      });
      stack.append(el("label", {}, label, slider, output));
    }
    stack.append(
      el(
        "label",
        {},
        "自定义底色",
        el("input", {
          type: "color",
          value: settings.background || "#f7f3e9",
          "aria-label": "自定义背景颜色",
          onInput: (e) => {
            settings.background = e.target.value;
            appearance();
            persistSettings();
          },
        }),
      ),
    );
    select("下次导入编码", "encoding", [
      ["auto", "自动（UTF / GB18030）"],
      ["utf-8", "UTF-8"],
      ["gb18030", "GB18030 / GBK"],
      ["big5", "繁体 Big5"],
      ["utf-16le", "UTF-16 LE"],
      ["utf-16be", "UTF-16 BE"],
    ]);
    stack.append(
      el(
        "small",
        {},
        "自动识别不能覆盖所有旧文本；乱码时请选择编码后重新导入。单文件须小于 50 MB。",
      ),
      button("恢复默认外观", () => {
        settings = {
          ...settings,
          theme: "paper",
          font: "serif",
          size: 18,
          leading: 1.9,
          background: "",
        };
        persistSettings();
        render();
      }),
      button("导出本书摘记", () => {
        if (!book) {
          message("请先选择一本书。");
          return;
        }
        const blob = new Blob(
            [JSON.stringify({ title: book.title, notes: book.notes }, null, 2)],
            { type: "application/json" },
          ),
          url = URL.createObjectURL(blob),
          a = el("a", { href: url, download: book.title + "-摘记.json" });
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }),
    );
  }
  let importing = false;
  async function importFiles(files) {
    if (importing || !db) {
      message("请等待存储初始化或当前导入完成。");
      return;
    }
    importing = true;
    let count = 0;
    const errors = [];
    for (const file of Array.from(files)) {
      try {
        if (!/\.(txt|text|md)$/i.test(file.name))
          throw Error("仅支持 TXT、TEXT、MD 文本");
        if (file.size >= 50 * 1024 * 1024) throw Error("文件须小于 50 MB");
        const buffer = await file.arrayBuffer(),
          decoded = C.decode(buffer, settings.encoding);
        if (!decoded.text.trim()) throw Error("文件为空");
        const hash = Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)),
        )
          .map((n) => n.toString(16).padStart(2, "0"))
          .join("");
        const existing = books.find((b) => b.id === hash);
        if (existing) {
          if (
            settings.encoding !== "auto" &&
            existing.encoding !== decoded.encoding
          ) {
            existing.text = decoded.text;
            existing.encoding = decoded.encoding;
            existing.line = Math.min(
              existing.line,
              decoded.text.split("\n").length - 1,
            );
            await transaction("books", "readwrite", (s) => s.put(existing));
            if (book?.id === existing.id) {
              book = existing;
              lines = book.text.split("\n");
              toc = C.chapters(book.text);
            }
            count++;
          } else errors.push(file.name + "：已在书架中");
          continue;
        }
        const b = {
          id: hash,
          title: file.name.replace(/\.[^.]+$/, ""),
          text: decoded.text,
          encoding: decoded.encoding,
          line: 0,
          updated: Date.now(),
          notes: [],
        };
        await transaction("books", "readwrite", (s) => s.put(b));
        books.push(b);
        count++;
      } catch (e) {
        errors.push(file.name + "：" + e.message);
      }
    }
    importing = false;
    if (!disposed) {
      view = "shelf";
      render();
      message(`已导入 ${count} 本。${errors.join("；")}`);
    }
  }
  root.addEventListener("dragover", (e) => {
    e.preventDefault();
    root.classList.add("drop");
  });
  root.addEventListener("dragleave", () => root.classList.remove("drop"));
  root.addEventListener("drop", (e) => {
    e.preventDefault();
    root.classList.remove("drop");
    importFiles(e.dataTransfer.files);
  });
  const unload = () => {
    clearTimeout(saveTimer);
    checkpoint();
    clearTimeout(saveTimer);
    persistPosition();
  };
  window.addEventListener("pagehide", unload);
  const resizeObserver = new ResizeObserver(updateFooterValues);
  resizeObserver.observe(main);
  const request = indexedDB.open("dsh-novel-reader-v1", 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore("books", { keyPath: "id" });
    request.result.createObjectStore("settings");
  };
  request.onerror = () => message("无法打开本地书架：" + request.error.message);
  request.onsuccess = async () => {
    db = request.result;
    if (disposed) {
      db.close();
      return;
    }
    db.onversionchange = () => {
      db.close();
      message("书架版本已变更，请重新打开阅读器。");
    };
    try {
      books = await transaction("books", "readonly", (s) => s.getAll());
      const saved = await transaction("settings", "readonly", (s) =>
        s.get("preferences"),
      );
      if (saved) settings = { ...settings, ...saved };
      const positions = await transaction("settings", "readonly", (s) => s.getAll());
      const byId = new Map(books.map((b) => [b.id, b]));
      for (const position of positions) {
        const b = position.kind === "reading-position" && byId.get(position.bookId);
        if (!b) continue;
        b.line = Math.max(0, Math.min(b.text.split("\n").length - 1, Number(position.line) || 0));
        b.offset = Math.max(0, Math.min(1, Number(position.offset) || 0));
        b.atTop = position.atTop === true;
        b.updated = position.updated || b.updated;
      }
      render();
    } catch (e) {
      message("书架加载失败：" + e.message);
    }
  };
  main.append(el("div", { class: "empty" }, "正在打开本地书架…"));
  return () => {
    checkpoint();
    disposed = true;
    clearTimeout(saveTimer);
    cancelAnimationFrame(restoreFrame);
    persistPosition();
    window.removeEventListener("pagehide", unload);
    resizeObserver.disconnect();
    write.finally(() => db?.close());
    root.replaceChildren();
  };
}
