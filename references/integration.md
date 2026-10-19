# 接入、生命周期与验证

## 文件接入

从 `assets/` 复制 `virtual-list-controller.js` 和 `uni-list-adapter.js`；容器模板另需 `scroll-view-sync.js`。Vue 示例以 Markdown 模板保存，接入时按下表还原，仅写入完整 `vue` 代码块的内容，不带说明和代码围栏。

| 技能中的模板 | 项目中的组件文件 |
| --- | --- |
| [page-scroll-example.md](../assets/page-scroll-example.md) | `PageScrollExample.vue` |
| [scroll-view-example.md](../assets/scroll-view-example.md) | `ScrollViewExample.vue` |

将组件与其导入的 JS 文件放在同目录，或按目标目录调整相对导入。示例作为页面使用，按现有项目配置添加页面路由。不要将 `.md` 文件直接作为组件导入。无需下载依赖、调用接口或访问外部资源。

`assets/package.json` 只声明 Node 测试的 ES Module 范围，不复制到现有应用，不替换项目配置。示例是 Options API 页面，纯控制器可用于其他 Vue 接入方式；组件内使用时将页面生命周期映射为挂载、可见性与卸载生命周期，并核对 selector query 的组件作用域。

## 同宽样本

把测量层放在 `.virtual-list { position:relative; width:100%; }` 内：

```css
.measurement {
  position: absolute; left: 0; bottom: 100%; width: 100%;
  visibility: hidden; pointer-events: none;
}
```

样本保留自然高度，共享正式行的 CSS、边框、显隐条件与盒模型。不要从屏幕宽度减两次 padding，也不要用 fixed 层的左右边距模拟列表宽度。保留 helper 的同宽校验，当前容差为 1px；宽度不匹配时查包含块、rpx 舍入和父级样式，不通过放宽校验掩盖错误。宽度变化后重测全部已使用类型。

## 窗口的原生绑定

`buildKeyedWindow(snapshot.visibleList)` 返回 `{ visibleKeys, visibleNodes }`，预计算每行 style。先更新节点映射，再更新 key 顺序；模板循环 key，内容和 style 都从 `visibleNodes[nodeKey]` 读取。两个模板给出完整写法。

`encodeRenderKey` 对字符串/数字添加类型前缀并编码 UTF-16 单元，避免 `1` 与 `"1"` 冲突，以及点号、中括号、原型名对原生数据路径的影响。使用简短稳定业务 ID；编码会增加传输长度。映射中的 `.key` 仍为原始标识；只保留当前窗口，不保留历史缓存。不要直接把任意业务 ID 当普通对象路径，也不要自行转成数组索引。

某些小程序增量更新路径中，对象数组按下标提交、WXML 按 key 复用时会出现位置残留。新的绑定规避这类错配，但仍需验证实际 WXML 与节点几何；Node 里映射正确不等于原生渲染正确。

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

原生滚动回读与筛选回顶使用 [scroll-view-sync.js](../assets/scroll-view-sync.js)。该工具负责有界查询、静默采样及失效控制；适配器 `syncScroll(actual)` 更新原始位置并立即刷新控制器，取消旧节流任务。页面依然负责请求版本、分页暂停、筛选条件与失败入口。完整时序与参数见 [诊断参考](scroll-blank-diagnosis.md)。

## 性能边界

可见窗口更新才向视图层传新数组；组状态变化单独处理。避免每次 scroll 重新过滤、排序或转换全部数据。3 屏/150ms 是起点，不是所有设备上的最优值；诊断卡顿时观察可见节点数、每次提交大小与组件创建成本，再调整控制器参数。

虚拟行的 `top`、`transform`、`height` 在窗口发布时预计算，用 `:style="visibleNodes[nodeKey].style"` 直接绑定。不要在 `v-for` 中调用行级样式方法；这可能触发重复提交或生成丢失 key 的中间数组。容器样式可以使用 `computed`。检查生成的 WXML，确认循环的是 key 数组、`wx:key="*this"`，style 与内容均按相同 key 读取。

不要默认拆掉所有子组件或替换图片组件。若减少组件确有收益，仍需保持图片占位、加载失败行为、文字布局和点击区域。

## 检查清单

自动化：空/单/大量数据，固定与分类模式，负坐标、精确边界、间距、快速正反向滑动、同窗口更新、分组锁定、末组、暂停恢复、销毁及无效输入不破坏旧布局；行定位 style 在数据层预计算且不由模板方法生成。

适配层：同 query 坐标配对、宽度变化重测、滚动期间测量完成、连续测量旧结果、页面隐藏/卸载后的回调、程序跳转回读；末次事件滞后、连续筛选、回顶失败、查询超时及追加后的原生位置校正。

设备：首屏无明显跳位，快速滑动不露空白或叠压，最后一组可定位，来回切页后位置正确，滚出再回来选择仍在；确认滚动时没有因行级 style 方法重复刷新 item。分别检查目标小程序和 App；只有静态或 Node 验证时明确说明设备验证尚未完成。

在技能目录运行 `node --test tests/*.test.mjs`。项目接入时用已有编译工具验证改动文件；原生验收按 [诊断参考](scroll-blank-diagnosis.md) 比较逐节点实际位置与截图，不得把测试通过等同于原生布局正确或帧率达标。
