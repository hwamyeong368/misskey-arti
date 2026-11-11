<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<PageWithHeader v-model:tab="tab" :actions="headerActions" :tabs="headerTabs" :swipable="true">
	<div class="_spacer" style="--MI_SPACER-w: 800px;">
		<div v-if="tab === 'all'">
			<MkStreamingNotificationsTimeline :class="$style.notifications" :excludeTypes="excludeTypes"/>
		</div>
		<div v-else-if="tab === 'mentions'">
			<MkNotesTimeline :paginator="mentionsPaginator"/>
		</div>
		<div v-else-if="tab === 'directNotes'">
			<MkNotesTimeline :paginator="directNotesPaginator"/>
		</div>
		<div v-else-if="tab === 'requests'">
			<!-- arti: notifications from people I neither follow nor am followed by -->
			<MkInfo style="margin-bottom: 12px;">{{ i18n.ts._notificationRequests.description }}</MkInfo>
			<MkPagination v-slot="{ items }" :paginator="requestsPaginator">
				<div class="_gaps">
					<div v-for="notification in items" :key="notification.id" class="_panel" :class="$style.request">
						<MkNote v-if="'note' in notification" :note="notification.note" :withHardMute="true"/>
						<div v-if="'user' in notification" :class="$style.requestActions">
							<MkButton small rounded @click="allowRequests(notification.user)"><i class="ti ti-check"></i> {{ i18n.ts._notificationRequests.allow }}</MkButton>
						</div>
					</div>
				</div>
			</MkPagination>
		</div>
	</div>
</PageWithHeader>
</template>

<script lang="ts" setup>
import { computed, markRaw, ref } from 'vue';
import { notificationTypes } from 'misskey-js';
import type { PageHeaderItem } from '@/types/page-header.js';
import MkStreamingNotificationsTimeline from '@/components/MkStreamingNotificationsTimeline.vue';
import MkNotesTimeline from '@/components/MkNotesTimeline.vue';
import MkPagination from '@/components/MkPagination.vue';
import MkNote from '@/components/MkNote.vue';
import MkButton from '@/components/MkButton.vue';
import MkInfo from '@/components/MkInfo.vue';
import { $i } from '@/i.js';
import * as os from '@/os.js';
import { i18n } from '@/i18n.js';
import { definePage } from '@/page.js';
import { Paginator } from '@/utility/paginator.js';

const tab = ref('all');
const includeTypes = ref<string[] | null>(null);
const excludeTypes = computed(() => includeTypes.value ? notificationTypes.filter(t => !includeTypes.value!.includes(t)) : null);

const mentionsPaginator = markRaw(new Paginator('notes/mentions', {
	limit: 10,
}));

const directNotesPaginator = markRaw(new Paginator('notes/mentions', {
	limit: 10,
	params: {
		visibility: 'specified',
	},
}));

// arti: notification requests
const requestsPaginator = markRaw(new Paginator('i/notification-requests/list', {
	limit: 10,
}));

function reloadRequests() {
	requestsPaginator.reload();
}

async function allowRequests(user: { id: string }) {
	await os.apiWithDialog('i/notification-requests/allow', { userId: user.id });
	reloadRequests();
}

async function clearRequests() {
	const { canceled } = await os.confirm({
		type: 'warning',
		text: i18n.ts._notificationRequests.clearConfirm,
	});
	if (canceled) return;
	await os.apiWithDialog('i/notification-requests/clear', {});
	reloadRequests();
}

function setFilter(ev: PointerEvent) {
	const typeItems = notificationTypes.map(t => ({
		text: i18n.ts._notification._types[t],
		active: (includeTypes.value && includeTypes.value.includes(t)) ?? false,
		action: () => {
			includeTypes.value = [t];
		},
	}));
	const items = includeTypes.value != null ? [{
		icon: 'ti ti-x',
		text: i18n.ts.clear,
		action: () => {
			includeTypes.value = null;
		},
	}, { type: 'divider' as const }, ...typeItems] : typeItems;
	os.popupMenu(items, ev.currentTarget ?? ev.target);
}

const headerActions = computed<PageHeaderItem[]>(() => ([tab.value === 'all' ? {
	text: i18n.ts.filter,
	icon: 'ti ti-filter',
	highlighted: includeTypes.value != null,
	handler: setFilter,
} : undefined, tab.value === 'all' ? {
	text: i18n.ts.markAllAsRead,
	icon: 'ti ti-check',
	handler: () => {
		os.apiWithDialog('notifications/mark-all-as-read', {});
	},
} : undefined, tab.value === 'requests' ? {
	text: i18n.ts._notificationRequests.clear,
	icon: 'ti ti-trash',
	handler: clearRequests,
} : undefined] as (PageHeaderItem | undefined)[]).filter(x => x !== undefined));

const headerTabs = computed(() => [{
	key: 'all',
	title: i18n.ts.all,
	icon: 'ti ti-point',
}, {
	key: 'mentions',
	title: i18n.ts.mentions,
	icon: 'ti ti-at',
}, {
	key: 'directNotes',
	title: i18n.ts.directNotes,
	icon: 'ti ti-mail',
}, ...($i?.notificationRequestsEnabled ? [{
	key: 'requests',
	title: i18n.ts._notificationRequests.title,
	icon: 'ti ti-user-question',
}] : [])]);

definePage(() => ({
	title: i18n.ts.notifications,
	icon: 'ti ti-bell',
}));
</script>

<style module lang="scss">
.notifications {
	border-radius: var(--MI-radius);
	overflow: clip;
}

.request {
	overflow: clip;
}

.requestActions {
	display: flex;
	justify-content: flex-end;
	padding: 8px 12px;
	border-top: solid 0.5px var(--MI_THEME-divider);
}
</style>
