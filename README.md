# dsh-novel-reader · 拾页

[![Plugin checks](https://github.com/qiufengsir/dsh-novel-reader/actions/workflows/ci.yml/badge.svg)](https://github.com/qiufengsir/dsh-novel-reader/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

在 DeepSeek Harness 右侧栏里，安静读一本本地小说。

**拾页**是面向 DeepSeek Harness 的第三方小说阅读器插件。支持本地 TXT 书架、章节导航、章内进度、书签摘记及阅读外观设置；小说正文保存在设备本地，不发送给模型。

当前源码新增 **1.1.0-beta.1 开发任务联动**。公开的 `v1.0.0` 尚不包含这项功能；可用下方本地辅助安装器安装本轮源码进行验证。

## 安装

兼容性基线：**DeepSeek Harness 0.2.1-rc.2**。上游仍在开发预览阶段，后续版本的插件接口可能变化。

1. 在 DeepSeek Harness 打开 **插件 → 添加插件**。
2. 输入以下 Git 安装地址：

   ```text
   git+https://github.com/qiufengsir/dsh-novel-reader.git#v1.0.0
   ```

3. 完成安装并启用 **拾页 · 小说阅读器**；如提示需要重启，请重启应用。
4. 打开一个会话，在右侧栏开始页选择 **小说阅读器**。

仓库提交了构建好的 `lib/`，通过 Git 地址安装不需要在安装时执行构建脚本。插件包名是 `dsh-novel-reader`；本项目目前通过 GitHub 分发，不要求 npm 同名包已经发布。

也可下载源码后，在关闭 Harness 的状态下使用本地辅助安装器：

```sh
node install.mjs
```

辅助安装器安装到当前用户的 `.dsh/profiles/desktop`，遵循 `DSH_HOME` 环境变量；已有 manifest 会备份，用户的 profile patch 会保留。安装到自定义 profile：

```sh
node install.mjs --profile /absolute/path/to/profile
```

命令行用户也可以使用官方插件安装入口：

```sh
dsh plugin --profile desktop add github:qiufengsir/dsh-novel-reader
```

项目的 `engines.dsh` 精确声明已核对的 `0.2.1-rc.2`，尚未验证其他版本时不扩大兼容范围。

## 阅读功能

- **本地导入**：TXT / TEXT / MD 批量导入及拖放；每个文件小于 50 MB（50 × 1024 × 1024 字节）。MD 按纯文本显示。
- **编码兼容**：自动识别 UTF-8 和带 BOM 的 UTF-16，非 UTF-8 回退到 GB18030 / GBK；可手动指定 Big5、UTF-8、UTF-16 LE/BE。
- **书架与最近阅读**：按最近阅读排序、搜索书名、继续阅读、移除书籍；相同原文件通过 SHA-256 去重。
- **章节阅读**：识别中文章/回/卷和英文章名，支持目录定位。没有章名的文本按 180 行划分阅读节。
- **章内进度**：底部滑块只控制当前章节，全书进度独立显示；误操作可返回上次跳转前的位置。
- **章末翻页**：在正文结束处切换前后章，并显示下一章标题；章末可展开原文核对。
- **进度记忆**：保存段落及段内偏移；刷新后恢复位置。滚动时仅保存小型进度记录。
- **搜索**：全文文字搜索、结果定位、正文命中高亮；最多显示 200 条结果。
- **书签与摘记**：保存书签、选中文字写笔记、段落标记、定位、删除，以及导出当前书籍摘记 JSON。
- **阅读外观**：暖纸、素白、青竹、夜读四种主题；宋体/无衬线字体、12–32 字号、1.3–2.8 行距和自定义纯色背景。
- **侧栏适配**：响应式布局、空状态、导入和存储错误提示、键盘可操作控件。

乱码时，可在 **外观 → 下次导入编码** 选择正确编码，再次导入同一文件；采用不同手动编码重新导入时保留按行记录的进度和摘记。

## 与开发任务联动

在当前会话执行开发任务时继续阅读；本轮正常结束后，阅读器显示「任务已经完成」提醒。顶部显示绑定的会话名称和运行状态，切换开发会话时保留小说和阅读位置。

开启顶部的 **联动专注** 后，正常结束会锁住小说、目录、搜索和摘记；在同一开发会话提交新的用户需求，被 dsh 接受后自动解锁。自动续跑、计时器或其他会话的消息不会解锁已完成的阅读。选项默认关闭并自动保存，可从顶部随时关闭；外观设置仍可访问。

等待确认或输入、执行失败、手动停止、输出上限和进程中断分别显示等待/错误/停止状态，不会冒充正常完成；本轮未正常完成时保留阅读能力。关闭联动专注后依然显示完成提醒。提醒位于插件页面内，不申请系统通知权限。

首次打开已在执行中的长任务，即使分页历史省略了原始用户消息，也允许本轮阅读。已观察到的完成状态与新需求顺序会在当前阅读器生命周期内按会话保存；历史分页、重连、切换会话不会重复提醒。完全重载后以 dsh 当前历史窗口重新建立状态；它是辅助专注功能，不是防绕过的访问控制。

联动订阅官方 `sessions` / `uiSession` 状态与 `binding.eventSource`，按 `turn/end.reason.kind === 'completed'` 确认轮次完成；只识别用户消息的来源与序号，不读取其正文、不发送消息、不操作主会话。独立预览未连接 dsh 时正常阅读。

桌面验证步骤与已知边界见 [任务联动验证说明](docs/TASK_LINKING.md)。

## 数据与权限

书籍、设置、进度和摘记保存在当前应用来源的 IndexedDB。插件没有网络上传代码、模型工具或额外主进程接口；阅读不会把小说加入对话上下文。

清理应用数据、浏览器来源或更换设备会影响本地书架。请保留原始文本，需要时导出摘记。浏览器独立预览与桌面应用使用不同来源，书架数据相互隔离。

## 开发

需要 **Node.js 22+**。构建和本地测试仅使用 Node.js 标准库；`devDependencies` 记录兼容的 Harness 开发接口，不需要先安装它们即可执行以下检查。

```sh
git clone https://github.com/qiufengsir/dsh-novel-reader.git
cd dsh-novel-reader
npm run build
npm test
npm run check
npm pack --dry-run
```

独立预览：

```sh
python -m http.server 8765 --bind 127.0.0.1
```

打开 <http://127.0.0.1:8765/preview.html>，可导入仓库自写示例 `test/sample.txt`。同一份预览书架需使用相同的协议、主机和端口访问。

访问 <http://127.0.0.1:8765/preview.html?task-demo=1> 可显示明确标注的任务模拟器，验证新需求、等待确认、正常完成、停止、错误和自动续跑。模拟器不连接真实 dsh，也不随插件包分发。

### 目录

| 文件 | 作用 |
| --- | --- |
| `src/core.cjs` | 编码解码、章节识别和全文搜索 |
| `src/task-link.cjs` | 当前开发会话的事件订阅、完成判断和专注状态 |
| `src/reader.js` | 阅读界面、书架、进度、设置、摘记和存储 |
| `src/reader.css` | 阅读排版、主题和响应式侧栏 |
| `build.mjs` | 生成 Harness 客户端模块 |
| `lib/index.js` | 宿主插件入口 |
| `lib/client.js` | 已构建客户端入口 |
| `cordis.patch.yml` | 注册 `ui-novel-reader` 插件行 |
| `locale/`、`icon.svg` | 插件管理器的展示名称、描述与图标 |
| `install.mjs` | 可选的本地 profile 安装辅助工具 |
| `test/` | 回归测试及自写示例文本 |

### 插件契约

插件通过 `dsh.bundle.patch` 声明组合包，通过 `dsh.client` 和 `./client` 导出客户端入口，使用 Harness 提供的 React。客户端模块导出 `inject/apply`，通过 `sidebarRightTabs` 注册 `novel-reader` 类型，并在 `sidebar.right.pane.tab` slot 挂载界面。第三方标签使用 `extension` 优先级，注册和样式生命周期由 `ctx.effect` 管理。

参考上游：[官方打包与安装教程](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)、[插件展示元信息](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-package.zh.md#plugin-display-metadata)、[右侧栏浏览器插件](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/client/ui-sidebar-browser)。

### 检查范围

测试覆盖 UTF/GBK 解码、章节边界、正文重构完整性、搜索、客户端注册契约及本地安装器；联动回归覆盖轮次结束原因、真实用户需求、跨会话隔离、历史重放、自动续跑和订阅清理。还提供 manifest、exports、组合包 patch、locale、图标和分发文件检查。GitHub Actions 在 Windows / Linux、Node.js 22 / 24 上运行检查，并验证客户端构建产物已提交。

浏览器中验证过大文本导入、章内定位、误跳返回、章末翻页、刷新恢复和首尾章的原文一致性。实际桌面端激活、不同 Harness 版本与不同系统仍需相应运行环境验证；这些自动检查不代表 DeepSeek 官方审核或收录。

## Model Experience

None, as this plugin only renders a local reading interface and does not register model tools or prompt content.

#### KV Cache effect

No direct effect: reading state and novel text are not inserted into model requests.

## 已知限制

- 仅支持纯文本，不支持 EPUB、PDF、DOCX、在线抓书、OCR 或云同步。
- 编码检测和章节识别使用启发式规则；特殊文本可能需要手动选择编码或通过原文查看核对。
- 划线显示为所在段落的标记，并非逐字富文本批注；修改文件行结构可能影响原有定位。
- 多个会话或窗口之间没有书架实时合并，同一本书建议在一个阅读器内编辑。
- 本地存储容量、来源隔离、数据清理或文件本身缺失会影响阅读内容；插件不能补齐原始文件中没有的章节。
- 初始界面文案以简体中文为主；中英文 locale 提供插件管理器展示信息。
- 本插件为社区项目，与 DeepSeek 官方无隶属关系。

## 参与与许可

欢迎提交 [Issue](https://github.com/qiufengsir/dsh-novel-reader/issues) 或 Pull Request，开发约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。请使用可公开分享的最小示例复现问题。

[MIT License](LICENSE) © 2026 qiufengsir。仓库不附带第三方小说。
