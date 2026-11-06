// A visual layer over native selects: the original field remains the source of
// truth for FormData, validation and the application's input/change handlers.
let nextPickerId = 0;
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const normalize = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase().trim();
const restoreAttribute = (element, name, value) => value === null ? element.removeAttribute(name) : element.setAttribute(name, value);

export function createIconSelects({ root = document, describeOption = (_select, option) => ({ title: option.label }) } = {}) {
  const document = root.nodeType === 9 ? root : root.ownerDocument;
  const view = document.defaultView;
  const records = new Map();
  let opened = null;
  let destroyed = false;
  let refreshQueued = false;
  let positionFrame = 0;
  const contains = element => root === document ? document.documentElement.contains(element) : root.contains(element);

  function description(select, option) {
    const result = describeOption(select, option) || {};
    return { ...result, title: String(result.title ?? option.label), subtitle: String(result.subtitle ?? ''), badge: String(result.badge ?? '') };
  }

  function optionContent(item) {
    return `<span class="icon-select-art" aria-hidden="true">${item.iconHtml || ''}</span><span class="icon-select-text"><span class="icon-select-title">${escapeHtml(item.title)}</span>${item.subtitle ? `<span class="icon-select-subtitle">${escapeHtml(item.subtitle)}</span>` : ''}</span>${item.badge ? `<span class="icon-select-badge">${escapeHtml(item.badge)}</span>` : ''}`;
  }

  function accessibleLabel(record) {
    const { select, trigger, value } = record;
    const labels = [...select.labels || []];
    for (let index = 0; index < labels.length; index++) {
      if (!labels[index].id) {
        const id = `${record.id}-label-${index}`;
        labels[index].id = id;
        record.addedLabelIds.set(labels[index], id);
      }
    }
    const labelledBy = select.getAttribute('aria-labelledby') || labels.map(label => label.id).join(' ');
    const label = select.getAttribute('aria-label') || labels.map(item => item.textContent.trim()).join(' ') || select.getAttribute('title') || '选择选项';
    if (labelledBy) {
      trigger.setAttribute('aria-labelledby', `${labelledBy} ${value.id}`);
      trigger.removeAttribute('aria-label');
      trigger.removeAttribute('aria-describedby');
    } else {
      trigger.removeAttribute('aria-labelledby');
      trigger.setAttribute('aria-label', label);
      trigger.setAttribute('aria-describedby', value.id);
    }
    record.list.setAttribute('aria-label', label);
    record.search.setAttribute('aria-label', `搜索${label}`);
    record.search.placeholder = `搜索${label}`;
  }

  function selectedIndex(record) {
    return record.visible.findIndex(entry => entry.index === record.select.selectedIndex && !entry.disabled);
  }

  function activate(record, index, scroll = true) {
    record.activeIndex = index;
    const active = record.visible[index];
    for (const button of record.list.querySelectorAll('.icon-select-option')) {
      button.classList.toggle('is-active', Boolean(active && Number(button.dataset.index) === active.index));
    }
    if (active) {
      const id = `${record.id}-option-${active.index}`;
      record.trigger.setAttribute('aria-activedescendant', id);
      record.search.setAttribute('aria-activedescendant', id);
      if (scroll) {
        // Scrolling the row itself can also move the underlying modal, even
        // though this popover is in the top layer. Only scroll the option list.
        const button = document.getElementById(id);
        if (button) {
          const itemBounds = button.getBoundingClientRect();
          const listBounds = record.list.getBoundingClientRect();
          if (itemBounds.top < listBounds.top) record.list.scrollTop -= listBounds.top - itemBounds.top;
          else if (itemBounds.bottom > listBounds.bottom) record.list.scrollTop += itemBounds.bottom - listBounds.bottom;
        }
      }
    } else {
      record.trigger.removeAttribute('aria-activedescendant');
      record.search.removeAttribute('aria-activedescendant');
    }
  }

  function renderOptions(record, keepActive = false) {
    const previous = keepActive ? record.visible[record.activeIndex]?.option : null;
    const query = normalize(record.search.value);
    record.visible = record.entries.filter(entry => !entry.hidden && (!query || entry.search.includes(query)));
    record.list.innerHTML = record.visible.length ? record.visible.map(entry => `<button type="button" class="icon-select-option" id="${record.id}-option-${entry.index}" role="option" tabindex="-1" data-index="${entry.index}" data-value="${escapeHtml(entry.option.value)}" aria-selected="${entry.index === record.select.selectedIndex}"${entry.disabled ? ' disabled aria-disabled="true"' : ''}>${optionContent(entry.description)}<span class="icon-select-check" aria-hidden="true">${entry.index === record.select.selectedIndex ? '✓' : ''}</span></button>`).join('') : '<div class="icon-select-empty" role="status">没有找到匹配项，换个关键词试试</div>';
    let index = previous ? record.visible.findIndex(entry => entry.option === previous && !entry.disabled) : -1;
    if (index < 0) index = selectedIndex(record);
    if (index < 0) index = record.visible.findIndex(entry => !entry.disabled);
    activate(record, index, false);
    if (opened === record) schedulePosition();
  }

  function sync(record) {
    const { select, trigger, wrapper } = record;
    record.entries = [...select.options].map((option, index) => {
      const item = description(select, option);
      return { option, index, description: item, disabled: option.disabled || Boolean(option.closest('optgroup')?.disabled), hidden: option.hidden || Boolean(option.closest('optgroup')?.hidden), search: normalize([item.title, item.subtitle, item.badge, item.searchText, option.label].filter(Boolean).join(' ')) };
    });
    const selected = record.entries[select.selectedIndex]?.description || { title: '请选择', iconHtml: '', subtitle: '', badge: '' };
    const html = optionContent(selected);
    if (record.valueHtml !== html) { record.value.innerHTML = html; record.valueHtml = html; }
    trigger.title = [selected.title, selected.subtitle, selected.badge].filter(Boolean).join(' · ');
    trigger.disabled = select.matches(':disabled');
    trigger.setAttribute('aria-required', String(select.required));
    if (select.validity.valid) trigger.removeAttribute('aria-invalid');
    wrapper.hidden = select.hidden;
    wrapper.classList.toggle('icon-select--filter', select.classList.contains('filter-select'));
    accessibleLabel(record);
    const signature = JSON.stringify(record.entries.map(entry => [entry.option.value, entry.description, entry.disabled, entry.hidden])) + ':' + select.selectedIndex;
    const searchable = record.entries.filter(entry => !entry.hidden).length > 6;
    record.search.hidden = !searchable;
    record.popover.classList.toggle('has-search', searchable);
    if (opened === record && (trigger.disabled || select.hidden || !contains(select))) close();
    else if (opened === record && signature !== record.signature) renderOptions(record, true);
    record.signature = signature;
  }

  function enhance(select) {
    if (records.has(select) || select.multiple || select.size > 1 || select.hasAttribute('data-native-select')) return;
    const id = `icon-picker-${++nextPickerId}`;
    const wrapper = document.createElement('div');
    wrapper.className = 'icon-select';
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'icon-select-trigger';
    trigger.setAttribute('role', 'combobox');
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', `${id}-list`);
    const value = document.createElement('span');
    value.className = 'icon-select-value';
    value.id = `${id}-value`;
    const chevron = document.createElement('span');
    chevron.className = 'icon-select-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    trigger.append(value, chevron);
    const popover = document.createElement('div');
    popover.className = 'icon-select-popover';
    popover.setAttribute('popover', 'manual');
    popover.hidden = true;
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'icon-select-search';
    search.autocomplete = 'off';
    search.spellcheck = false;
    search.setAttribute('role', 'searchbox');
    search.setAttribute('aria-controls', `${id}-list`);
    const list = document.createElement('div');
    list.className = 'icon-select-list';
    list.id = `${id}-list`;
    list.setAttribute('role', 'listbox');
    popover.append(search, list);
    const record = { id, select, wrapper, trigger, value, popover, search, list, entries: [], visible: [], activeIndex: -1, addedLabelIds: new Map(), originalTabindex: select.getAttribute('tabindex'), originalAriaHidden: select.getAttribute('aria-hidden'), hadClass: select.classList.contains('icon-select-native') };
    records.set(select, record);
    select.before(wrapper);
    wrapper.append(select, trigger, popover);
    select.classList.add('icon-select-native');
    select.setAttribute('tabindex', '-1');
    select.setAttribute('aria-hidden', 'true');
    sync(record);
  }

  function release(record, unwrap = false) {
    if (opened === record) close(false);
    records.delete(record.select);
    if (unwrap) {
      restoreAttribute(record.select, 'tabindex', record.originalTabindex);
      restoreAttribute(record.select, 'aria-hidden', record.originalAriaHidden);
      if (!record.hadClass) record.select.classList.remove('icon-select-native');
      if (record.select.parentElement === record.wrapper) record.wrapper.replaceWith(record.select);
      else record.wrapper.remove();
      for (const [label, id] of record.addedLabelIds) if (label.id === id) label.removeAttribute('id');
    }
  }

  function refresh(scope = root) {
    if (destroyed) return;
    for (const record of records.values()) if (!contains(record.select)) release(record);
    if (scope.matches?.('select')) enhance(scope);
    for (const select of scope.querySelectorAll?.('select') || []) enhance(select);
    for (const record of records.values()) if (scope === root || scope === record.select || scope.contains(record.select)) sync(record);
  }

  function queueRefresh() {
    if (refreshQueued || destroyed) return;
    refreshQueued = true;
    queueMicrotask(() => { refreshQueued = false; refresh(); });
  }

  function position(record) {
    if (opened !== record || !contains(record.trigger)) return;
    const anchor = record.trigger.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = view.innerHeight;
    if (!anchor.width || !anchor.height || anchor.bottom <= 0 || anchor.top >= viewportHeight) { close(false); return; }
    const gutter = 10;
    const gap = 6;
    const below = viewportHeight - anchor.bottom - gutter - gap;
    const above = anchor.top - gutter - gap;
    const upwards = below < 220 && above > below;
    const available = Math.max(40, upwards ? above : below);
    const width = Math.max(0, Math.min(Math.max(anchor.width, 300), viewportWidth - gutter * 2));
    const left = Math.max(gutter, Math.min(anchor.left, viewportWidth - gutter - width));
    Object.assign(record.popover.style, { position: 'fixed', margin: '0', inset: 'auto', width: `${width}px`, maxHeight: `${available}px`, left: `${left}px`, top: `${Math.max(gutter, anchor.bottom + gap)}px` });
    const surfaceStyle = view.getComputedStyle(record.popover);
    const searchStyle = view.getComputedStyle(record.search);
    const verticalChrome = ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'].reduce((sum, property) => sum + (parseFloat(surfaceStyle[property]) || 0), 0);
    const searchHeight = record.search.hidden ? 0 : record.search.getBoundingClientRect().height + (parseFloat(searchStyle.marginTop) || 0) + (parseFloat(searchStyle.marginBottom) || 0);
    record.list.style.maxHeight = `${Math.max(0, Math.min(320, available - verticalChrome - searchHeight))}px`;
    const height = record.popover.getBoundingClientRect().height;
    record.popover.style.top = `${upwards ? Math.max(gutter, anchor.top - gap - height) : Math.min(anchor.bottom + gap, viewportHeight - gutter - height)}px`;
    record.popover.dataset.placement = upwards ? 'above' : 'below';
  }

  function schedulePosition() {
    if (!opened || positionFrame) return;
    positionFrame = view.requestAnimationFrame(() => { positionFrame = 0; if (opened) position(opened); });
  }

  function open(record, initialQuery = '') {
    if (destroyed || record.trigger.disabled || record.select.hidden) return;
    if (opened && opened !== record) close(false);
    sync(record);
    opened = record;
    record.search.value = initialQuery;
    renderOptions(record);
    record.popover.hidden = false;
    if (typeof record.popover.showPopover === 'function' && !record.popover.matches(':popover-open')) record.popover.showPopover();
    record.trigger.setAttribute('aria-expanded', 'true');
    record.wrapper.classList.add('is-open');
    position(record);
    if (opened !== record) return;
    (record.search.hidden ? record.trigger : record.search).focus({ preventScroll: true });
    activate(record, record.activeIndex);
  }

  function close(restoreFocus = true) {
    if (!opened) return;
    const record = opened;
    opened = null;
    const hadFocus = record.wrapper.contains(document.activeElement);
    if (typeof record.popover.hidePopover === 'function' && record.popover.matches(':popover-open')) record.popover.hidePopover();
    record.popover.hidden = true;
    record.wrapper.classList.remove('is-open');
    record.trigger.setAttribute('aria-expanded', 'false');
    record.trigger.removeAttribute('aria-activedescendant');
    record.search.removeAttribute('aria-activedescendant');
    if (restoreFocus && hadFocus && contains(record.trigger) && !record.trigger.disabled) record.trigger.focus({ preventScroll: true });
  }

  function choose(record, index) {
    const entry = record.entries[index];
    if (!entry || entry.disabled || record.select.matches(':disabled')) return;
    const changed = record.select.selectedIndex !== index;
    record.select.selectedIndex = index;
    sync(record);
    close();
    if (changed) {
      record.select.dispatchEvent(new view.Event('input', { bubbles: true }));
      record.select.dispatchEvent(new view.Event('change', { bubbles: true }));
      queueRefresh();
    }
  }

  function recordFor(element) {
    const wrapper = element?.closest?.('.icon-select');
    return wrapper ? records.get(wrapper.querySelector(':scope > select')) : null;
  }

  function onClick(event) {
    const record = recordFor(event.target);
    if (record && event.target.closest('.icon-select-trigger')) {
      opened === record ? close() : open(record);
      return;
    }
    const option = event.target.closest?.('.icon-select-option');
    if (record && option) { choose(record, Number(option.dataset.index)); return; }
    const label = event.target.closest?.('label');
    const labelledRecord = label?.control ? records.get(label.control) : null;
    if (labelledRecord && event.target !== labelledRecord.trigger) {
      event.preventDefault();
      labelledRecord.trigger.focus();
      open(labelledRecord);
    }
  }

  function move(record, direction) {
    const enabled = record.visible.map((entry, index) => entry.disabled ? -1 : index).filter(index => index >= 0);
    if (!enabled.length) return;
    const current = enabled.indexOf(record.activeIndex);
    let index;
    if (direction === 'first') index = enabled[0];
    else if (direction === 'last') index = enabled.at(-1);
    else index = enabled[Math.max(0, Math.min(enabled.length - 1, current < 0 ? (direction > 0 ? 0 : enabled.length - 1) : current + direction))];
    activate(record, index);
  }

  function onKeydown(event) {
    if (event.isComposing || event.keyCode === 229) return;
    const record = recordFor(event.target);
    if (event.key === 'Escape' && opened) {
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
      return;
    }
    if (!record || record.trigger.disabled) return;
    const inSearch = event.target === record.search;
    if (event.key === 'Tab' && opened === record) { close(); return; }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      const wasOpen = opened === record;
      if (!wasOpen) open(record);
      if (wasOpen || event.key === 'Home' || event.key === 'End') move(record, event.key === 'Home' ? 'first' : event.key === 'End' ? 'last' : event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Enter' || (event.key === ' ' && !inSearch)) {
      event.preventDefault();
      event.stopPropagation();
      if (opened !== record) open(record);
      else if (record.activeIndex >= 0) choose(record, record.visible[record.activeIndex].index);
      return;
    }
    if (!inSearch && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      if (!record.search.hidden) {
        if (opened !== record) open(record, event.key);
        else { record.search.value += event.key; renderOptions(record); record.search.focus(); }
      } else {
        if (opened !== record) open(record);
        const now = Date.now();
        record.typeahead = (now - (record.typedAt || 0) < 700 ? record.typeahead || '' : '') + normalize(event.key);
        record.typedAt = now;
        const index = record.visible.findIndex(entry => !entry.disabled && entry.search.startsWith(record.typeahead));
        if (index >= 0) activate(record, index);
      }
    }
  }

  function onInput(event) {
    const record = recordFor(event.target);
    if (record && event.target === record.search) {
      if (!event.isComposing) renderOptions(record);
    } else if (records.has(event.target)) {
      sync(records.get(event.target));
      queueRefresh();
    }
  }

  function onCompositionEnd(event) {
    const record = recordFor(event.target);
    if (record && event.target === record.search) renderOptions(record);
  }

  function onPointerDown(event) {
    if (opened && !opened.wrapper.contains(event.target)) close(false);
  }

  function onFocus(event) {
    if (records.has(event.target)) records.get(event.target).trigger.focus({ preventScroll: true });
    else if (opened && !opened.wrapper.contains(event.target)) close(false);
  }

  function onInvalid(event) {
    const record = records.get(event.target);
    if (!record) return;
    event.preventDefault();
    record.trigger.setAttribute('aria-invalid', 'true');
    record.trigger.focus();
    open(record);
  }

  const observer = new view.MutationObserver(mutations => {
    for (const mutation of mutations) {
      if (mutation.target.matches?.('select, option, optgroup, fieldset') || mutation.target.closest?.('select')) { queueRefresh(); return; }
      if (mutation.type === 'childList' && [...mutation.addedNodes, ...mutation.removedNodes].some(node => node.nodeType === 1 && (node.matches('select') || node.querySelector('select')))) { queueRefresh(); return; }
    }
  });
  const events = [['click', onClick, false], ['keydown', onKeydown, true], ['input', onInput, true], ['change', onInput, true], ['compositionend', onCompositionEnd, true], ['pointerdown', onPointerDown, true], ['focusin', onFocus, true], ['invalid', onInvalid, true]];
  for (const [event, listener, capture] of events) document.addEventListener(event, listener, capture);
  view.addEventListener('resize', schedulePosition);
  view.addEventListener('scroll', schedulePosition, true);
  observer.observe(root === document ? document.documentElement : root, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'hidden', 'required', 'aria-label', 'aria-labelledby', 'class', 'selected', 'value', 'label'] });
  refresh();

  return {
    refresh,
    close,
    destroy() {
      destroyed = true;
      close(false);
      observer.disconnect();
      if (positionFrame) view.cancelAnimationFrame(positionFrame);
      for (const [event, listener, capture] of events) document.removeEventListener(event, listener, capture);
      view.removeEventListener('resize', schedulePosition);
      view.removeEventListener('scroll', schedulePosition, true);
      for (const record of [...records.values()]) release(record, true);
    },
  };
}
