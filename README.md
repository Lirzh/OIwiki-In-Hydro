# OIwiki-In-Hydro

在 [Hydro](https://github.com/hydro-dev/Hydro) 中内嵌 [OI Wiki](https://oi-wiki.org)

## 安装

将本目录放入 Hydro 插件目录，安装依赖后重启 Hydro：

```bash
hydrooj addon add 
yarn install
```

首次启动会在后台克隆 OI Wiki 源码，期间页面提示同步中并自动刷新。

## 许可与版权说明

- 本插件自身代码以 MIT 许可发布（见 [LICENSE](./LICENSE)）。
- 插件**不打包、不分发**任何 OI Wiki 内容：文档仅在运行时从 OI Wiki 官方仓库克隆到本地 `cache/`（已 gitignore）。
- OI Wiki 文档内容依据 [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/deed.zh-hans) 许可使用。插件在渲染时尽力保留原作信息：
  - 页面若带有 `author` 元数据，会在标题下展示作者署名；
  - 首页入口组件标注内容来源与许可；
  - 许可相关徽章（license / CC）予以保留，仅移除 Stars/Watch 等社交装饰徽章；
  - 正文与代码内容保持原样，仅改写链接与图片路径以适配本站路由。
- 部署本站点即构成对 OI Wiki 内容的演绎，部署者有义务保留上述署名与许可声明。若需另行分发文档内容，请遵循 CC BY-SA 4.0。
