# 接入、生命周期与验证

## 文件接入

从 `assets/` 复制 `virtual-list-controller.js` 和 `uni-list-adapter.js`。Vue 示例以 Markdown 模板保存，接入时按下表还原，仅写入完整 `vue` 代码块的内容，不带说明和代码围栏。

| 技能中的模板 | 项目中的组件文件 |
| --- | --- |
| [page-scroll-example.md](../assets/page-scroll-example.md) | `PageScrollExample.vue` |
| [scroll-view-example.md](../assets/scroll-view-example.md) | `ScrollViewExample.vue` |

将组件与两个 JS 文件放在同目录，或按目标目录调整相对导入。示例作为页面使用，按现有项目配置添加页面路由。不要将 `.md` 文件直接作为组件导入。无需下载依赖、调用接口或访问外部资源。

`assets/package.json` 只声明 Node 测试的 ES Module 范围，不复制到现有应用，不替换项目配置。示例是 Options API 页面，纯控制器可用于其他 Vue 接入方式；组件内使用时将页面生命周期映射为挂载、可见性与卸载生命周期，并核对 selector query 的组件作用域。

## 坐标分离

| 滚动所有者 | 起点测量 | 控制器接收 | 分组跳转 |
| --- | --- | --- | --- |
| 页面 | 同一次 query 的 `listRect.top + viewport.scrollTop` | `pageScrollTop - listTop` | `listTop + localTarget` |
| 固定高度 scroll-view | 同一次 query 的 `listRect.top - containerRect.top + container.scrollTop` | `container.scrollTop - listOffsetInContent` | `listOffsetInContent + localTarget` |

容器内有额外边框、内边距或头部时，应把这些位置差纳入同一坐标计算。示例容器不加边框与内边距以保持参照面明确。容器高度从实际 rect 取，不用屏幕高度代替；容器测量调用自己的 scrollOffset，不能使用 selectViewport 的滚动值。

listRect 与 scrollOffset 必须来自同一次 selector query。测量回调回来时若已经发生新滚动，保留较新的滚动事件，只提交与该测量版本匹配的起点与尺寸。局部滚动可为负，不提前 clamp；只在发给原生滚动 API 的最终目标上处理可达范围。

## 异步与生命周期

- ready、active 且未 disposed 才测量。每轮分配测量 token，`nextTick` 后、query 后、finally 前分别检查，避免旧任务移除新任务的测量节点。
- 记录测量开始时的 scrollVersion；测量完成只在版本没变时用 query 的滚动值更新当前值。
- hide：暂停控制器，作废测量和跳转，清计时器；show：用最新几何重新测量再恢复；resize：作废旧测量并重新测量。
- unload：先标记 disposed、作废所有 token、清计时器，再 destroy；生命周期只定义一次，合并已有清理逻辑。
- 测量失败：保持未 ready，隐藏不可靠位置的窗口，显示重试入口。不能用全量渲染悄悄绕过性能目标。
- 程序滚动必须用实际最终滚动值解锁。用户快速点击多个组时只有最新跳转能收尾。

## 性能边界

可见窗口更新才向视图层传新数组；组状态变化单独处理。避免每次 scroll 重新过滤、排序或转换全部数据。3 屏/150ms 是起点，不是所有设备上的最优值；诊断卡顿时观察可见节点数、每次提交大小与组件创建成本，再调整控制器参数。

虚拟行的 `top`、`transform`、`height` 等定位样式要在窗口数据生成或布局更新时预计算，存入节点字段后用 `:style="node.style"` 直接绑定。不要在 `v-for` 中使用 `:style="nodeStyle(node)"` 一类行级方法；uni-app 在每次滚动窗口更新时会重新执行它，并可能触发行组件和图片加载态重复刷新。`listStyle`、`tailStyle` 这类不依赖当前行的容器样式可以使用 `computed`。接入后检查生成的微信模板：如果仅因行级 style 方法出现中间映射列表（例如 `$root.l0`），应改为字段绑定。

不要默认拆掉所有子组件或替换图片组件。若减少组件确有收益，仍需保持图片占位、加载失败行为、文字布局和点击区域。

## 检查清单

自动化：空/单/大量数据，固定与分类模式，负坐标、精确边界、间距、快速正反向滑动、同窗口更新、分组锁定、末组、暂停恢复、销毁及无效输入不破坏旧布局；行定位 style 在数据层预计算且不由模板方法生成。

适配层：同 query 坐标配对、宽度变化重测、滚动期间测量完成、连续测量旧结果、页面隐藏/卸载后的回调、程序跳转的真实回读。

设备：首屏无明显跳位，快速滑动不露空白或叠压，最后一组可定位，来回切页后位置正确，滚出再回来选择仍在；确认滚动时没有因行级 style 方法重复刷新 item。分别检查目标小程序和 App；只有静态或 Node 验证时明确说明设备验证尚未完成。

在技能目录运行 `node --test tests/controller.test.mjs tests/adapter.test.mjs`。项目接入时用其已有 SFC 编译与检查工具验证改动文件；不得把测试通过等同于原生布局正确或帧率达标。
