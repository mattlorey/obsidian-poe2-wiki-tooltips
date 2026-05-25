import { Plugin, requestUrl } from 'obsidian';

interface GemStat {
  label: string;
  value: string;
}

interface GemData {
  name: string;
  tags: string[];
  description: string;
  stats: GemStat[];
  iconUrl: string;
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

const WIKI_HOST = 'poe2wiki.net';
const WIKI_BASE = 'https://www.poe2wiki.net';
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const PREFETCH_DELAY_MS = 150;

// Session-level memory cache; populated from disk on load
const gemCache = new Map<string, GemData | null>();

export default class Poe2WikiTooltipPlugin extends Plugin {
  private tooltip: HTMLElement;
  private hoverTimer: number | null = null;
  private hideTimer: number | null = null;
  private inflight = new Map<string, Promise<GemData | null>>();
  private prefetchQueue: PrefetchItem[] = [];
  private queueRunning = false;

  async onload() {
    await this.loadPersistedCache();

    this.tooltip = document.body.createDiv({ cls: 'poe2db-tooltip' });
    this.tooltip.style.display = 'none';

    this.registerMarkdownPostProcessor((el) => {
      el.querySelectorAll<HTMLAnchorElement>(`a[href*="${WIKI_HOST}"]`).forEach(link => {
        link.addEventListener('mouseenter', (evt) => this.onLinkEnter(evt, link));
        link.addEventListener('mouseleave', () => this.onLinkLeave());
        this.enqueuePrefetch(link);
      });
    });
  }

  onunload() {
    this.tooltip.remove();
  }

  // --- Cache ---

  private async loadPersistedCache() {
    const saved: PersistedCache = (await this.loadData()) ?? {};
    const now = Date.now();
    for (const [url, entry] of Object.entries(saved)) {
      if (now - entry.fetchedAt < CACHE_TTL_MS) {
        gemCache.set(url, entry.data);
      }
    }
  }

  private async persistCache() {
    const out: PersistedCache = {};
    const now = Date.now();
    for (const [url, data] of gemCache.entries()) {
      if (data !== null) out[url] = { data, fetchedAt: now };
    }
    await this.saveData(out);
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
      // Skip if another prefetch already populated the cache for this URL
      if (!gemCache.has(item.url)) {
        await this.getGemData(item.url);
      }
      this.injectLinkIcon(item.link);
      if (this.prefetchQueue.length > 0) {
        await sleep(PREFETCH_DELAY_MS);
      }
    }
    this.queueRunning = false;
  }

  // --- Fetch ---

  private async getGemData(url: string): Promise<GemData | null> {
    if (gemCache.has(url)) return gemCache.get(url) ?? null;
    if (this.inflight.has(url)) return this.inflight.get(url)!;

    const promise = requestUrl({ url, headers: { 'User-Agent': BROWSER_UA } })
      .then(r => {
        const data = parseWikiPage(r.text);
        gemCache.set(url, data);
        this.persistCache();
        return data;
      })
      .catch(e => {
        console.error('[poe2-wiki-tooltips] fetch failed:', e);
        gemCache.set(url, null);
        return null;
      })
      .finally(() => this.inflight.delete(url));

    this.inflight.set(url, promise);
    return promise;
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
    if (this.hideTimer !== null) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }

    if (gemCache.has(link.href)) {
      const data = gemCache.get(link.href);
      if (data) this.renderTooltip(data, link);
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

  private onLinkLeave() {
    if (this.hoverTimer !== null) {
      clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }
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

    const header = this.tooltip.createDiv({ cls: 'poe2db-header' });
    if (data.iconUrl) {
      const img = header.createEl('img', { cls: 'poe2db-icon', attr: { src: data.iconUrl } });
      img.width = 36;
      img.height = 36;
    }
    header.createDiv({ text: data.name, cls: 'poe2db-name' });

    if (data.tags.length > 0) {
      const tagsEl = this.tooltip.createDiv({ cls: 'poe2db-tags' });
      data.tags.forEach(tag => tagsEl.createSpan({ text: tag, cls: 'poe2db-tag' }));
    }

    if (data.description) {
      this.tooltip.createDiv({ text: data.description, cls: 'poe2db-desc' });
    }

    if (data.stats.length > 0) {
      const statsEl = this.tooltip.createDiv({ cls: 'poe2db-stats' });
      data.stats.forEach(({ label, value }) => {
        const row = statsEl.createDiv({ cls: 'poe2db-stat-row' });
        row.createSpan({ text: label, cls: 'poe2db-stat-label' });
        row.createSpan({ text: value, cls: 'poe2db-stat-value' });
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
    const estimatedHeight = 220;
    if (top + estimatedHeight > window.innerHeight) top = rect.top - estimatedHeight - gap;
    this.tooltip.style.left = `${Math.max(gap, left)}px`;
    this.tooltip.style.top = `${Math.max(gap, top)}px`;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseWikiPage(html: string): GemData | null {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  const itemBox = doc.querySelector('.item-box.-gem');
  if (!itemBox) return null;

  const name = itemBox.querySelector('.header.-single')?.textContent?.trim() ?? '';

  const firstGroup = itemBox.querySelector('.item-stats > .group');
  const tags = Array.from(firstGroup?.querySelectorAll('a') ?? [])
    .map(a => a.textContent?.trim() ?? '')
    .filter(Boolean);

  const stats: GemStat[] = [];
  if (firstGroup) {
    const tmp = doc.createElement('span');
    firstGroup.innerHTML.split(/<br\s*\/?>/i).forEach(line => {
      tmp.innerHTML = line;
      const text = tmp.textContent?.trim() ?? '';
      const colon = text.indexOf(':');
      if (colon === -1) return;
      const label = text.slice(0, colon).trim();
      const value = text.slice(colon + 1).trim();
      if (label && value && label !== 'Tier' && label !== 'Level') {
        stats.push({ label, value });
      }
    });
  }

  const description = itemBox.querySelector('.tc.-gemdesc')?.textContent?.trim() ?? '';

  const iconSrc = itemBox.querySelector('img')?.getAttribute('src') ?? '';
  const iconUrl = iconSrc ? WIKI_BASE + iconSrc : '';

  return { name, tags, description, stats, iconUrl };
}
