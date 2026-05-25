import { App, Plugin, PluginSettingTab, Setting, requestUrl } from 'obsidian';

interface GemStat {
  label: string;
  value: string;
}

interface AttrRange {
  min: number;
  max: number;
}

interface GemData {
  name: string;
  tags: string[];
  description: string;
  stats: GemStat[];
  iconUrl: string;
  tier: number | null;
  isSupport: boolean;
  requiresLevel: number;
  attributes: {
    str?: AttrRange;
    int?: AttrRange;
    dex?: AttrRange;
  };
  modifiers?: string[];
}

interface CacheEntry {
  data: GemData;
  fetchedAt: number;
}

interface PersistedCache {
  [url: string]: CacheEntry;
}

interface PrefetchItem {
  url: string;
  link: HTMLAnchorElement;
}

interface PluginSettings {
  cacheTtlDays: number;
  prefetchDelayMs: number;
  showInlineIcon: boolean;
  inlineIconSize: number;
  hideExternalLinkIcon: boolean;
  preventLinkWrap: boolean;
}

interface PluginData {
  cacheVersion?: number;
  settings: PluginSettings;
  cache: PersistedCache;
}

const DEFAULT_SETTINGS: PluginSettings = {
  cacheTtlDays: 7,
  prefetchDelayMs: 250,
  showInlineIcon: true,
  inlineIconSize: 20,
  hideExternalLinkIcon: false,
  preventLinkWrap: false,
};

const WIKI_HOST = 'poe2wiki.net';
const WIKI_BASE = 'https://www.poe2wiki.net';
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// Increment when GemData shape changes — clears stale cache automatically
const CACHE_VERSION = 6;

const ROMAN = ['I', 'II', 'III', 'IV', 'V'];
const ROMAN_RE = /^(.+?)\s+(I{1,3}|IV|V)$/;
const TIERED_URL_RE = /\/wiki\/(.+?)_(I{1,3}|IV|V)(?:[?#].*)?$/;

function getParentUrl(url: string): string | null {
  const m = url.match(TIERED_URL_RE);
  if (!m) return null;
  return `${WIKI_BASE}/wiki/${m[1]}`;
}

function getAllTierUrls(name: string): { roman: string; url: string }[] {
  const m = name.match(ROMAN_RE);
  if (!m) return [];
  const base = m[1].replace(/ /g, '_');
  return ROMAN.map(r => ({ roman: r, url: `${WIKI_BASE}/wiki/${base}_${r}` }));
}

// Session-level memory cache; populated from disk on load
const gemCache = new Map<string, GemData | null>();

export default class Poe2WikiTooltipPlugin extends Plugin {
  settings: PluginSettings;
  private tooltip: HTMLElement;
  private hoverTimer: number | null = null;
  private hideTimer: number | null = null;
  private currentAnchor: HTMLAnchorElement | null = null;
  private inflight = new Map<string, Promise<GemData | null>>();
  private prefetchQueue: PrefetchItem[] = [];
  private queueRunning = false;

  async onload() {
    await this.loadPluginData();
    this.applyVisualSettings();
    this.addSettingTab(new Poe2WikiSettingTab(this.app, this));

    this.tooltip = document.body.createDiv({ cls: 'poe2db-tooltip' });
    this.tooltip.style.display = 'none';

    this.tooltip.addEventListener('mouseenter', () => {
      if (this.hideTimer !== null) {
        clearTimeout(this.hideTimer);
        this.hideTimer = null;
      }
    });
    this.tooltip.addEventListener('mouseleave', (evt) => {
      if ((evt as MouseEvent).relatedTarget !== this.currentAnchor) {
        this.hideTimer = window.setTimeout(() => this.hideTooltip(), 100);
      }
    });

    this.registerMarkdownPostProcessor((el) => {
      el.querySelectorAll<HTMLAnchorElement>(`a[href*="${WIKI_HOST}"]`).forEach(link => {
        link.addEventListener('mouseenter', (evt) => this.onLinkEnter(evt, link));
        link.addEventListener('mouseleave', (evt) => this.onLinkLeave(evt));
        this.enqueuePrefetch(link);
      });
    });
  }

  onunload() {
    this.tooltip.remove();
    document.body.classList.remove('poe2-icons-hidden');
    document.body.classList.remove('poe2-hide-external-icon');
    document.body.classList.remove('poe2-nowrap');
    document.body.style.removeProperty('--poe2-icon-size');
  }

  applyVisualSettings() {
    document.body.style.setProperty('--poe2-icon-size', `${this.settings.inlineIconSize}px`);
    document.body.classList.toggle('poe2-icons-hidden', !this.settings.showInlineIcon);
    document.body.classList.toggle('poe2-hide-external-icon', this.settings.hideExternalLinkIcon);
    document.body.classList.toggle('poe2-nowrap', this.settings.preventLinkWrap);
  }

  // --- Data persistence ---

  async loadPluginData() {
    const raw: PluginData = (await this.loadData()) ?? { settings: DEFAULT_SETTINGS, cache: {} };
    this.settings = Object.assign({}, DEFAULT_SETTINGS, raw.settings);
    // Discard cache if shape has changed
    const cache = raw.cacheVersion === CACHE_VERSION ? (raw.cache ?? {}) : {};
    this.loadCacheEntries(cache);
  }

  private loadCacheEntries(cache: PersistedCache) {
    const now = Date.now();
    const ttlMs = this.settings.cacheTtlDays * 24 * 60 * 60 * 1000;
    for (const [url, entry] of Object.entries(cache)) {
      if (now - entry.fetchedAt < ttlMs) {
        gemCache.set(url, entry.data);
      }
    }
  }

  async savePluginData() {
    const cache: PersistedCache = {};
    const now = Date.now();
    for (const [url, data] of gemCache.entries()) {
      if (data !== null) cache[url] = { data, fetchedAt: now };
    }
    await this.saveData({ cacheVersion: CACHE_VERSION, settings: this.settings, cache });
  }

  clearCache() {
    gemCache.clear();
    this.savePluginData();
  }

  // --- Prefetch queue ---

  private enqueuePrefetch(link: HTMLAnchorElement) {
    const url = link.href;
    if (gemCache.has(url)) {
      this.injectLinkIcon(link);
      return;
    }
    this.prefetchQueue.push({ url, link });
    this.runQueue();
  }

  private async runQueue() {
    if (this.queueRunning) return;
    this.queueRunning = true;
    while (this.prefetchQueue.length > 0) {
      const item = this.prefetchQueue.shift()!;
      if (!gemCache.has(item.url)) {
        await this.getGemData(item.url);
      }
      this.injectLinkIcon(item.link);
      if (this.prefetchQueue.length > 0) {
        await sleep(this.settings.prefetchDelayMs);
      }
    }
    this.queueRunning = false;
  }

  // --- Fetch ---

  private async getGemData(url: string): Promise<GemData | null> {
    if (gemCache.has(url)) return gemCache.get(url) ?? null;

    const parentUrl = getParentUrl(url);
    if (parentUrl) {
      if (this.inflight.has(parentUrl)) {
        await this.inflight.get(parentUrl);
        return gemCache.get(url) ?? null;
      }

      const promise = requestUrl({ url: parentUrl, headers: { 'User-Agent': BROWSER_UA } })
        .then(async r => {
          parseWikiPage(r.text, parentUrl);
          this.savePluginData();
          
          if (!gemCache.has(url)) {
            // Parent page did not contain this tiered gem (e.g. Rage or Bleed resource pages).
            // Fallback to fetching the specific tiered gem page directly!
            try {
              const r2 = await requestUrl({ url, headers: { 'User-Agent': BROWSER_UA } });
              const data = parseWikiPage(r2.text);
              gemCache.set(url, data);
              this.savePluginData();
            } catch (e2) {
              console.error('[poe2-wiki-tooltips] fallback fetch failed for:', url, e2);
              gemCache.set(url, null);
            }
          }
          return gemCache.get(url) ?? null;
        })
        .catch(async e => {
          console.error('[poe2-wiki-tooltips] fetch parent failed for:', parentUrl, e);
          // Fallback to fetching the specific tiered gem page directly!
          try {
            const r2 = await requestUrl({ url, headers: { 'User-Agent': BROWSER_UA } });
            const data = parseWikiPage(r2.text);
            gemCache.set(url, data);
            this.savePluginData();
            return data;
          } catch (e2) {
            console.error('[poe2-wiki-tooltips] fallback fetch failed for:', url, e2);
            gemCache.set(url, null);
            return null;
          }
        })
        .finally(() => this.inflight.delete(parentUrl));

      this.inflight.set(parentUrl, promise);
      return promise;
    }

    if (this.inflight.has(url)) return this.inflight.get(url)!;

    const promise = requestUrl({ url, headers: { 'User-Agent': BROWSER_UA } })
      .then(r => {
        const data = parseWikiPage(r.text);
        gemCache.set(url, data);
        this.savePluginData();
        if (data) this.prefetchSiblingTiers(data.name, url);
        return data;
      })
      .catch(e => {
        console.error('[poe2-wiki-tooltips] fetch failed for:', url, e);
        gemCache.set(url, null);
        return null;
      })
      .finally(() => this.inflight.delete(url));

    this.inflight.set(url, promise);
    return promise;
  }

  private prefetchSiblingTiers(name: string, currentUrl: string) {
    for (const { url } of getAllTierUrls(name)) {
      if (url !== currentUrl && !gemCache.has(url) && !this.inflight.has(url)) {
        this.getGemData(url);
      }
    }
  }

  // --- Icon injection ---

  private async injectLinkIcon(link: HTMLAnchorElement) {
    const data = await this.getGemData(link.href);
    if (!data?.iconUrl) return;
    if (link.querySelector('.poe2db-link-icon')) return;
    const img = createEl('img', {
      cls: 'poe2db-link-icon',
      attr: { src: data.iconUrl },
    });
    link.prepend(img);
  }

  // --- Hover ---

  private onLinkEnter(evt: MouseEvent, link: HTMLAnchorElement) {
    this.currentAnchor = link;
    if (this.hideTimer !== null) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }

    if (gemCache.has(link.href)) {
      const data = gemCache.get(link.href);
      if (data) {
        this.renderTooltip(data, link);
        this.prefetchSiblingTiers(data.name, link.href);
      }
      return;
    }

    this.showLoading(link);
    if (this.hoverTimer !== null) clearTimeout(this.hoverTimer);
    this.hoverTimer = window.setTimeout(async () => {
      const data = await this.getGemData(link.href);
      if (data) this.renderTooltip(data, link);
      else this.hideTooltip();
    }, 250);
  }

  private onLinkLeave(evt: MouseEvent) {
    if (this.hoverTimer !== null) {
      clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }
    if ((evt.relatedTarget as Node | null) === this.tooltip ||
        this.tooltip.contains(evt.relatedTarget as Node | null)) return;
    this.hideTimer = window.setTimeout(() => this.hideTooltip(), 100);
  }

  private hideTooltip() {
    this.tooltip.style.display = 'none';
    this.tooltip.empty();
  }

  private showLoading(anchor: HTMLAnchorElement) {
    this.tooltip.empty();
    this.tooltip.createSpan({ text: 'Loading…', cls: 'poe2db-loading' });
    this.positionTooltip(anchor);
    this.tooltip.style.display = 'block';
  }

  private renderTooltip(data: GemData, anchor: HTMLAnchorElement) {
    this.tooltip.empty();

    // Header: icon + name + tier switcher
    const header = this.tooltip.createDiv({ cls: 'poe2db-header' });
    if (data.iconUrl) {
      header.createEl('img', { cls: 'poe2db-icon', attr: { src: data.iconUrl, width: '18', height: '18' } });
    }
    header.createSpan({ text: data.name, cls: 'poe2db-name' });

    const m = data.name.match(ROMAN_RE);
    const activeRoman = m ? m[2] : '';

    const tiers = getAllTierUrls(data.name);
    if (tiers.length > 0) {
      const switcher = header.createDiv({ cls: 'poe2db-tier-switcher' });
      for (const { roman, url } of tiers) {
        const cached = gemCache.get(url);
        if (cached === undefined || cached === null) continue; // skip if not cached or doesn't exist
        const isActive = roman === activeRoman;
        const btn = switcher.createEl('button', {
          text: roman,
          cls: ['poe2db-tier-btn', ...(isActive ? ['poe2db-tier-btn--active'] : [])],
        });
        if (!isActive) {
          btn.addEventListener('click', () => {
            this.currentAnchor = anchor;
            this.renderTooltip(cached, anchor);
          });
        }
      }
    }

    // Tags
    if (data.tags.length > 0) {
      const tagsEl = this.tooltip.createDiv({ cls: 'poe2db-tags' });
      data.tags.forEach(tag => tagsEl.createSpan({ text: tag, cls: 'poe2db-tag' }));
    }

    // Gem meta: tier, requires level, attributes
    const hasMeta = data.tier !== null || data.requiresLevel > 0 ||
      data.attributes.str || data.attributes.int || data.attributes.dex;
    if (hasMeta) {
      const meta = this.tooltip.createDiv({ cls: 'poe2db-gem-meta' });

      if (data.tier !== null) {
        const gemType = data.isSupport ? 'Support' : 'Skill';
        meta.createSpan({ text: `Tier ${data.tier} Uncut ${gemType} Gem`, cls: 'poe2db-tier' });
      }

      if (data.requiresLevel > 0) {
        meta.createSpan({ text: `Requires Level ${data.requiresLevel}`, cls: 'poe2db-req-level' });
      }

      const { str, int, dex } = data.attributes;
      if (str) meta.createSpan({ text: `Str: ${str.min === str.max ? str.min : `${str.min}–${str.max}`}`, cls: 'poe2db-attr-str' });
      if (int) meta.createSpan({ text: `Int: ${int.min === int.max ? int.min : `${int.min}–${int.max}`}`, cls: 'poe2db-attr-int' });
      if (dex) meta.createSpan({ text: `Dex: ${dex.min === dex.max ? dex.min : `${dex.min}–${dex.max}`}`, cls: 'poe2db-attr-dex' });
    }

    // Description
    if (data.description) {
      this.tooltip.createDiv({ text: data.description, cls: 'poe2db-desc' });
    }

    // Stats
    if (data.stats.length > 0) {
      const statsEl = this.tooltip.createDiv({ cls: 'poe2db-stats' });
      data.stats.forEach(({ label, value }) => {
        const row = statsEl.createDiv({ cls: 'poe2db-stat-row' });
        row.createSpan({ text: label, cls: 'poe2db-stat-label' });
        row.createSpan({ text: value, cls: 'poe2db-stat-value' });
      });
    }

    // Modifiers / Effects (magic stats in blue)
    if (data.modifiers && data.modifiers.length > 0) {
      const modsEl = this.tooltip.createDiv({ cls: 'poe2db-mods' });
      data.modifiers.forEach(mod => {
        modsEl.createDiv({ text: mod, cls: 'poe2db-mod-row' });
      });
    }

    this.positionTooltip(anchor);
    this.tooltip.style.display = 'block';
  }

  private positionTooltip(anchor: HTMLAnchorElement) {
    const rect = anchor.getBoundingClientRect();
    const tooltipWidth = 320;
    const gap = 8;
    let left = rect.left;
    let top = rect.bottom + gap;
    if (left + tooltipWidth > window.innerWidth - gap) left = window.innerWidth - tooltipWidth - gap;
    const estimatedHeight = 260;
    if (top + estimatedHeight > window.innerHeight) top = rect.top - estimatedHeight - gap;
    this.tooltip.style.left = `${Math.max(gap, left)}px`;
    this.tooltip.style.top = `${Math.max(gap, top)}px`;
  }
}

class Poe2WikiSettingTab extends PluginSettingTab {
  plugin: Poe2WikiTooltipPlugin;

  constructor(app: App, plugin: Poe2WikiTooltipPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Cache duration')
      .setDesc('How many days to keep gem data cached before re-fetching from the wiki.')
      .addSlider(slider => slider
        .setLimits(1, 30, 1)
        .setValue(this.plugin.settings.cacheTtlDays)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.cacheTtlDays = value;
          await this.plugin.savePluginData();
        }));

    new Setting(containerEl)
      .setName('Prefetch delay')
      .setDesc('Milliseconds to wait between prefetch requests when a note opens. Higher values are more polite to the wiki server.')
      .addSlider(slider => slider
        .setLimits(0, 1000, 50)
        .setValue(this.plugin.settings.prefetchDelayMs)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.prefetchDelayMs = value;
          await this.plugin.savePluginData();
        }));

    new Setting(containerEl)
      .setName('Show inline icon')
      .setDesc('Display the gem icon next to each poe2wiki.net link in your notes.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showInlineIcon)
        .onChange(async (value) => {
          this.plugin.settings.showInlineIcon = value;
          this.plugin.applyVisualSettings();
          await this.plugin.savePluginData();
        }));

    new Setting(containerEl)
      .setName('Inline icon size')
      .setDesc('Size of the gem icon displayed next to links, in pixels.')
      .addSlider(slider => slider
        .setLimits(12, 40, 2)
        .setValue(this.plugin.settings.inlineIconSize)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.inlineIconSize = value;
          this.plugin.applyVisualSettings();
          await this.plugin.savePluginData();
        }));

    new Setting(containerEl)
      .setName('Keep icon and text on same line')
      .setDesc('Prevent the gem icon from wrapping to a different line than the link text.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.preventLinkWrap)
        .onChange(async (value) => {
          this.plugin.settings.preventLinkWrap = value;
          this.plugin.applyVisualSettings();
          await this.plugin.savePluginData();
        }));

    new Setting(containerEl)
      .setName('Hide external link indicator')
      .setDesc('Remove the arrow icon Obsidian appends to external links on poe2wiki.net URLs.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.hideExternalLinkIcon)
        .onChange(async (value) => {
          this.plugin.settings.hideExternalLinkIcon = value;
          this.plugin.applyVisualSettings();
          await this.plugin.savePluginData();
        }));

    new Setting(containerEl)
      .setName('Clear cache')
      .setDesc('Delete all locally cached gem data. The wiki will be re-fetched on next hover or note open.')
      .addButton(btn => btn
        .setButtonText('Clear cache')
        .setWarning()
        .onClick(() => {
          this.plugin.clearCache();
          btn.setButtonText('Cleared!');
          setTimeout(() => btn.setButtonText('Clear cache'), 2000);
        }));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseProgressionTable(doc: Document): {
  requiresLevel: number;
  attributes: { str?: AttrRange; int?: AttrRange; dex?: AttrRange };
} {
  const table = doc.querySelector('table.skill-progression-table');
  if (!table) return { requiresLevel: 0, attributes: {} };

  const headers: string[] = [];
  table.querySelectorAll('tr:first-child th').forEach(th => {
    const title = th.querySelector('abbr')?.getAttribute('title') ?? th.textContent?.trim() ?? '';
    headers.push(title.toLowerCase());
  });

  // Filter to data rows only (exclude header rows that use <th> instead of <td>)
  const rows = Array.from(table.querySelectorAll('tbody tr')).filter(r => r.querySelector('td'));
  if (rows.length === 0) return { requiresLevel: 0, attributes: {} };

  const getCells = (row: Element) =>
    Array.from(row.querySelectorAll('td')).map(td => td.textContent?.trim() ?? '');

  const firstRow = getCells(rows[0]);
  const lastRow = getCells(rows[rows.length - 1]);

  const colIdx = (term: string) => headers.findIndex(h => h.includes(term));
  const num = (val: string | undefined) => parseInt((val ?? '').replace(/[^\d]/g, '')) || 0;

  const attrRange = (idx: number): AttrRange | undefined => {
    if (idx < 0) return undefined;
    const min = num(firstRow[idx]);
    const max = num(lastRow[idx]);
    if (max === 0) return undefined;
    return { min, max };
  };

  const reqLevelIdx = colIdx('required level');
  const requiresLevel = reqLevelIdx >= 0 ? num(firstRow[reqLevelIdx]) : 0;

  return {
    requiresLevel,
    attributes: {
      str: attrRange(colIdx('strength')),
      int: attrRange(colIdx('intelligence')),
      dex: attrRange(colIdx('dexterity')),
    },
  };
}

function parseGemElement(doc: Document, itemBox: Element, container?: Element): GemData | null {
  const name = itemBox.querySelector('.header.-single')?.textContent?.trim() ?? '';

  const firstGroup = itemBox.querySelector('.item-stats > .group');
  const tags = Array.from(firstGroup?.querySelectorAll('a') ?? [])
    .map(a => a.textContent?.trim() ?? '')
    .filter(Boolean);

  const isSupport = tags.includes('Support') || tags.includes('Spirit');

  // Parse stat lines from all non-special groups
  let tier: number | null = null;
  const stats: GemStat[] = [];
  const attributes: { str?: AttrRange; int?: AttrRange; dex?: AttrRange } = {};

  itemBox.querySelectorAll('.item-stats > .group:not(.tc.-gemdesc):not(.tc.-mod):not(.tc.-help)').forEach(group => {
    const tmp = doc.createElement('span');
    group.innerHTML.split(/<br\s*\/?>/i).forEach(line => {
      tmp.innerHTML = line;
      const text = tmp.textContent?.trim() ?? '';
      const colon = text.indexOf(':');
      if (colon === -1) return;
      const label = text.slice(0, colon).trim();
      const value = text.slice(colon + 1).trim();
      if (!label || !value) return;
      if (label === 'Tier') {
        tier = parseInt(value) || null;
      } else if (label === 'Level') {
        // skip — gem level range, not useful in tooltip
      } else if (label === 'Support Requirements') {
        // e.g. "+5 Dex", "+5 Str, +5 Dex", etc.
        const reqs = value.split(',');
        reqs.forEach(req => {
          const match = req.trim().match(/^\+(\d+)\s+(Str|Dex|Int)$/i);
          if (match) {
            const val = parseInt(match[1]);
            const attr = match[2].toLowerCase() as 'str' | 'dex' | 'int';
            attributes[attr] = { min: val, max: val };
          }
        });
      } else {
        stats.push({ label, value });
      }
    });
  });

  const description = itemBox.querySelector('.tc.-gemdesc')?.textContent?.trim() ?? '';

  // Parse modifier lines (magic support gem effects) from .group.tc.-mod
  const modifiers: string[] = [];
  itemBox.querySelectorAll('.group.tc.-mod').forEach(group => {
    const tmp = doc.createElement('span');
    group.innerHTML.split(/<br\s*\/?>/i).forEach(line => {
      tmp.innerHTML = line;
      const text = tmp.textContent?.trim();
      if (text) modifiers.push(text);
    });
  });

  // Try to find the high-quality item icon first, then fall back to generic image
  const imgEl = (container ?? itemBox).querySelector('.item-icon img') ?? (container ?? itemBox).querySelector('img');
  const iconSrc = imgEl?.getAttribute('src') ?? '';
  const iconUrl = iconSrc ? WIKI_BASE + iconSrc : '';

  const { requiresLevel, attributes: progAttributes } = isSupport
    ? { requiresLevel: 0, attributes: {} }
    : parseProgressionTable(doc);

  const finalAttributes = Object.assign({}, progAttributes, attributes);

  return {
    name,
    tags,
    description,
    stats,
    iconUrl,
    tier,
    isSupport,
    requiresLevel,
    attributes: finalAttributes,
    modifiers,
  };
}

function parseWikiPage(html: string, pageUrl?: string): GemData | null {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  // If there is a top-level main gem infobox (not inside a hoverbox), parse it as a single page!
  const mainItemBox = doc.querySelector('.item-box.-gem:not(.hoverbox *):not(.c-item-hoverbox *)');
  if (mainItemBox) {
    return parseGemElement(doc, mainItemBox, mainItemBox.parentElement ?? doc.body);
  }

  // Otherwise, check if this is a parent/disambiguation page containing multiple hoverboxes
  const hoverboxes = doc.querySelectorAll('.hoverbox, .c-item-hoverbox');
  if (hoverboxes.length > 0) {
    let targetData: GemData | null = null;
    hoverboxes.forEach(box => {
      const link = box.querySelector('.hoverbox__activator a, .c-item-hoverbox__activator a');
      const href = link?.getAttribute('href');
      if (!href) return;
      
      const fullUrl = WIKI_BASE + href;
      const itemBox = box.querySelector('.item-box.-gem');
      if (itemBox) {
        const data = parseGemElement(doc, itemBox, box);
        if (data) {
          gemCache.set(fullUrl, data);
          if (fullUrl === pageUrl) {
            targetData = data;
          }
        }
      }
    });
    return targetData;
  }

  return null;
}
