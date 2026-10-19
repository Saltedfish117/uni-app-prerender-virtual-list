# 页面滚动示例模板

为兼容只接受文本资源的技能平台，完整 Vue 单文件组件保存在下面的代码块中。

接入时仅提取 `vue` 代码块内容，保存为 `PageScrollExample.vue`；不要把说明、代码围栏或本 Markdown 文件作为组件导入。将 `virtual-list-controller.js`、`uni-list-adapter.js` 放在组件同目录，或相应调整导入路径，并按项目约定注册页面路由。示例中的条目均为合成数据。窗口发布时生成 key 数组与节点映射，预计算 style 后按 key 直接绑定；样本在列表内部继承同宽。

```vue
<template>
    <view class="example-page">
        <text class="title">页面滚动 · 等高虚拟列表</text>
        <text class="note">以下全部为本地合成数据，可追加并更新当前窗口。</text>
        <view class="actions">
            <button size="mini" @click="appendRows">追加 100 行</button>
            <button size="mini" :disabled="!layoutReady" @click="updateVisibleRow">更新可见首行</button>
            <button size="mini" @click="retryLayout">重新测量</button>
        </view>
        <view class="status">
            <text>{{ layoutError || (layoutReady ? '已加载 ' + itemCount + ' 行' : '正在测量布局…') }}</text>
        </view>
        <view id="page-list" class="virtual-list" :style="listStyle">
            <view v-if="measureItem" class="measurement" aria-hidden="true">
                <view id="page-row-sample" class="example-row"><text>{{ measureItem.text }}</text></view>
            </view>
            <view v-if="layoutReady">
                <view
                    v-for="nodeKey in visibleKeys"
                    :key="nodeKey"
                    :data-node-key="nodeKey"
                    class="virtual-node"
                    :style="visibleNodes[nodeKey].style"
                >
                    <view class="example-row"><text>{{ visibleNodes[nodeKey].data.text }}</text></view>
                </view>
            </view>
        </view>
    </view>
</template>

<script>
import { createVirtualListController } from './virtual-list-controller.js';
import { buildKeyedWindow, createUniListAdapter, readPageLayout } from './uni-list-adapter.js';

// Synthetic example data. Stable keys never come from the visible array index.
const makeRows = (start, count) => Array.from({ length: count }, (_, offset) => {
    const number = start + offset;
    return { key: `synthetic-${number}`, data: { text: `合成条目 ${number}` } };
});

export default {
    data() {
        return {
            visibleKeys: [], visibleNodes: {}, totalHeight: 0, itemCount: 0,
            measureItem: null, layoutReady: false, layoutError: '',
        };
    },
    computed: {
        listStyle() { return `height:${this.totalHeight}px;`; },
    },
    created() {
        this.sourceRows = makeRows(1, 300);
        this.itemCount = this.sourceRows.length;
        this.controller = createVirtualListController({
            mode: 'fixed', bufferScreens: 3, throttleMs: 150,
            onUpdate: (snapshot) => {
                if (snapshot.visibleChanged) {
                    const window = buildKeyedWindow(snapshot.visibleList);
                    this.visibleNodes = window.visibleNodes;
                    this.visibleKeys = window.visibleKeys;
                }
                this.totalHeight = snapshot.totalHeight;
            },
        });
        this.adapter = createUniListAdapter({
            controller: this.controller,
            nextTick: () => new Promise((resolve) => this.$nextTick(resolve)),
            getNodes: () => this.sourceRows,
            // A synthetic sample of the same fixed CSS shape also measures an empty list.
            getSample: () => this.sourceRows.length ? this.sourceRows[0].data : { text: '合成测量条目' },
            onSample: (sample) => { this.measureItem = sample; },
            readLayout: () => readPageLayout({
                query: () => uni.createSelectorQuery(), scope: this,
                listSelector: '#page-list', sampleSelectors: { item: '#page-row-sample' },
                viewportHeight: uni.getSystemInfoSync().windowHeight,
            }),
            onLayout: () => { this.layoutReady = true; this.layoutError = ''; },
            onError: (error) => {
                this.layoutReady = false;
                this.layoutError = error ? '布局测量失败，请点击重新测量。' : '';
                if (error) { this.visibleKeys = []; this.visibleNodes = {}; this.totalHeight = 0; }
            },
        });
    },
    onShow() { this.adapter.onShow(); },
    onReady() { this.adapter.onReady(); },
    onResize() { this.adapter.onResize(); },
    onHide() { this.adapter.onHide(); },
    onUnload() { this.adapter.dispose(); },
    onPageScroll(event) { this.adapter.handleScroll(Number(event.scrollTop)); },
    methods: {
        appendRows() {
            this.sourceRows = this.sourceRows.concat(makeRows(this.sourceRows.length + 1, 100));
            this.itemCount = this.sourceRows.length;
            this.adapter.refreshData();
        },
        updateVisibleRow() {
            const top = Math.max(0, this.adapter.getLocalScrollTop());
            const current = this.visibleKeys.map((key) => this.visibleNodes[key]).find((node) => node.rect.bottom > top);
            if (!current) return;
            this.sourceRows = this.sourceRows.map((node) => node.key === current.key
                ? { ...node, data: { text: `${node.data.text} · 已更新` } } : node);
            this.adapter.refreshData();
        },
        retryLayout() { this.adapter.measure(); },
    },
};
</script>

<style scoped>
.example-page { padding: 16px; box-sizing: border-box; }
.title { display: block; font-size: 20px; font-weight: 600; }
.note { display: block; margin: 12px 0; color: #555; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
.status { min-height: 48px; display: flex; align-items: center; font-size: 13px; }
.virtual-list { position: relative; width: 100%; }
.virtual-node { position: absolute; left: 0; top: 0; width: 100%; }
.example-row {
    height: 56px; width: 100%; padding: 0 12px; box-sizing: border-box;
    display: flex; align-items: center; border-bottom: 1px solid #ddd;
    background: #fff; overflow: hidden; white-space: nowrap;
}
.measurement {
    position: absolute; left: 0; bottom: 100%; width: 100%;
    visibility: hidden; pointer-events: none;
}
</style>
```
