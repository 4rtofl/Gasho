// The genres of plugins (docs/plugins.md, P9 and P10) as the plugins screen shows them. Which genres there are, and
// their names, come from the catalog (GashoPlugins' genres.json): the screen shows the genre's name on each card, and
// lists the catalog's plugins under their genres, in the catalog's order.
import type { CatalogPlugin, PluginCatalog, PluginGenre, PluginInfo } from "@gasho/protocol";

/**
 * The genre of an installed plugin: its own (gasho-plugin.json), or else the catalog's for it, as for a version
 * released before its gasho-plugin.json named one.
 */
export function genreOf(info: PluginInfo, catalog: PluginCatalog | undefined): string | undefined {
  return info.manifest.genre ?? catalog?.plugins.find((p) => p.id === info.id)?.genre;
}

/** The name of a genre, as the catalog gives it; undefined for a genre the catalog does not list. */
export function genreName(catalog: PluginCatalog | undefined, id: string | undefined): string | undefined {
  return id === undefined ? undefined : catalog?.genres?.find((g) => g.id === id)?.name;
}

export interface GenreGroup {
  /** Absent for the plugins of no genre the catalog lists. */
  genre?: PluginGenre;
  plugins: CatalogPlugin[];
}

/**
 * Plugins of the catalog by genre, in the order of the catalog's genres, each keeping the order it was given; genres
 * with none of them are left out, and plugins of a genre the catalog does not list come last. Undefined when the
 * catalog lists no genres: the plugins are then listed as they are.
 */
export function byGenre(plugins: CatalogPlugin[], genres: PluginGenre[] | undefined): GenreGroup[] | undefined {
  if (!genres || genres.length === 0) return undefined;
  const groups: GenreGroup[] = genres.map((genre) => ({ genre, plugins: plugins.filter((p) => p.genre === genre.id) }));
  const known = new Set(genres.map((g) => g.id));
  groups.push({ plugins: plugins.filter((p) => p.genre === undefined || !known.has(p.genre)) });
  return groups.filter((g) => g.plugins.length > 0);
}
