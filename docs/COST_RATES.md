# Cost rates

`arch estimate` measures quantities from the model and prices each line. It uses the first match from this list:

1. **Your rate:** `project.costs.rates["<key>"]`.
2. **Vendor price:** products placed from vendor pages (IKEA and others), at the page price.
3. **Researched market rate:** `data/market-rates/kw/*.json`. Each entry has its source URL, a short quote, the date it was read, a low–high range and a confidence level.
4. **Indicative rate:** the built-in `DEFAULT_RATES` in `src/cost/estimate.ts`. These are used only where no market price was found.

Every bill line is tagged *vendor price*, *market rate*, *your rate* or *indicative*. The bill ends with a **Rates & sources** table that links each market rate to its source, and the summary shows how much of the total each kind of rate covers.

## The research data

| File | Covers |
| --- | --- |
| `finishes.json` | Floors, wall finishes, skirting, cornice, thresholds |
| `construction.json` | Partitions, shell, ceilings, doors, windows, window treatments, joinery per metre, installation labour, railings |
| `mep.json` | Electrical points, fixtures, circuits, DB, plumbing fixtures, pipes, heaters |
| `appliances.json` | Appliance allowances, furniture and decor allowances, percentages (preliminaries, OHP, contingency, VAT), the fit-out benchmark |

Entry format:

```json
{ "key": "ceiling:gypsum", "value": 8, "low": 4.5, "high": 16, "unit": "m²", "basis": "supply+install",
  "source": "Al-Fennar gypsum (gbs0.com), Kuwait, May 2025", "url": "https://…", "quote": "Basic flat ceiling 4.5–6 KD/m²…",
  "accessed": "2026-10-03", "confidence": "medium", "note": "+ paint" }
```

After editing a file, run `node scripts/build-market-rates.mjs kw` to regenerate `src/cost/market_kw.ts`. The script rejects entries with no source URL, values that are not numbers, and duplicate keys. Entries with `"value": null` are skipped, and the indicative rate is used for them.

## Caveats

- These are published prices: retail listings, contractors' price pages, and mid-points of advertised ranges. They are not tender prices. Use them for budgets and early design decisions, and get local quotes for anything marked `low` confidence.
- Where no Kuwait price was published, the UAE or Saudi price is converted to KWD (AED × 0.0835, SAR × 0.0818, USD × 0.307) and the source says so. Examples are herringbone and terrazzo floors, zellige, microcement, quartz worktops, glass balustrades and garage doors.
- Preliminaries (12%), overhead & profit (12%) and contingency (10%) are GCC norms for contractor-led work. For a small fit-out you manage yourself, set `costs.preliminaries` / `costs.overheadProfit` lower (for example 4% / 8%).
- Kuwait has no VAT, so the rate is 0%. Change `costs.vat` if that changes.
- Prices were read in October 2026. Re-research them periodically: update `accessed` and the values, then rebuild.
