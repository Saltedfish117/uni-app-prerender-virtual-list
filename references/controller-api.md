# 控制器契约

使用 `assets/virtual-list-controller.js` 的命名导出 `createVirtualListController`。核心接收列表坐标；不访问页面、容器、接口或响应式系统。

## 创建与数据

```js
const controller = createVirtualListController({
  mode: 'fixed', // 必选：fixed 或 typed
  bufferScreens: 3,
  throttleMs: 150,
  onUpdate(snapshot) { /* 只提交视图需要的变更 */ },
});
```

可选 `clock: { now(), setTimeout(fn, ms), clearTimeout(id) }` 用于确定性测试。生产接入通常省略。缓冲和节流必须是有限非负数。

节点：`{ key, data, type?, role?, groupId?, gapBefore? }`。`key` 为非空字符串或有限数字，整个布局唯一，不用数组索引充当可变数据的身份；`data` 是不透明展示数据。字符串和数字标识不互相转换。

| 模式 | 高度输入 | 节点限制 |
| --- | --- | --- |
| `fixed` | `metrics.rowHeight` 为统一实测 px 高度 | 不带分组或非零间距；通过算术计算 rect |
| `typed` | `metrics.heightByType` 按 `node.type` 给出实测 px 高度 | 可用非负 `gapBefore`；组头设置 `role: 'group-header'` 与唯一 `groupId` |

共有度量为 `viewportHeight > 0` 和 `topInset >= 0`。`viewportHeight` 是整个滚动视口高度，`topInset` 是上方覆盖区域高度，用于活动组、吸顶与跳转，不再从视口高度重复扣除。所有高度须为有限正数，所有尺寸使用 px。初始控制器可未布局，但提交布局时必须提供有效度量。

分类模式示例（全部为合成数据）：

```js
const nodes = [
  { key: 'demo-heading', type: 'heading', role: 'group-header', groupId: 'demo-group', data: { text: '示例组' } },
  { key: 'demo-row', type: 'row', groupId: 'demo-group', data: { text: '合成条目' }, gapBefore: 8 },
];
controller.replaceLayout(nodes, {
  heightByType: { heading: measuredHeadingHeight, row: measuredRowHeight },
  viewportHeight: measuredViewportHeight,
  topInset: measuredOverlayHeight,
}, localScrollTop);
```

此段需在 `mode: 'typed'` 的实例上使用。无组头的分类列表无需分组字段。尺寸由接入方测量；示例变量不是预设值。

## 方法

| 方法 | 行为 |
| --- | --- |
| `replaceLayout(nodes, metrics, scrollTop?)` | 验证并原子替换数据和度量，重建一次、发布一次；失败保留旧布局。传空节点清空列表 |
| `setMetrics(metrics, scrollTop?)` | 合并度量；仅视口/遮挡变化不重建，显式提供行高信息则重建，不依赖高度表引用是否改变 |
| `handleScroll(scrollTop)` | 更新最新局部滚动位置，正常节流，临近窗口边缘或越界时立即计算 |
| `refresh(scrollTop?, { force: true }?)` | 立即计算；force 用于原位置的数据或展示状态变化 |
| `getSnapshot()` | 读取当前快照，不触发更新 |
| `getGroupOffset(groupId)` | 返回 `组头 top - topInset`，可以为负；未知组返回 `null` |
| `beginProgrammaticScroll(groupId)` | 锁定目标活动组；窗口仍随实际滚动更新 |
| `endProgrammaticScroll(actualScrollTop)` | 用实际结束位置重新计算并解除锁定 |
| `pause()` / `resume(scrollTop?)` | 暂停清计时器、停止通知但保留布局；恢复时重新计算 |
| `destroy()` | 幂等销毁并清计时器、数据及回调；之后不再通知 |

不要把“全部”变成控制器内的特殊业务 ID；接入层自行处理回到列表起点。调用者不得修改快照中的布局节点或位置；更新通过公开方法提交。

## 快照

- `visibleList`：节点加 `index` 和 `rect: { top, height, bottom }`，相对列表起点定位。控制器保持纯 JS，不生成 CSS；Vue/uni-app 适配层应在发布窗口时把定位值预计算为节点字段（例如 `style`），模板直接绑定该字段。
- `totalHeight`：所有已加载节点与间距的总高，不包含页面额外尾部空间。
- `start`、`endExclusive`：半开索引 `[start, endExclusive)`；没有可见行时两者相等。
- `layoutVersion`、`visibleChanged`：布局/可见数据版本和数组变化标记；只有可见窗口与布局不变且未强制刷新时才复用数组。
- `activeGroupId`、`activeChanged`：活动组和活动组 ID 变化标记；没有活动组时 ID 为 `null`。吸顶可独立改变，每次回调都读取吸顶字段。
- `stickyVisible`、`stickyGroup`：是否显示吸顶副本及组头 `{ key, groupId, data, top, bottom, index }`；不应假设窗口更新是组状态更新的唯一触发。

窗口按 `bottom > windowTop && top < windowBottom` 相交。负局部滚动坐标必须保留：列表可能尚在视口下方，不能直接归零导致长页头下提前渲染整窗。自然滚动的活动组在越过组头顶部时改变，吸顶在越过第一组头底部时出现。

## 生命周期与数据约定

完整布局提交前复制需要保持稳定的数据；不要原地修改已发布 DTO 再期待 Vue 自动更新。使用新节点调用 `replaceLayout`，或明确强制刷新。全量原始对象与选择集合由页面管理。

pause 不能代替页面的异步失效检查：DOM 查询、跳转收尾、请求响应仍需要接入方的版本号与可见/销毁状态保护。重新测量失败时隐藏旧的虚拟内容，显示重试入口，避免展示与当前宽度不符的几何。

`uni-list-adapter.js` 的 `buildKeyedWindow(visibleList)` 是视图转换，不改变本控制器快照接口；模板使用安全编码后的 key 循环、映射中的原始 key 处理操作。adapter 的 `syncScroll(actualRawTop)` 更新原始位置并立即调用 `refresh(localTop)`，取消旧节流。原生滚动校正与节点几何检查见 [空白诊断](scroll-blank-diagnosis.md)。
