# Contributing

欢迎通过 Issue 报告问题，或提交 Pull Request。请使用自行编写、可公开分享的最小文本复现问题，不要上传受版权保护的整本小说、个人阅读记录或凭据。

需要 Node.js 22 或更高版本。此项目没有额外的构建依赖：

```sh
npm run build
npm test
npm run check
```

修改 `src/` 后请重新构建并提交 `lib/client.js`，确保通过 Git URL 安装的用户无需另行构建。修改章节识别或位置记录时，请补充覆盖相应行为的回归测试。安装包必须包含宿主入口、客户端入口、组合包 patch、locale、图标及许可证。
