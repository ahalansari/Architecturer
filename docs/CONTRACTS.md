# Works contracts

`generate_contract` (MCP) and `arch contract` (CLI) write a works contract for one trade package of a plan. Each contract has an English part followed by an Arabic part, and the Arabic text prevails if the two differ. It comes in two formats:
- **Word (`.docx`)**, to edit before signing.
- **Print-ready HTML**. Use its **Print / Save as PDF** button to get a PDF.

The contracts are drafts based on common Kuwaiti residential practice. Have a lawyer review the template once before you use it for real work.

## Packages

| Package | Covers | Modes |
|---|---|---|
| `main` | The whole building. Kitchens and joinery are added with `includeJoinery`. | supply (turnkey), labour |
| `structure` | Skeleton (هيكل أسود): excavation, blinding, foundations, slabs, frame, stairs, rebar, formwork | labour, supply |
| `blockwork` | External, internal and parapet blockwork | labour, supply |
| `plaster` | Internal plaster and external render | labour, supply |
| `waterproofing` | Roof screed to falls, membrane, insulation, protection tiles | labour, supply |
| `tiling` | Screeds, floor and wall tiles, marble, skirting, thresholds | labour, supply |
| `painting` | Paint, wallpaper and wall coverings, wainscoting | labour, supply |
| `ceilings` | Gypsum ceilings, bulkheads, coves, cornices, ceiling paint | labour, supply |
| `doors_windows` | Doors, aluminium windows, window treatments | supply |
| `electrical` | Conduits, wiring, boards, accessories, fittings, testing | labour, supply |
| `plumbing` | Drainage, water pipework, sanitary ware, heaters, tests | labour, supply |
| `hvac` | Air conditioning: units, ductwork, diffusers, grilles, controls, balancing | supply |
| `lifts` | Lifts: supply, installation, safety devices, testing and certification | supply |
| `joinery` | Kitchens, wardrobes, built-in units | supply |
| `external` | Terraces, paving, balustrades | labour, supply |

Every construction line in the full-scope bill belongs to exactly one trade package. Furniture is bought, not contracted, so it isn't in any package.

## What a contract contains

1. **Title and parties.** The owner is the first party; the contractor is the second party (a company or a person). Missing details print as blank lines to fill in by hand.
2. **Recital** with the site address (area, block, plot, house, PACI number).
3. **Contract documents** and their order of precedence.
4. **Scope of works.** The package's steps, in the order they're carried out.
5. **Specification and quality.** Measurable tolerances, curing, testing, and rejection of defective work.
6. **Materials.**
   - Labour only (مصنعية فقط): the materials the owner supplies, how to request them, and a 5% wastage limit.
   - Supply & install: new materials to approved samples, and who carries the risk until handover.
7. **Contract price.**
   - The value comes from Annex 1. It's re-measured on site using the package's measurement rule; for plaster, for example, openings are deducted at half their area.
   - Rates are fixed for the duration of the contract.
8. **Payments.**
   - Stages are tied to the work, with one stage per slab for structural and electrical work.
   - Each stage is paid within 7 days of being verified.
   - A retention (default 5%) is held back until the end of the defects period.
9. **Programme.** Start date, duration and completion date; when extensions are allowed; a delay penalty (default 0.1% of the value per day, capped at 10%).
10. **Variations.** Only by written instruction, valued at the contract rates.
11. **Obligations of each party.**
    - Contractor: laws, safety, insurance of its own workers, protecting other work, no subcontracting, cleaning.
    - Owner: site access, water and power, materials, payments. The contractor may suspend work 14 days after a written notice of late payment.
12. **Handover and defects.** A defects period (default 12 months). Structural packages also carry the contractor's ten-year liability under the Kuwaiti Civil Code.
13. **Termination** by either party, with notice periods.
14. **Governing law and disputes.** Kuwaiti law; amicable settlement first, then the Kuwaiti courts.
15. **Language and copies.** Signatures of both parties and two witnesses.
16. **Annex 1:** schedule of quantities and prices. **Annex 2:** payment schedule with retention and net amounts.

## Prices

Quantities come from the model's full-scope cost estimate. Rates are chosen as follows:
- **Supply and install:** the bill's rate (researched market rates, vendor prices or your `project.costs.rates`).
- **Labour only:** your rate if you set one, otherwise a researched Kuwaiti labour rate (`labour:<key>` in `data/market-rates/kw/labour.json`). Failing both, the rate is estimated as a share of the supply & install rate and marked `*` in the schedule.

Pass the contractor's quoted prices so that nothing is estimated:

```json
{ "package": "plaster", "mode": "labour", "rates": { "labour:wall:cement_plaster": 1.45, "labour:wall:render_external": 2.45 } }
```

The main contract in supply mode adds the main contractor's preliminaries and overhead & profit from the bill. Each trade contract's rates already include its contractor's margin.

## Settings

`project.contract` holds the details every contract shares:

```json
"contract": {
  "owner": { "name": "Owner Name", "nameAr": "اسم المالك", "civilId": "...", "phone": "..." },
  "location": { "area": "Salwa", "block": "5", "plot": "123", "house": "7" },
  "retention": 5,
  "defectsMonths": 12,
  "delayPenaltyPerDay": 25
}
```

Tool arguments override these settings for a single contract: `contractor`, `owner`, `location`, `date`, `startDate`, `durationDays`, `retention`, `defectsMonths`, `delayPenaltyPerDay`, `delayPenaltyCap`, `rates`, `extraTerms` (each term as `{en, ar}`), `formats` and `output`.
