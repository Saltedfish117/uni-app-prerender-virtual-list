# uni-app 预渲染虚拟列表

[![Tests](https://github.com/Saltedfish117/uni-app-prerender-virtual-list/actions/workflows/test.yml/badge.svg)](https://github.com/Saltedfish117/uni-app-prerender-virtual-list/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

通过同宽预渲染测量少量代表样本，先建立类型高度表，再计算全部已加载条目的位置与可见窗口。

当列表的高度变化集中在几种受控版式中，这种做法能减少逐行测高、修正估计偏移及处理测量纠偏的工作。本仓库提供一份可复用的技能，以及无第三方运行时依赖的 JavaScript 控制器和 uni-app 接入模板。

## 适用场景

- **等高列表**：`fixed` 模式直接计算窗口边界。
- **有限种高度版式**：`typed` 模式预渲染每种版式的代表，测高后累加布局并二分定位窗口。
- **分组列表**：在分类高度布局上接入组头、吸顶副本、分组跳转和跨窗口选择。

同一种类型的条目必须在当前宽度下等高。不限行的文本、异步撑高的图片、任意展开内容需要另外设计逐行测量与锚点保位。本模板没有提供任意动态行高的自动处理。

## 使用技能

克隆本仓库，然后将整个目录放入所用客户端支持的技能目录，保留目录名 `uni-app-prerender-virtual-list`。

```bash
git clone https://github.com/Saltedfish117/uni-app-prerender-virtual-list.git
```

在支持 `$skill-name` 调用的客户端中，可以使用以下提示词：

```text
使用 $uni-app-prerender-virtual-list 检查当前页面的高度版式和滚动方式，
通过同宽预渲染接入虚拟列表，并验证窗口更新、分组跳转和生命周期行为。
```

技能入口为 [SKILL.md](SKILL.md)。自动识别与调用方式取决于所用客户端。

## 直接使用模板

1. 复制 [控制器](assets/virtual-list-controller.js) 和 [适配工具](assets/uni-list-adapter.js)；容器模板另需 [原生滚动同步工具](assets/scroll-view-sync.js)。
2. 根据滚动方式选择 [页面滚动模板](assets/page-scroll-example.md) 或 [scroll-view 模板](assets/scroll-view-example.md)。只提取其中完整的 `vue` 代码块，分别保存为 `PageScrollExample.vue` 或 `ScrollViewExample.vue`。
3. 将模板导入的 JS 文件与组件放在同目录，或调整导入路径；按项目约定注册页面路由，再用实际数据替换合成示例。

示例保存为 Markdown，便于上传仅接受文本资源的技能平台。不要将 `.md` 文件直接作为 Vue 组件导入，也不要把说明和代码围栏复制进组件。`assets/package.json` 只声明技能测试所需的 ES Module 范围，不复制到应用。

样本放在正式列表包含块中继承宽度，隐藏但保留自然高度。窗口发布时用 `buildKeyedWindow` 生成稳定 key 数组与内容映射，模板直接绑定 `visibleNodes[nodeKey].style`；避免行级样式方法，以及对象数组增量更新与原生节点复用错配。

容器模板还演示筛选先确认原生回顶再替换数据，以及事件静默/触底后的有界位置校正。快速滑动空白需同时检查实际节点几何与截图，不能只看 JS 可见范围。

## 文档

| 内容 | 说明 |
| --- | --- |
| [控制器契约](references/controller-api.md) | 节点、度量、快照及方法 |
| [等高列表](references/fixed-list.md) | 等高测量与算术窗口 |
| [分类高度列表](references/typed-list.md) | 高度类型、样本与布局失效 |
| [分组吸顶与跳转](references/grouped-list.md) | 分组锚点、尾部补高和选择状态 |
| [接入与验证](references/integration.md) | 滚动坐标、异步测量和生命周期 |
| [空白诊断与原生验收](references/scroll-blank-diagnosis.md) | 末次事件滞后、节点错位、筛选回顶与验收矩阵 |
| [更新日志](CHANGELOG.md) | 本次改动、兼容说明和验证边界 |

默认上下各 3 屏缓冲、150ms 节流，均可配置。控制器保留窗口边缘即时补充、尾次使用最新已收到位置及窗口不变时复用数组；原生同步工具补充实际位置回读。

## 运行测试

使用 Node.js 22 或更新版本，在仓库根目录运行：

```bash
node --test tests/*.test.mjs
```

测试使用 Node 内置工具，无需安装 npm 依赖。覆盖控制器、测量竞态、key 编码/窗口映射、原生回读、连续筛选与超时取消，并提取两个模板的实际脚本运行合成接入测试。GitHub Actions 执行相同测试。

这些自动化检查验证纯 JavaScript 逻辑和模拟接入行为。小程序、App 的原生排版与真机滚动性能仍需在目标平台验证。

## 许可证

以 [MIT License](LICENSE) 开源，版权署名为 Saltedfish117。使用、修改或分发时保留许可证与版权声明。
