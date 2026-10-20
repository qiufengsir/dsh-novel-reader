const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("renamed reader loads books, preferences and positions from the existing database", async () => {
  class Element {
    constructor(tag) {
      this.tag = tag;
      this.children = [];
      this.dataset = {};
      this.style = { setProperty() {}, removeProperty() {} };
      this.classList = { add() {}, remove() {} };
    }
    setAttribute(key, value) { this[key] = value; }
    addEventListener() {}
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    get textContent() { return this.children.map((child) => typeof child === "string" ? child : child.textContent).join(""); }
    set textContent(value) { this.children = [value]; }
  }
  const storedBook = { id: "old-book", title: "原有书架", text: "第一章\n原文\n末行", line: 0, updated: 1, notes: [] };
  const storedPreferences = { theme: "night", size: 24 };
  const storedPosition = { kind: "reading-position", bookId: "old-book", line: 1, offset: 0.3, atTop: false, updated: 5 };
  const reads = [];
  const db = {
    close() {},
    transaction(store, mode) {
      assert.equal(mode, "readonly");
      const tx = {
        objectStore() {
          const request = (operation, key, result) => {
            const read = { result };
            reads.push({ store, operation, key });
            queueMicrotask(() => { read.onsuccess(); tx.oncomplete(); });
            return read;
          };
          return {
            getAll() { return request("getAll", undefined, store === "books" ? [storedBook] : [storedPreferences, storedPosition]); },
            get(key) { return request("get", key, storedPreferences); },
          };
        },
      };
      return tx;
    },
  };
  const openRequest = { result: db };
  const root = new Element("div");
  const browser = {
    Node: Element,
    document: { createElement: (tag) => new Element(tag), createTextNode: (text) => text },
    addEventListener() {}, removeEventListener() {},
    ResizeObserver: class { observe() {} disconnect() {} },
    indexedDB: {
      open(name, version) {
        assert.equal(name, "dsh-novel-reader-v1", "The existing storage namespace must survive the package rename");
        assert.equal(version, 1);
        return openRequest;
      },
    },
    cancelAnimationFrame() {}, clearTimeout,
  };
  browser.window = browser;
  browser.globalThis = browser;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/reader.js"), "utf8"), browser);
  const unmount = browser.mountReader(root);
  await openRequest.onsuccess();
  assert.equal(root.dataset.theme, "night");
  assert.match(root.textContent, /原有书架/);
  assert.doesNotMatch(root.textContent, /书架加载失败/);
  assert.equal(storedBook.line, 1);
  assert.equal(storedBook.offset, 0.3);
  assert.equal(storedBook.updated, 5);
  assert.deepEqual(reads, [
    { store: "books", operation: "getAll", key: undefined },
    { store: "settings", operation: "get", key: "preferences" },
    { store: "settings", operation: "getAll", key: undefined },
  ]);
  unmount();
});
