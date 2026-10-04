/**
 * Wire format for xAI search on the BlockRun gateways.
 *
 * The SDK's `SearchParameters` / `SearchSource` types are camelCase, but the
 * gateways validate the OpenAI-style snake_case body (`included_x_handles`,
 * `from_date`, …) with a non-strict schema that silently strips unknown keys.
 * Sending the camelCase object verbatim therefore dropped every filter: an
 * "only these X handles since yesterday" search ran over all of X, all time.
 * Everything that leaves the SDK goes through {@link toWireSearchParameters}.
 *
 * Native xAI search tools (`{ type: "x_search" }` / `{ type: "web_search" }`)
 * are accepted in `tools` for xai/* models and converted by {@link toWireTools}.
 * https://docs.x.ai/developers/tools/x-search
 */
import type { AnyTool, SearchParameters, SearchSource } from "./types";

type Wire = Record<string, unknown>;

function put(out: Wire, key: string, value: unknown): void {
  if (value !== undefined) out[key] = value;
}

/** Strip a leading `@` — xAI wants bare handles. */
function handles(list: string[] | undefined): string[] | undefined {
  return list?.map((h) => h.trim().replace(/^@+/, ""));
}

function sourceToWire(source: SearchSource): Wire {
  // Snake_case keys a caller already sent (a raw dict cast to the type) are kept.
  const raw = source as unknown as Wire;
  const out: Wire = { ...raw };
  for (const key of Object.keys(out)) if (/[A-Z]/.test(key)) delete out[key];
  switch (source.type) {
    case "x":
      put(out, "included_x_handles", handles(source.includedXHandles) ?? out.included_x_handles);
      put(out, "excluded_x_handles", handles(source.excludedXHandles) ?? out.excluded_x_handles);
      put(out, "post_favorite_count", source.postFavoriteCount);
      put(out, "post_view_count", source.postViewCount);
      put(out, "enable_image_understanding", source.enableImageUnderstanding);
      put(out, "enable_video_understanding", source.enableVideoUnderstanding);
      break;
    case "web":
    case "news":
      put(out, "country", source.country);
      put(out, "allowed_websites", source.allowedWebsites);
      put(out, "excluded_websites", source.excludedWebsites);
      put(out, "safe_search", source.safeSearch);
      put(out, "enable_image_understanding", source.enableImageUnderstanding);
      break;
    case "rss":
      put(out, "links", source.links);
      break;
  }
  return out;
}

/** camelCase `SearchParameters` → the gateway's snake_case `search_parameters`. */
export function toWireSearchParameters(sp: SearchParameters): Wire {
  const raw = sp as unknown as Wire;
  const out: Wire = {};
  for (const [key, value] of Object.entries(raw)) if (!/[A-Z]/.test(key) && key !== "sources") out[key] = value;
  put(out, "mode", sp.mode);
  if (sp.sources) out.sources = sp.sources.map(sourceToWire);
  put(out, "return_citations", sp.returnCitations);
  put(out, "from_date", sp.fromDate);
  put(out, "to_date", sp.toDate);
  put(out, "max_search_results", sp.maxSearchResults);
  put(out, "max_turns", sp.maxTurns);
  return out;
}

/** Function tools pass through; x_search / web_search tools get xAI's field names. */
export function toWireTools(tools: AnyTool[]): Wire[] {
  return tools.map((tool) => {
    if (tool.type === "x_search") {
      const out: Wire = { type: "x_search" };
      put(out, "allowed_x_handles", handles(tool.allowedXHandles));
      put(out, "excluded_x_handles", handles(tool.excludedXHandles));
      put(out, "from_date", tool.fromDate);
      put(out, "to_date", tool.toDate);
      put(out, "enable_image_understanding", tool.enableImageUnderstanding);
      put(out, "enable_video_understanding", tool.enableVideoUnderstanding);
      return out;
    }
    if (tool.type === "web_search") {
      const out: Wire = { type: "web_search" };
      put(out, "allowed_domains", tool.allowedDomains);
      put(out, "excluded_domains", tool.excludedDomains);
      put(out, "enable_image_understanding", tool.enableImageUnderstanding);
      return out;
    }
    return tool as unknown as Wire;
  });
}
