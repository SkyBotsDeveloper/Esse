# Innertube search fixtures

Hand-authored, minimized protocol fixtures (synthetic video IDs), based on WEB search renderer paths referenced by [yt-search-python](https://github.com/BillaSpace/yt-search-python/blob/legacy/youtubesearchpython/core/search.py). These are not recordings of live responses and contain no cookies, visitor IDs or credentials.

`search.json` covers mixed results, text runs/simpleText, byline fallbacks, ignored ads, Topic metadata and unfollowed continuation. `official-rich.json` covers a rich-grid wrapper and label upload. `empty.json` is an explicit no-results message. `changed.json` models an unsupported renderer that must fail, never silently become an empty match.
