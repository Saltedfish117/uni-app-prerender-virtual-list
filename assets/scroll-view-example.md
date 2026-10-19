# 容器滚动示例模板

为兼容只接受文本资源的技能平台，完整 Vue 单文件组件保存在下面的代码块中。

接入时仅提取 `vue` 代码块内容，保存为 `ScrollViewExample.vue`；不要把说明、代码围栏或本 Markdown 文件作为组件导入。将 `virtual-list-controller.js`、`uni-list-adapter.js`、`scroll-view-sync.js` 放在组件同目录，或相应调整导入路径，并按项目约定注册页面路由。示例中的分组和条目均为合成数据，包含有界原生位置校正及“全部/偶数条目”的回顶筛选。

窗口发布时生成 key 数组与节点映射，内容和预计算 style 按同一 key 读取。样本在列表内部继承同宽。真实接口、请求版本和分页由宿主维护；这个示例只演示视图/滚动时序，不能替代惯性手势验收。

```vue
<template>
    <view class="example-page">
        <text class="title">容器滚动 · 多类型分组列表</text>
        <text class="note">全部为合成数据。点击条目或组头选择；选中状态跨窗口保留。</text>
        <view class="actions">
            <button size="mini" @click="retryLayout">重新测量</button>
            <button size="mini" :disabled="!layoutReady" @click="applyFilter(true)">仅偶数条目</button>
            <button size="mini" :disabled="!layoutReady" @click="applyFilter(false)">全部条目</button>
            <text>已选 {{ selectedCount }} 项</text>
        </view>
        <scroll-view scroll-x class="tabs">
            <view class="tab-content">
                <button
                    v-for="group in groups" :key="group.key" size="mini"
                    :class="{ 'active-tab': activeGroupId === group.key }"
                    :disabled="!layoutReady || filterPending" @click="jumpToGroup(group.key)"
                >{{ group.text }}</button>
            </view>
        </scroll-view>
        <view class="status"><text>{{ layoutError || (layoutReady ? '可点击末组验证尾部补高' : '正在测量布局…') }}</text></view>
        <view class="scroll-shell">
            <scroll-view
                id="example-scroll" class="scroll-container" scroll-y
                :scroll-top="commandScrollTop" :scroll-with-animation="false"
                @scroll="handleContainerScroll" @touchstart="cancelJump"
                @scrolltolower="handleLowerEdge"
            >
                <view id="container-list" class="virtual-list" :style="listStyle">
                    <view v-if="measureSamples" class="measurement" aria-hidden="true">
                        <view id="sample-group" class="row group-row"><text>{{ measureSamples.header.text }}</text></view>
                        <view id="sample-compact" class="row compact-row"><text>{{ measureSamples.compact.text }}</text></view>
                        <view id="sample-regular" class="row regular-row"><text>{{ measureSamples.regular.text }}</text></view>
                    </view>
                    <view v-if="layoutReady">
                        <view v-for="nodeKey in visibleKeys" :key="nodeKey" :data-node-key="nodeKey"
                            class="virtual-node" :style="visibleNodes[nodeKey].style">
                            <view v-if="visibleNodes[nodeKey].role === 'group-header'" class="row group-row"
                                @click="toggleGroup(visibleNodes[nodeKey].groupId)">
                                <text>{{ visibleNodes[nodeKey].selected ? '✓ ' : '○ ' }}{{ visibleNodes[nodeKey].data.text }}</text>
                            </view>
                            <view v-else class="row" :class="visibleNodes[nodeKey].rowClass" @click="toggleRow(visibleNodes[nodeKey].key)">
                                <text>{{ visibleNodes[nodeKey].selected ? '✓ ' : '○ ' }}{{ visibleNodes[nodeKey].data.text }}</text>
                            </view>
                        </view>
                    </view>
                </view>
                <view :style="tailStyle"></view>
            </scroll-view>
            <view v-if="layoutReady && stickyVisible && stickyGroup" class="sticky-copy row group-row" @click="toggleGroup(stickyGroup.groupId)">
                <text>{{ isGroupSelected(stickyGroup.groupId) ? '✓ ' : '○ ' }}{{ stickyGroup.data.text }}</text>
            </view>
        </view>
    </view>
</template>

<script>
import { createVirtualListController } from './virtual-list-controller.js';
import { buildKeyedWindow, createUniListAdapter, readScrollViewLayout, readScrollViewOffset } from './uni-list-adapter.js';
import { createScrollViewSync } from './scroll-view-sync.js';

// Synthetic data only. Each type has a fixed CSS height; text never determines height.
const makeGroups = () => Array.from({ length: 6 }, (_, groupIndex) => {
    const key = `synthetic-group-${groupIndex + 1}`;
    return {
        key, text: `分组 ${groupIndex + 1}`,
        items: Array.from({ length: groupIndex === 5 ? 2 : 60 }, (_, index) => ({
            key: `${key}-item-${index + 1}`,
            type: index % 2 ? 'regular' : 'compact',
            data: { text: `合成条目 ${groupIndex + 1} / ${index + 1}`, sequence: index + 1 },
        })),
    };
});

export default {
    data() {
        return {
            groups: [], visibleKeys: [], visibleNodes: {}, totalHeight: 0, tailHeight: 0,
            activeGroupId: null, stickyVisible: false, stickyGroup: null,
            selectedCount: 0, commandScrollTop: 0, filterPending: false,
            layoutReady: false, layoutError: '', measureSamples: null,
        };
    },
    computed: {
        listStyle() { return `height:${this.totalHeight}px;`; },
        tailStyle() { return `height:${this.tailHeight}px;`; },
    },
    created() {
        const syntheticGroups = makeGroups();
        this.groups = syntheticGroups.map(({ key, text }) => ({ key, text }));
        this.groupKeys = new Map(syntheticGroups.map((group) => [group.key, group.items.map((item) => item.key)]));
        this.selectedKeys = new Set();
        this.sourceNodes = [];
        syntheticGroups.forEach((group, index) => {
            this.sourceNodes.push({
                key: `${group.key}-header`, type: 'header', role: 'group-header',
                groupId: group.key, gapBefore: index === 0 ? 0 : 12, data: { text: group.text },
            });
            group.items.forEach((item) => this.sourceNodes.push({ ...item, groupId: group.key }));
        });
        this.allSourceNodes = this.sourceNodes;
        this.filterVersion = 0;
        this.jumpToken = 0;
        this.jumpTimer = null;
        this.jumpTarget = null;
        this.jumpInProgress = false;
        this.jumpFinishing = false;
        this.controller = createVirtualListController({
            mode: 'typed', bufferScreens: 3, throttleMs: 150,
            onUpdate: (snapshot) => {
                if (snapshot.visibleChanged) {
                    const window = buildKeyedWindow(snapshot.visibleList.map((node) => ({
                        ...node,
                        rowClass: node.type === 'compact' ? 'compact-row' : 'regular-row',
                        selected: node.role === 'group-header' ? this.isGroupSelected(node.groupId) : this.selectedKeys.has(node.key),
                    })));
                    this.visibleNodes = window.visibleNodes;
                    this.visibleKeys = window.visibleKeys;
                }
                this.totalHeight = snapshot.totalHeight;
                this.activeGroupId = snapshot.activeGroupId;
                this.stickyVisible = snapshot.stickyVisible;
                this.stickyGroup = snapshot.stickyGroup;
                this.updateTail();
            },
        });
        this.adapter = createUniListAdapter({
            controller: this.controller,
            nextTick: () => new Promise((resolve) => this.$nextTick(resolve)),
            getNodes: () => this.sourceNodes,
            getSample: () => ({
                // Synthetic representatives retain the declared CSS shapes even for empty data.
                header: this.sourceNodes.find((node) => node.type === 'header')?.data || { text: '合成组头' },
                compact: this.sourceNodes.find((node) => node.type === 'compact')?.data || { text: '合成紧凑条目' },
                regular: this.sourceNodes.find((node) => node.type === 'regular')?.data || { text: '合成标准条目' },
            }),
            onSample: (sample) => { this.measureSamples = sample; },
            readLayout: () => readScrollViewLayout({
                query: () => uni.createSelectorQuery(), scope: this,
                scrollSelector: '#example-scroll', listSelector: '#container-list',
                sampleSelectors: { header: '#sample-group', compact: '#sample-compact', regular: '#sample-regular' },
            }),
            onLayout: () => {
                this.layoutReady = true; this.layoutError = '';
                this.$nextTick(() => { this.scrollSync.reconcile(); });
            },
            onError: (error) => {
                this.layoutReady = false;
                this.layoutError = error ? '布局测量失败，请点击重新测量。' : '';
                if (error) {
                    this.visibleKeys = []; this.visibleNodes = {}; this.totalHeight = 0; this.tailHeight = 0;
                    this.stickyVisible = false; this.stickyGroup = null;
                }
            },
        });
        this.scrollSync = createScrollViewSync({
            readOffset: () => readScrollViewOffset({
                query: () => uni.createSelectorQuery(), scope: this, scrollSelector: '#example-scroll',
            }),
            applyOffset: (actual) => this.adapter.syncScroll(actual),
            isActive: () => this.layoutReady && this.adapter.isActive(),
            onError: () => { this.layoutError = '滚动位置校正失败，请重试或重新测量。'; },
        });
    },
    onShow() { this.adapter.onShow(); },
    onReady() { this.adapter.onReady(); },
    onResize() { this.cancelPending(); this.adapter.onResize(); },
    onHide() { this.cancelPending(); this.adapter.onHide(); },
    onUnload() { this.cancelPending(); this.scrollSync.dispose(); this.adapter.dispose(); },
    methods: {
        isGroupSelected(key) {
            const keys = this.groupKeys.get(key) || [];
            return keys.length > 0 && keys.every((itemKey) => this.selectedKeys.has(itemKey));
        },
        commitSelection() {
            this.selectedCount = this.selectedKeys.size;
            this.controller.refresh(this.adapter.getLocalScrollTop(), { force: true });
            if (this.stickyGroup) this.stickyGroup = { ...this.stickyGroup };
        },
        toggleRow(key) {
            if (this.selectedKeys.has(key)) this.selectedKeys.delete(key);
            else this.selectedKeys.add(key);
            this.commitSelection();
        },
        toggleGroup(key) {
            const checked = this.isGroupSelected(key);
            (this.groupKeys.get(key) || []).forEach((itemKey) => {
                if (checked) this.selectedKeys.delete(itemKey);
                else this.selectedKeys.add(itemKey);
            });
            this.commitSelection();
        },
        updateTail() {
            const layout = this.adapter && this.adapter.getLayout();
            const lastGroup = this.groups[this.groups.length - 1];
            const offset = lastGroup && this.controller.getGroupOffset(lastGroup.key);
            this.tailHeight = layout && offset != null
                ? Math.max(0, layout.metrics.viewportHeight - (this.totalHeight - offset)) : 0;
        },
        handleContainerScroll(event) {
            const top = Number(event.detail.scrollTop);
            this.adapter.handleScroll(top);
            this.scrollSync.schedule();
            if (this.jumpTarget !== null && Math.abs(top - this.jumpTarget) < 1) this.finishJump(this.jumpToken);
        },
        handleLowerEdge() {
            // Reconcile even when a host's pagination says noMore/loading.
            this.scrollSync.reconcile();
            // The synthetic example has no network pagination.
        },
        cancelPending() {
            this.filterVersion += 1;
            this.filterPending = false;
            this.scrollSync.cancel();
            this.cancelJump();
        },
        async applyFilter(onlyEven) {
            if (!this.layoutReady || !this.adapter.isActive()) return;
            const token = ++this.filterVersion;
            this.filterPending = true;
            this.cancelJump();
            // A real page also invalidates old requests and pauses load-more here.
            const reachedTop = await this.scrollSync.resetToTop({
                getBoundTop: () => this.commandScrollTop,
                setBoundTop: (value) => { this.commandScrollTop = value; },
                nextTick: () => new Promise((resolve) => this.$nextTick(resolve)),
            });
            if (token !== this.filterVersion || !this.adapter.isActive()) return;
            if (!reachedTop) { this.filterPending = false; return; }
            // Only now replace data/reset pagination/request page 1 in a host app.
            this.sourceNodes = this.allSourceNodes.filter((node) => node.role === 'group-header'
                || !onlyEven || node.data.sequence % 2 === 0);
            this.layoutError = '';
            this.adapter.refreshData();
            await new Promise((resolve) => this.$nextTick(resolve));
            if (token !== this.filterVersion || !this.adapter.isActive()) return;
            this.filterPending = false;
            this.scrollSync.reconcile();
        },
        cancelJump() {
            this.jumpToken += 1;
            clearTimeout(this.jumpTimer);
            this.jumpTimer = null;
            this.jumpFinishing = false;
            if (this.jumpInProgress) this.controller.endProgrammaticScroll(this.adapter.getLocalScrollTop());
            this.jumpTarget = null;
            this.jumpInProgress = false;
        },
        async jumpToGroup(groupId) {
            if (!this.layoutReady || this.filterPending || !this.adapter.isActive()) return;
            const offset = this.controller.getGroupOffset(groupId);
            const layout = this.adapter.getLayout();
            if (offset === null || !layout) return;
            this.cancelJump();
            this.scrollSync.cancel();
            const token = this.jumpToken;
            const target = Math.max(0, layout.listTop + offset);
            this.controller.beginProgrammaticScroll(groupId);
            this.jumpInProgress = true;
            this.jumpTarget = target;
            this.commandScrollTop = this.commandScrollTop === target ? target + 0.1 : target;
            // scroll-view has no portable pageScrollTo completion callback.
            // A reached target event or this bounded fallback reads the actual offset.
            this.jumpTimer = setTimeout(() => this.finishJump(token), 180);
        },
        async finishJump(token) {
            if (token !== this.jumpToken || this.jumpTarget === null || this.jumpFinishing || !this.adapter.isActive()) return;
            this.jumpFinishing = true;
            clearTimeout(this.jumpTimer);
            this.jumpTimer = null;
            try {
                const actual = await readScrollViewOffset({
                    query: () => uni.createSelectorQuery(), scope: this, scrollSelector: '#example-scroll',
                });
                if (token !== this.jumpToken || !this.adapter.isActive()) return;
                this.adapter.syncScroll(actual);
                this.controller.endProgrammaticScroll(this.adapter.getLocalScrollTop());
            } catch (error) {
                if (token !== this.jumpToken || !this.adapter.isActive()) return;
                this.controller.endProgrammaticScroll(this.adapter.getLocalScrollTop());
                this.layoutError = '未能读取滚动位置，请重新测量。';
            } finally {
                if (token === this.jumpToken) {
                    this.jumpTarget = null; this.jumpInProgress = false; this.jumpFinishing = false;
                }
            }
        },
        retryLayout() { this.cancelPending(); this.adapter.measure(); },
    },
};
</script>

<style scoped>
.example-page { padding: 16px; box-sizing: border-box; }
.title { display: block; font-size: 20px; font-weight: 600; }
.note { display: block; margin: 12px 0; color: #555; }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.tabs { width: 100%; margin-top: 12px; white-space: nowrap; }
.tab-content { display: inline-flex; gap: 8px; }
.active-tab { color: #174ca7; background: #e9f0ff; }
.status { min-height: 48px; display: flex; align-items: center; font-size: 13px; }
.scroll-shell { position: relative; width: 100%; }
.scroll-container { width: 100%; height: 420px; max-height: 65vh; }
.virtual-list { position: relative; width: 100%; }
.virtual-node { position: absolute; top: 0; left: 0; width: 100%; }
.row {
    width: 100%; box-sizing: border-box; padding: 0 12px; display: flex;
    align-items: center; overflow: hidden; white-space: nowrap; border-bottom: 1px solid #ddd;
}
.group-row { height: 48px; background: #e9f0ff; font-weight: 600; }
.compact-row { height: 40px; background: #fff; }
.regular-row { height: 64px; background: #f5f6f8; }
.sticky-copy { position: absolute; top: 0; left: 0; z-index: 2; }
.measurement {
    position: absolute; left: 0; bottom: 100%; width: 100%;
    visibility: hidden; pointer-events: none;
}
</style>
```
