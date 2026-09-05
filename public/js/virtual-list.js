class VirtualList {
    constructor(panel) {
        this.panel = panel;
        this.flow = panel.dataset.flow;
        this.viewport = panel.querySelector('[data-list]');
        this.canvas = panel.querySelector('[data-canvas]');
        this.columnsViewport = panel.querySelector('[data-columns-scroll]');
        this.count = panel.querySelector('[data-count]');
        this.viewport.addEventListener('scroll', () => this.onScroll());
        new ResizeObserver(() => this.render()).observe(this.viewport);
        this.pages = new Map();
        this.pending = new Map();
        this.total = null;
        this.canvas.replaceChildren(this.message('Выберите доступную схему'));
    }

    reset() {
        clearTimeout(this.scrollTimer);
        for (const pending of this.pending.values()) pending.controller.abort();
        this.pages.clear();
        this.pending.clear();
        this.total = null;
        this.version = requestVersion;
        this.viewport.scrollTop = 0;
        this.canvas.style.height = '';
        this.canvas.replaceChildren(this.message('Загрузка операций…'));
        this.count.textContent = '0';
        this.loadPage(0);
    }

    loadPage(page) {
        if (this.pages.has(page) || this.pending.has(page)) return;
        const version = this.version;
        const controller = new AbortController();
        let request;
        request = (async () => {
            const params = new URLSearchParams(appliedFilters);
            params.set('flow', this.flow);
            params.set('offset', page * PAGE_SIZE);
            params.set('limit', PAGE_SIZE);
            if (this.total === null) params.set('include_total', '1');
            const response = await fetchJson(`/api/actions?${params}`, { signal: controller.signal });
            if (version !== requestVersion) return;
            if (response.total !== null) {
                this.total = Number(response.total);
                this.count.textContent = this.total.toLocaleString('ru-RU');
                this.canvas.style.height = `${this.total * operationRowHeight()}px`;
            }
            this.pages.set(page, response.items);
            while (this.pages.size > MAX_CACHED_PAGES) this.pages.delete(this.pages.keys().next().value);
            this.render();
        })().catch(error => {
            if (error.name === 'AbortError') return;
            if (version !== requestVersion) return;
            this.canvas.replaceChildren(this.message(error.message, true));
        }).finally(() => {
            if (this.pending.get(page)?.request === request) this.pending.delete(page);
        });
        this.pending.set(page, { request, controller });
    }

    onScroll() {
        if (notePopover.matches(':popover-open')) notePopover.hidePopover();
        this.syncColumns();
        clearTimeout(this.scrollTimer);
        this.scrollTimer = setTimeout(() => this.render(), 120);
    }

    syncColumns() {
        this.columnsViewport.style.marginRight = `${this.viewport.offsetWidth - this.viewport.clientWidth}px`;
        this.columnsViewport.scrollLeft = this.viewport.scrollLeft;
    }

    render() {
        if (this.total === null) {
            this.loadPage(0);
            return;
        }
        if (this.total === 0) {
            this.canvas.replaceChildren(this.message('Операций не найдено'));
            return;
        }
        this.canvas.style.height = `${this.total * operationRowHeight()}px`;
        const rowHeight = operationRowHeight();
        const start = Math.max(0, Math.floor(this.viewport.scrollTop / rowHeight) - BUFFER);
        const visible = Math.ceil(this.viewport.clientHeight / rowHeight) + BUFFER * 2;
        const end = Math.min(this.total, start + visible);
        const firstPage = Math.floor(start / PAGE_SIZE);
        const lastPage = Math.floor((end - 1) / PAGE_SIZE);
        for (const [page, pending] of this.pending) {
            if (page < firstPage || page > lastPage) pending.controller.abort();
        }
        for (let page = firstPage; page <= lastPage; page++) this.loadPage(page);
        const fragment = document.createDocumentFragment();
        for (let index = start; index < end; index++) {
            const page = Math.floor(index / PAGE_SIZE);
            const items = this.pages.get(page);
            if (items) {
                this.pages.delete(page);
                this.pages.set(page, items);
                const item = items[index % PAGE_SIZE];
                if (item) fragment.append(this.row(item, index));
            }
        }
        if (!fragment.childNodes.length) fragment.append(this.message('Загрузка…', false, start));
        this.canvas.replaceChildren(fragment);
        this.syncColumns();
        this.enhanceNotes();
    }

    enhanceNotes() {
        for (const note of this.canvas.querySelectorAll('.operation-row__note')) {
            if (note.scrollWidth <= note.clientWidth) continue;
            note.classList.add('operation-row__note--truncated');
            note.tabIndex = 0;
            note.setAttribute('role', 'button');
            note.setAttribute('aria-label', 'Показать полное примечание');
            const open = () => showNote(note, note.fullText);
            note.addEventListener('click', event => {
                event.stopPropagation();
                open();
            });
            note.addEventListener('keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    open();
                }
            });
        }
    }

    row(item, index) {
        const row = document.createElement('article');
        row.className = 'operation-row' + (item.is_black ? ' operation-row--protected' : '');
        row.dataset.operationId = item.id;
        row.style.transform = `translateY(${index * operationRowHeight()}px)`;
        const operation = [item.direction, item.action_type].filter(Boolean).join(' → ') || 'Без направления';
        const suboperation = item.suboperation_placeholder
            ? `Неизвестно (ID: ${item.suboperation_id})`
            : [item.suboperation_l1, item.suboperation_l2].filter(Boolean).join(' · ');
        const hasNote = Boolean(item.memo?.trim());
        if (hasNote) row.classList.add('operation-row--has-note');
        row.innerHTML = `
            <button class="operation-row__date" type="button" aria-label="Редактировать операцию от ${formatDate(item.action_date)}">
                <time datetime="${escapeHtml(item.action_date)}">${formatDate(item.action_date)}</time>
            </button>
            <span class="operation-row__account">${escapeHtml(item.account)}<small>${escapeHtml(item.currency)}</small></span>
            <span class="operation-row__operation">${escapeHtml(operation)}</span>
            <span class="operation-row__suboperation">
                <span class="operation-row__suboperation-text">${escapeHtml(suboperation || '—')}</span>
                ${hasNote ? `<small class="operation-row__note">${escapeHtml(item.memo)}</small>` : ''}
            </span>
            <strong class="operation-row__amount">${item.amount == null ? '—' : money.format(item.amount)} <small>${escapeHtml(item.currency)}</small></strong>`;
        row.querySelector('.operation-row__account').title = item.account || '';
        row.querySelector('.operation-row__operation').title = operation;
        row.querySelector('.operation-row__suboperation').title = suboperation || '';
        if (hasNote) row.querySelector('.operation-row__note').fullText = item.memo;
        row.querySelector('.operation-row__date').addEventListener('click', event => {
            event.stopPropagation();
            openOperation(item);
        });
        if (!matchMedia('(max-width: 479px)').matches) row.addEventListener('dblclick', () => openOperation(item));
        return row;
    }

    message(text, error = false, index = 0) {
        const element = document.createElement('p');
        element.className = 'operation-panel__message' + (error ? ' operation-panel__message--error' : '');
        element.style.transform = `translateY(${index * operationRowHeight()}px)`;
        element.textContent = text;
        return element;
    }
}

function operationRowHeight() {
    return matchMedia('(max-width: 479px)').matches ? 128 : ROW_HEIGHT;
}
