import { airsideReport } from "./airside.js";
/** Plain-text HVAC report (MCP hvac_design, arch hvac): units, room loads, coordination issues, assumptions. */
import type { HvacDesign } from "./hvac.js";

export function hvacReport(h: HvacDesign, levelNames: string[], detail = true): string {
  const sys = { packaged: "rooftop packaged units, ducted", ducted_split: "ducted splits with roof condensers", split: "wall splits with roof condensers", none: "none" }[h.system];
  const out = [`Air conditioning: ${sys}.`];
  if (!h.units.length) {
    out.push(h.system === "none" ? "hvac.system is none: no air conditioning designed." : "No air-conditioned rooms.");
    return out.join("\n");
  }
  out.push(`${h.totals.tr} TR installed for ${h.totals.area} m² conditioned (${h.totals.m2PerTR} m²/TR; peak ${h.totals.wPerM2} W/m²); ${h.totals.kw} kW electrical input.`, "", "Units:");
  for (const u of h.units)
    out.push(
      `  ${u.id}: ${u.size} TR (${u.kind.replace("_", " ")}; block load ${u.load} TR), ${u.airflow} L/s supply${u.freshAir ? `, ${u.freshAir} L/s fresh air` : ""}, ${u.kw} kW ${u.phase}-phase ${u.breaker} A — ${u.rooms.length} room(s) on ${[...new Set(u.rooms.map((r) => levelNames[r.level]))].join(" + ")}${u.onRoof ? ", on the roof" : ""}`,
    );
  if (detail) {
    out.push("", "Room loads (with safety factor):", "  level / room — kW, TR, supply L/s, fresh air L/s (walls / glass solar / roof / people / lighting / equipment / fresh air W)");
    for (const r of h.rooms) {
      const where = `${levelNames[r.level]} / ${r.name}`;
      if (!r.conditioned) {
        out.push(`  ${where} — not conditioned (${r.reason})`);
        continue;
      }
      const p = r.parts;
      out.push(`  ${where} — ${(r.total / 1000).toFixed(1)} kW, ${r.tr} TR, ${r.supply} L/s, ${r.freshAir} L/s (${p.walls} / ${p.glassSolar} / ${p.roof} / ${p.people} / ${p.lighting} / ${p.equipment} / ${p.freshAir}) → ${r.zone ?? ""}`);
    }
  }
  if (h.air) out.push(...airsideReport(h.air, levelNames));
  const all = [...h.issues, ...(h.air?.issues ?? [])];
  if (all.length) out.push("", "Coordination issues:", ...all.map((i) => `  - ${i}`));
  out.push("", "Assumptions:", ...[...h.assumptions, ...(h.air?.assumptions ?? [])].map((a) => `  - ${a}`));
  out.push("", "Change: project.hvac {system packaged|ducted_split|split|none, outdoorTemp, indoorTemp, glazing {u, shgc}, roofU, safetyFactor, diversity, maxUnitTR, zones [{rooms, shaft}], omitRooms}. Sheet: render_plan sheet 'hvac'. A licensed MEP engineer's calculation is still needed for the MEW submission.");
  return out.join("\n");
}
