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
| `structure.json` | Concrete (placed), rebar (supply & fix), formwork, blinding, concrete blocks 100/150/200 and insulated AAC block, cement plaster and render, drywall, roof waterproofing, insulation and screed, floor screed, rebar ratios, frame concrete per m², Kuwaiti skeleton / finishing / turnkey benchmarks per m² |
| `construction.json` | Ceilings, doors, windows, window treatments, joinery per metre, installation labour, railings |
| `mep.json` | Electrical points, fixtures, circuits, DB, plumbing fixtures, pipes, heaters |
| `appliances.json` | Appliance allowances, furniture and decor allowances, percentages (preliminaries, OHP, contingency, VAT), the fit-out benchmark |

Entry format:

```json
{ "key": "ceiling:gypsum", "value": 8, "low": 4.5, "high": 16, "unit": "m²", "basis": "supply+install",
  "source": "Al-Fennar gypsum (gbs0.com), Kuwait, May 2025", "url": "https://…", "quote": "Basic flat ceiling 4.5–6 KD/m²…",
  "accessed": "2026-10-03", "confidence": "medium", "note": "+ paint" }
```

After editing a file, run `node scripts/build-market-rates.mjs kw` to regenerate `src/cost/market_kw.ts`. The script rejects entries with no source URL, values that are not numbers, and duplicate keys. Entries with `"value": null` are skipped, and the indicative rate is used for them.

## Structure (`costs.scope: "full"`)

`project.construction` says what the building is made of. The default is `rc_block`, the Kuwait / GCC practice. Section A of the bill measures it from the model:

| Line | Measured as |
| --- | --- |
| Excavation, blinding, foundations, bitumen to buried concrete | Ground-floor footprint × m³ per m² (isolated 0.3, raft 0.6, strip 0.25), 100 mm blinding |
| Ground, suspended and roof slabs | Slab area × thickness (auto slabs under closed wall loops, explicit slabs, roofs) |
| RC columns & beams | Modelled columns plus beams by ratio, or 0.13 m³ per m² of floor when no columns are drawn |
| RC staircases and RC walls | Stair width × rise × 1.1; walls with `construction: "rc_200" / "rc_250"` |
| Rebar (t) | Concrete × kg/m³: slabs 90, frame 150, foundations 90 (override in `construction.rebar`) |
| Formwork | Slab soffits + 9 m² per m³ of frame + foundation sides + RC wall faces |
| Blockwork | External walls by assembly (insulated 200 mm by default), roof parapets |
| Cement plaster / render | Inner faces of external walls and parapets; facades |
| Roof build-up, floor screed | Flat roof area; room floor area |

Internal walls (section B, both scopes) are billed by assembly. Each wall's block size is picked from its drawn thickness, and every plastered face gets cement plaster. The notes compare the structure's cost per m² with Kuwaiti skeleton (هيكل أسود) contract prices.

## Caveats

- These are published prices: retail listings, contractors' price pages, and mid-points of advertised ranges. They are not tender prices. Use them for budgets and early design decisions, and get local quotes for anything marked `low` confidence.
- Where no Kuwait price was published, the UAE or Saudi price is converted to KWD (AED × 0.0835, SAR × 0.0818, USD × 0.307) and the source says so. Examples are herringbone and terrazzo floors, zellige, microcement, quartz worktops, glass balustrades and garage doors.
- Preliminaries (12%), overhead & profit (12%) and contingency (10%) are GCC norms for contractor-led work. For a small fit-out you manage yourself, set `costs.preliminaries` / `costs.overheadProfit` lower (for example 4% / 8%).
- Kuwait has no VAT, so the rate is 0%. Change `costs.vat` if that changes.
- Prices were read in October 2026. Re-research them periodically: update `accessed` and the values, then rebuild.
