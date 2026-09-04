// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#byteOffset=4511230 (ayn emoji record merge and category projection)
// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#byteOffset=4511786 (lft search ranking and 96-result cap)
// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#byteOffset=4512327 (D5e lazy loader/cache/error reset)
// @evidence recovered/frontend/app/assets/index-UbX-y3il.js#byteOffset=5668981 (Windows ayn/lft/D5e equivalent)
// @evidence src/app/package.json#emojibase-data=17.0.0
// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#lazy-emoji-data
// The four datasets below are the same package files that produced the
// shipped chunks. Keep the imports lazy so opening the composer has the same
// startup cost and cache behavior as the release renderer.

export interface RawEmojiRecord {
  readonly group?: number;
  readonly hexcode: string;
  readonly label: string;
  readonly order?: number;
  readonly tags?: readonly string[];
  readonly unicode: string;
  readonly emoticon?: string | readonly string[];
  readonly skins?: readonly RawEmojiRecord[];
}

export interface EmojiMessageRecord {
  readonly key: string;
  readonly message: string;
  readonly order: number;
}

export interface EmojiToneRecord {
  readonly key: string;
  readonly message: string;
}

export interface EmojiMetadataModule {
  readonly default: {
    readonly groups: readonly EmojiMessageRecord[];
    readonly skinTones: readonly EmojiToneRecord[];
    readonly subgroups: readonly EmojiMessageRecord[];
  };
}

export interface EmojiDataModule {
  readonly default: readonly RawEmojiRecord[];
}

export interface EmojiAliasModule {
  readonly default: Readonly<Record<string, string | readonly string[]>>;
}

export interface EmojiChunkModules {
  readonly compact: EmojiDataModule;
  readonly messages: EmojiMetadataModule;
  readonly iamcal: EmojiAliasModule;
  readonly emojibase: EmojiAliasModule;
}

interface EmojibaseDataRecord {
  readonly group?: number;
  readonly hexcode: string;
  readonly label: string;
  readonly order?: number;
  readonly tags?: readonly string[];
  readonly emoji: string;
  readonly emoticon?: string | readonly string[];
  readonly skins?: readonly EmojibaseDataRecord[];
}

function toRawEmojiRecord(record: EmojibaseDataRecord): RawEmojiRecord {
  return {
    ...(record.group == null ? {} : { group: record.group }),
    hexcode: record.hexcode,
    label: record.label,
    ...(record.order == null ? {} : { order: record.order }),
    ...(record.tags == null ? {} : { tags: record.tags }),
    unicode: record.emoji,
    ...(record.emoticon == null ? {} : { emoticon: record.emoticon }),
    ...(record.skins == null ? {} : { skins: record.skins.map(toRawEmojiRecord) }),
  };
}

export interface EmojiEntry {
  readonly id: string;
  readonly name: string;
  readonly native: string;
  readonly shortcodes: readonly string[];
  readonly search: string;
}

export interface EmojiCategory {
  readonly id: string;
  readonly label: string;
  readonly emojis: readonly EmojiEntry[];
}

export interface EmojiCatalog {
  readonly categories: readonly EmojiCategory[];
  /** Metadata only; the shipped picker exposes no skin-tone control. */
  readonly skinTones: readonly EmojiToneRecord[];
  readonly subgroups: readonly EmojiMessageRecord[];
}

export const EMOJI_SEARCH_LIMIT = 96;
const COMPONENT_GROUP_KEY = "component";

type AliasValue = string | readonly string[] | undefined;

function asArray(value: AliasValue): readonly string[] {
  return value == null ? [] : typeof value === "string" ? [value] : value;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function labelFor(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function normalizeNative(value: string): string {
  return value.replace(/(\p{Emoji_Presentation})\uFE0F/gu, "$1");
}

function projectEntry(
  raw: RawEmojiRecord,
  iamcalShortcodes: Readonly<Record<string, string | readonly string[]>>,
  emojibaseShortcodes: Readonly<Record<string, string | readonly string[]>>,
): EmojiEntry {
  // Immutable merge order is iamcal aliases first, then emojibase aliases,
  // with duplicate aliases removed while retaining their first occurrence.
  const shortcodes = unique([
    ...asArray(iamcalShortcodes[raw.hexcode]),
    ...asArray(emojibaseShortcodes[raw.hexcode]),
  ]);
  const id = shortcodes[0] ?? raw.hexcode;
  const name = labelFor(raw.label);
  return {
    id,
    name,
    native: normalizeNative(raw.unicode),
    shortcodes,
    search: [raw.label, id, ...shortcodes, ...(raw.tags ?? []), ...asArray(raw.emoticon)]
      .join(" ")
      .toLowerCase(),
  };
}

export function buildEmojiCatalog(chunks: EmojiChunkModules): EmojiCatalog {
  const grouped = new Map<number, EmojiEntry[]>();
  for (const raw of chunks.compact.default) {
    if (raw.group == null) continue;
    let entries = grouped.get(raw.group);
    if (entries == null) {
      entries = [];
      grouped.set(raw.group, entries);
    }
    for (const variant of [raw, ...(raw.skins ?? [])]) {
      entries.push(projectEntry(variant, chunks.iamcal.default, chunks.emojibase.default));
    }
  }

  const categories: EmojiCategory[] = [];
  for (const group of chunks.messages.default.groups) {
    if (group.key === COMPONENT_GROUP_KEY) continue;
    const emojis = grouped.get(group.order);
    if (emojis == null || emojis.length === 0) continue;
    categories.push({ id: group.key, label: labelFor(group.message), emojis });
  }
  return {
    categories,
    skinTones: chunks.messages.default.skinTones,
    subgroups: chunks.messages.default.subgroups,
  };
}

export function searchEmoji(
  catalog: EmojiCatalog,
  query: string,
  limit = EMOJI_SEARCH_LIMIT,
  recents: readonly EmojiEntry[] = [],
): readonly EmojiEntry[] {
  const normalizedQuery = query.trim().toLowerCase();
  const exact: EmojiEntry[] = [];
  const secondary: EmojiEntry[] = [];
  for (const category of catalog.categories) {
    for (const emoji of category.emojis) {
      if (normalizedQuery.length === 0) {
        exact.push(emoji);
        continue;
      }
      if (!emoji.search.includes(normalizedQuery)) continue;
      const name = emoji.name.toLowerCase();
      const isExact = emoji.id.startsWith(normalizedQuery)
        || emoji.shortcodes.some((shortcode) => shortcode.startsWith(normalizedQuery))
        || name.startsWith(normalizedQuery)
        || name.includes(` ${normalizedQuery}`);
      (isExact ? exact : secondary).push(emoji);
    }
  }

  const recentOrder = new Map<string, number>();
  recents.forEach((emoji, index) => {
    if (!recentOrder.has(emoji.id)) recentOrder.set(emoji.id, index);
  });
  const compareRecency = (left: EmojiEntry, right: EmojiEntry): number => {
    const leftIndex = recentOrder.get(left.id) ?? Number.POSITIVE_INFINITY;
    const rightIndex = recentOrder.get(right.id) ?? Number.POSITIVE_INFINITY;
    return leftIndex === rightIndex ? 0 : leftIndex - rightIndex;
  };
  exact.sort(compareRecency);
  secondary.sort(compareRecency);
  return [...exact, ...secondary].slice(0, Math.max(0, limit));
}

export async function loadShippedEmojiChunks(): Promise<EmojiChunkModules> {
  const [data, messages, iamcal, emojibase] = await Promise.all([
    import("emojibase-data/en/data.json", { with: { type: "json" } }),
    import("emojibase-data/en/messages.json", { with: { type: "json" } }),
    import("emojibase-data/en/shortcodes/iamcal.json", { with: { type: "json" } }),
    import("emojibase-data/en/shortcodes/emojibase.json", { with: { type: "json" } }),
  ]);
  return {
    compact: { default: (data.default as readonly EmojibaseDataRecord[]).map(toRawEmojiRecord) },
    messages: messages as EmojiMetadataModule,
    iamcal: iamcal as EmojiAliasModule,
    emojibase: emojibase as EmojiAliasModule,
  };
}

let shippedCatalog: EmojiCatalog | null = null;
let shippedLoad: Promise<EmojiCatalog> | null = null;

export function loadShippedEmojiCatalog(): Promise<EmojiCatalog> {
  if (shippedCatalog != null) return Promise.resolve(shippedCatalog);
  if (shippedLoad == null) {
    const pending = loadShippedEmojiChunks()
      .then(buildEmojiCatalog)
      .then((catalog) => {
        shippedCatalog = catalog;
        return catalog;
      });
    shippedLoad = pending;
    pending.catch(() => {
      if (shippedLoad === pending) shippedLoad = null;
    });
  }
  return shippedLoad;
}

export type EmojiCatalogSnapshot =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly catalog: EmojiCatalog }
  | { readonly status: "error"; readonly error: unknown };

export interface EmojiCatalogStore {
  getSnapshot(): EmojiCatalogSnapshot;
  subscribe(listener: () => void): () => void;
  load(): Promise<EmojiCatalog>;
  reset(): void;
  dispose(): void;
}

export interface EmojiCatalogStoreOptions {
  readonly loader?: () => Promise<EmojiCatalog>;
}

export function createEmojiCatalogStore(options: EmojiCatalogStoreOptions = {}): EmojiCatalogStore {
  const loader = options.loader ?? loadShippedEmojiCatalog;
  const listeners = new Set<() => void>();
  let snapshot: EmojiCatalogSnapshot = { status: "idle" };
  let pending: Promise<EmojiCatalog> | null = null;
  let generation = 0;
  let disposed = false;

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const load = (): Promise<EmojiCatalog> => {
    if (disposed) return Promise.reject(new Error("Emoji catalog store is disposed."));
    if (snapshot.status === "ready") return Promise.resolve(snapshot.catalog);
    if (pending != null) return pending;
    const current = ++generation;
    snapshot = { status: "loading" };
    notify();
    const request = loader().then((catalog) => {
      if (disposed || current !== generation) return catalog;
      snapshot = { status: "ready", catalog };
      pending = null;
      notify();
      return catalog;
    }).catch((error: unknown) => {
      if (!disposed && current === generation) {
        snapshot = { status: "error", error };
        pending = null;
        notify();
      }
      throw error;
    });
    pending = request;
    return request;
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      if (snapshot.status === "idle") void load().catch(() => {});
      return () => { listeners.delete(listener); };
    },
    load,
    reset() {
      if (disposed) return;
      generation += 1;
      pending = null;
      snapshot = { status: "idle" };
      notify();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      pending = null;
      listeners.clear();
    },
  };
}
