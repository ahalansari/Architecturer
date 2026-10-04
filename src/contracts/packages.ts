/**
 * Trade packages for works contracts (Kuwait / GCC residential practice): what each contract covers, which
 * bill-of-quantities lines it takes, its scope steps, specification, materials split for labour-only
 * contracts (مصنعية فقط) and payment stages. Every text is in English and Arabic.
 */

export type Mode = "labour" | "supply";

export interface Bi {
  en: string;
  ar: string;
}
export const bi = (en: string, ar: string): Bi => ({ en, ar });

export interface Milestone {
  label: Bi;
  /** Share of the contract value, %. */
  pct: number;
}

export interface PackageLine {
  section: string;
  key?: string;
  description: string;
}

/** Facts about the building that shape a package's scope and stages. */
export interface BuildingFacts {
  levels: number;
  /** Suspended floor slabs (above the ground slab, below the roof). */
  suspendedSlabs: number;
  floorArea: number;
}

export interface TradePackage {
  id: string;
  title: Bi;
  /** Contract modes this trade is let on (joinery and windows are always supply & install). */
  modes: Mode[];
  /** Which bill lines belong to this package. */
  match(l: PackageLine): boolean;
  scope: Bi[];
  spec: Bi[];
  /** Labour-only: what the owner supplies. */
  ownerSupplies: Bi[];
  /** What the contractor provides in every mode (tools, scaffolding, ...). */
  contractorProvides: Bi[];
  /** Rule for site measurement of the final account. */
  measurement?: Bi;
  /** Labour share of a supply & install rate, used when no labour rate is known. */
  labourShare: number;
  /** Default programme, calendar days. */
  durationDays(b: BuildingFacts): number;
  milestones(b: BuildingFacts, mode: Mode): Milestone[];
  /** Structural work: decennial liability applies. */
  structural?: boolean;
}

const TILE_WALL = /^wall:(tiles|zellige|mosaic|hex_tiles|marble|stone|brick)/;
const ord = (n: number): Bi => {
  const en = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth"][n - 1] ?? `${n}th`;
  const ar = ["الأولى", "الثانية", "الثالثة", "الرابعة", "الخامسة", "السادسة", "السابعة", "الثامنة"][n - 1] ?? `رقم ${n}`;
  return bi(en, ar);
};

/** Stages for work that follows the slabs: foundations, each slab, the roof, then completion. */
function slabStages(b: BuildingFacts, opts: { start: Milestone[]; perSlab: number; end: Milestone[]; slab?: (n: number | "roof") => Bi }): Milestone[] {
  const label =
    opts.slab ??
    ((n: number | "roof") =>
      n === "roof" ? bi("On completion of casting the roof slab", "عند الانتهاء من صب سقف السطح") : bi(`On completion of casting the ${ord(n).en} suspended floor slab`, `عند الانتهاء من صب سقف الدور رقم ${n} (البلاطة ${ord(n).ar})`));
  const out = [...opts.start];
  for (let i = 1; i <= b.suspendedSlabs; i++) out.push({ label: label(i), pct: opts.perSlab });
  out.push({ label: label("roof"), pct: opts.perSlab });
  out.push(...opts.end);
  return normalise(out);
}

/** Scale stage percentages to 100 (keeping the last stage as the balancing one). */
function normalise(ms: Milestone[]): Milestone[] {
  const total = ms.reduce((a, m) => a + m.pct, 0);
  const out = ms.map((m) => ({ ...m, pct: Math.round((m.pct * 100) / total) }));
  out[out.length - 1].pct += 100 - out.reduce((a, m) => a + m.pct, 0);
  return out;
}

const simple = (...ms: [string, string, number][]): Milestone[] => normalise(ms.map(([en, ar, pct]) => ({ label: bi(en, ar), pct })));

const TOOLS = bi("All tools, equipment, scaffolding, ladders and consumables needed for the works, and their transport to and from site", "جميع العدد والأدوات والمعدات والسقالات والسلالم والمستهلكات اللازمة للأعمال ونقلها من وإلى الموقع");
const LABOUR = bi("Skilled and unskilled labour, supervision by a competent foreman, and the workers' transport, accommodation and legal residency", "العمالة الفنية والعادية والإشراف من مراقب كفء، ونقل العمال وسكنهم وإقاماتهم النظامية");
const CLEAN = bi("Daily removal of the package's debris to the site skip and final cleaning of the work areas", "إزالة مخلفات الأعمال يومياً إلى حاوية الموقع والتنظيف النهائي لمناطق العمل");

export const PACKAGES: TradePackage[] = [
  {
    id: "main",
    title: bi("Main building contract: complete construction of the building", "عقد مقاولة رئيسي: تنفيذ المبنى كاملاً"),
    modes: ["supply", "labour"],
    match: (l) => ["A", "B", "C", "D", "F", "G", "I", "J", "K"].includes(l.section),
    scope: [
      bi("Setting out, excavation, foundations, ground slab and all reinforced-concrete structure (columns, beams, slabs, stairs, roof) to the approved structural drawings", "التخطيط والحفر والأساسات والأرضية الخرسانية وجميع أعمال الهيكل الخرساني المسلح (الأعمدة والجسور والأسقف والدرج والسطح) حسب المخططات الإنشائية المعتمدة"),
      bi("Blockwork to external and internal walls and parapets", "أعمال البناء بالطابوق للجدران الخارجية والداخلية والدراوي"),
      bi("Internal plaster and external render", "أعمال المساح الداخلي والخارجي"),
      bi("Roof screed to falls, waterproofing, thermal insulation and protection tiles", "أعمال السطح: الميول والعزل المائي والحراري وبلاط الحماية"),
      bi("Electrical and plumbing installations complete, tested and connected", "التمديدات الكهربائية والصحية كاملة مع الفحص والتوصيل"),
      bi("Air conditioning: units, ductwork, diffusers, grilles and controls, tested and balanced", "أعمال التكييف: الوحدات ومجاري الهواء والفتحات ومنظمات الحرارة مع الفحص والموازنة"),
      bi("Floor and wall finishes, ceilings, painting, doors and windows as listed in the schedule of quantities", "التشطيبات من أرضيات وجدران وأسقف ودهانات وأبواب ونوافذ حسب جدول الكميات"),
      bi("External works shown on the drawings (terraces, balustrades)", "الأعمال الخارجية المبينة بالمخططات (التراسات والدرابزينات)"),
      bi("Obtaining the contractor's permits for the works, testing, commissioning and handover of the completed building", "استخراج تصاريح المقاول اللازمة للأعمال والفحص والتشغيل وتسليم المبنى كاملاً"),
    ],
    spec: [
      bi("Concrete, reinforcement and structural works strictly to the approved structural drawings and Kuwait Municipality requirements; concrete cubes tested at an approved laboratory for every slab", "تنفذ الخرسانة والتسليح والأعمال الإنشائية طبقاً للمخططات الإنشائية المعتمدة واشتراطات بلدية الكويت، مع فحص مكعبات الخرسانة لكل سقف في مختبر معتمد"),
      bi("Each trade to the specification clauses of its package contract, which form part of this contract", "يلتزم كل بند بالمواصفات الواردة في عقد البند المعني، وتعتبر جزءاً من هذا العقد"),
      bi("Materials new, of the approved brand and sample; samples submitted for the owner's approval before ordering", "تكون المواد جديدة ومن الماركة والعينة المعتمدة، وتقدم العينات لاعتماد المالك قبل التوريد"),
    ],
    ownerSupplies: [
      bi("All materials for the works (ready-mix concrete, steel, block, cement, sand, tiles, fittings, finishes) delivered to site on time", "جميع المواد اللازمة للأعمال (الخرسانة الجاهزة والحديد والطابوق والأسمنت والرمل والبلاط والأدوات والتشطيبات) تورد للموقع في الوقت المناسب"),
    ],
    contractorProvides: [TOOLS, LABOUR, CLEAN, bi("Formwork, props and site hoarding", "القوالب الخشبية والدعامات وسور الموقع المؤقت")],
    labourShare: 0.35,
    durationDays: (b) => Math.round(210 + 75 * Math.max(0, b.levels - 1)),
    milestones: (b, mode) =>
      slabStages(b, {
        start: [
          ...(mode === "supply" ? [{ label: bi("Advance payment on signing and mobilisation", "دفعة مقدمة عند التوقيع والتجهيز للموقع"), pct: 10 }] : []),
          { label: bi("On completion of excavation, foundations and tie beams", "عند الانتهاء من الحفر والأساسات والميد"), pct: 12 },
          { label: bi("On completion of the ground slab", "عند الانتهاء من صب الأرضية الخرسانية"), pct: 6 },
        ],
        perSlab: 9,
        end: [
          { label: bi("On completion of blockwork", "عند الانتهاء من أعمال الطابوق"), pct: 9 },
          { label: bi("On completion of plaster, render and services first fix", "عند الانتهاء من المساح والتمديدات الأولى للكهرباء والصحي"), pct: 12 },
          { label: bi("On completion of floor and wall finishes and ceilings", "عند الانتهاء من التشطيبات والأسقف المعلقة"), pct: 14 },
          { label: bi("On completion of painting, doors, windows, fixtures and testing", "عند الانتهاء من الدهانات والأبواب والنوافذ والأدوات والفحص"), pct: 12 },
          { label: bi("On handover of the completed building", "عند تسليم المبنى كاملاً"), pct: 5 },
        ],
      }),
    structural: true,
  },
  {
    id: "structure",
    title: bi("Structural works (skeleton): foundations and reinforced-concrete frame", "أعمال الهيكل الأسود: الأساسات والهيكل الخرساني المسلح"),
    modes: ["labour", "supply"],
    match: (l) => l.section === "A" && /^(earthworks|struct|substructure)/.test(l.key ?? ""),
    scope: [
      bi("Setting out the building to the approved plot plan and levels", "توقيع المبنى على الطبيعة حسب مخطط القسيمة والمناسيب المعتمدة"),
      bi("Excavation, levelling, compaction and backfilling for foundations", "الحفر والتسوية والدك والردم للأساسات"),
      bi("Plain concrete blinding under foundations and ground slab", "صب الخرسانة العادية (النظافة) تحت الأساسات والأرضية"),
      bi("Formwork, steel fixing and casting of foundations, tie beams and columns", "أعمال النجارة والحدادة والصب للأساسات والميد والأعمدة"),
      bi("Bitumen coating to all buried concrete", "دهان الخرسانة المدفونة بالبيتومين"),
      bi("Ground slab, suspended slabs, beams, stairs and roof slab, including formwork, reinforcement and casting", "الأرضية الخرسانية والأسقف والجسور والدرج وسقف السطح شاملة النجارة والحدادة والصب"),
      bi("Curing of all concrete and striking of formwork at the specified times", "معالجة الخرسانة بالماء وفك القوالب في المواعيد الفنية المحددة"),
    ],
    spec: [
      bi("Work strictly to the approved structural drawings; no change to dimensions, reinforcement or levels without the structural engineer's written approval", "التنفيذ طبقاً للمخططات الإنشائية المعتمدة، ولا يجوز تغيير الأبعاد أو التسليح أو المناسيب إلا بموافقة كتابية من المهندس الإنشائي"),
      bi("Reinforcement inspected and approved by the supervising engineer before every pour; concrete cover kept with spacers", "يتم فحص واعتماد التسليح من المهندس المشرف قبل كل صبة، مع المحافظة على الغطاء الخرساني باستخدام البسكوت"),
      bi("Concrete compacted with vibrators; cubes taken from each pour and tested at an approved laboratory", "تدمك الخرسانة بالهزاز، وتؤخذ مكعبات من كل صبة وتفحص في مختبر معتمد"),
      bi("Curing for at least 7 days; soffit formwork struck not before 14 days unless the engineer approves", "معالجة الخرسانة لمدة لا تقل عن 7 أيام، ولا تفك قوالب الأسقف قبل 14 يوماً إلا بموافقة المهندس"),
      bi("Formwork true to line and level; honeycombing or exposed steel made good at the contractor's cost to the engineer's method", "تكون القوالب مستقيمة ومضبوطة المنسوب، ويعالج أي تعشيش أو ظهور للحديد على حساب المقاول وبالطريقة التي يحددها المهندس"),
    ],
    ownerSupplies: [
      bi("Ready-mix concrete, reinforcing steel, binding wire, bitumen and spacers", "الخرسانة الجاهزة وحديد التسليح وسلك الربط والبيتومين والبسكوت"),
      bi("Plywood and timber for formwork (unless the contractor's own formwork is used)", "الأبلكاش والخشب للقوالب (ما لم يستخدم المقاول قوالبه الخاصة)"),
      bi("Concrete pump and laboratory tests", "مضخة الخرسانة وفحوصات المختبر"),
    ],
    contractorProvides: [TOOLS, LABOUR, CLEAN, bi("Vibrators, props, steel cutting and bending equipment", "الهزازات والدعامات ومعدات قص وثني الحديد")],
    measurement: bi("Concrete by volume (m³) from the approved drawings; reinforcement by weight (t) from the bar schedules; formwork by contact area (m²)", "تحسب الخرسانة بالمتر المكعب من المخططات المعتمدة، والحديد بالطن من جداول التسليح، والقوالب بالمتر المربع لسطح التلامس"),
    labourShare: 0.3,
    durationDays: (b) => Math.round(75 + 35 * Math.max(0, b.levels - 1)),
    milestones: (b, mode) =>
      slabStages(b, {
        start: [
          ...(mode === "supply" ? [{ label: bi("Advance payment on signing and mobilisation", "دفعة مقدمة عند التوقيع والتجهيز للموقع"), pct: 10 }] : []),
          { label: bi("On completion of excavation and blinding", "عند الانتهاء من الحفر وصب النظافة"), pct: 8 },
          { label: bi("On completion of foundations, columns to ground level and tie beams", "عند الانتهاء من الأساسات والرقاب والميد"), pct: 20 },
          { label: bi("On completion of the ground slab", "عند الانتهاء من الأرضية الخرسانية"), pct: 10 },
        ],
        perSlab: 20,
        end: [{ label: bi("On completion of stairs, roof upstands and striking all formwork", "عند الانتهاء من الدرج والدراوي الخرسانية وفك جميع القوالب"), pct: 8 }],
      }),
    structural: true,
  },
  {
    id: "blockwork",
    title: bi("Blockwork", "أعمال البناء بالطابوق"),
    modes: ["labour", "supply"],
    match: (l) => /^wall:block/.test(l.key ?? ""),
    scope: [
      bi("Setting out walls and openings to the architectural drawings", "توقيع الجدران والفتحات حسب المخططات المعمارية"),
      bi("Building external walls in insulated block and internal walls in hollow block of the thicknesses scheduled", "بناء الجدران الخارجية بالطابوق العازل والداخلية بالطابوق المفرغ بالسماكات المحددة بجدول الكميات"),
      bi("Lintels over openings and fixing door frames as the work proceeds", "عمل الأعتاب فوق الفتحات وتثبيت حلوق الأبواب أثناء البناء"),
      bi("Parapets on roofs and terraces", "بناء الدراوي على السطح والتراسات"),
      bi("Leaving and closing chases and openings for services", "ترك الفتحات والمجاري للتمديدات وإغلاقها"),
    ],
    spec: [
      bi("Walls plumb and true; courses level with mortar joints of about 10 mm, fully filled", "تكون الجدران رأسية ومستقيمة والمداميك أفقية، مع عراميس بسماكة 10 مم تقريباً مملوءة بالكامل"),
      bi("Mortar 1 cement : 4 washed sand; blocks wetted before laying in hot weather", "المونة بنسبة 1 أسمنت : 4 رمل مغسول، وترش البلوكات بالماء قبل البناء في الجو الحار"),
      bi("Walls tied to columns with ties every third course; the top course packed tight to the slab", "تربط الجدران بالأعمدة بأشاير كل ثلاثة مداميك، ويحكم المدماك الأخير مع السقف"),
      bi("Cutting of block by machine; no broken block in face work", "يتم قص الطابوق بالماكينة، ولا يستخدم الطابوق المكسور في الواجهات"),
    ],
    ownerSupplies: [bi("Block, cement, washed sand, wall ties and lintel materials", "الطابوق والأسمنت والرمل المغسول وأشاير الربط ومواد الأعتاب")],
    contractorProvides: [TOOLS, LABOUR, CLEAN],
    measurement: bi("Net wall area (m²) by block thickness; openings over 0.5 m² deducted", "تحسب المساحة الصافية للجدران بالمتر المربع لكل سماكة، وتخصم الفتحات التي تزيد على 0.5 م²"),
    labourShare: 0.4,
    durationDays: (b) => Math.round(25 + 0.06 * b.floorArea),
    milestones: (b) => {
      const ms: Milestone[] = [];
      for (let i = 0; i < b.levels; i++) ms.push({ label: i === 0 ? bi("On completion of ground floor blockwork", "عند الانتهاء من بناء الدور الأرضي") : bi(`On completion of blockwork to floor ${i}`, `عند الانتهاء من بناء الدور رقم ${i}`), pct: 80 / b.levels });
      ms.push({ label: bi("On completion of parapets, chases closed and handover", "عند الانتهاء من الدراوي وإغلاق المجاري والتسليم"), pct: 20 });
      return normalise(ms);
    },
  },
  {
    id: "plaster",
    title: bi("Internal plaster and external render", "أعمال المساح الداخلي والخارجي"),
    modes: ["labour", "supply"],
    match: (l) => l.key === "wall:cement_plaster" || l.key === "wall:render_external",
    scope: [
      bi("Erecting external scaffolding for the render and keeping it safe until the render is complete", "تركيب السقالات الخارجية للمساح الخارجي والمحافظة على سلامتها حتى الانتهاء"),
      bi("Fixing door and window frames and sealing around openings", "تسكير الأبواب والنوافذ والفتحات"),
      bi("Applying a bonding agent to smooth concrete surfaces", "سحب مادة رابطة على الأسطح الخرسانية الناعمة"),
      bi("Fixing galvanised mesh over joints between block and concrete, frames and chases", "تثبيت الشبك المجلفن على فواصل الطابوق مع الخرسانة والحلوق ومجاري التمديدات"),
      bi("Splatter coat of washed sand, cement and SBR", "عمل الطرطشة من الرمل المغسول والأسمنت ومادة SBR"),
      bi("Corner beads and level screeds (dots) to square and plumb all walls and corners", "تركيب الزوايا وعمل الأوتار (الميزان) لضبط استقامة وتربيع الجدران والأركان"),
      bi("First (scratch) coat, then second (finishing) coat", "الوجه الأول الخشن (البطانة) ثم الوجه الثاني الناعم (الضهارة)"),
      bi("External render: base coat, sealant where needed and two protective coats", "المساح الخارجي: طبقة الأساس وأعمال السيلانت اللازمة ووجهان من مادة الحماية"),
    ],
    spec: [
      bi("Total plaster thickness 15–20 mm internally and 20–25 mm externally, in at least two coats", "سماكة المساح 15–20 مم داخلياً و20–25 مم خارجياً، على طبقتين على الأقل"),
      bi("Finished surfaces flat to within 3 mm under a 2 m straightedge; corners sharp, plumb and square", "لا يزيد الانحراف عن 3 مم تحت قدة طولها 2 متر، والأركان حادة ورأسية ومتعامدة"),
      bi("Each coat cured by wetting for at least 3 days; no work in direct midday sun on external walls in summer", "معالجة كل طبقة بالرش بالماء لمدة لا تقل عن 3 أيام، ولا يعمل على الواجهات تحت أشعة الشمس المباشرة وقت الظهيرة صيفاً"),
      bi("Plaster that is cracked, hollow-sounding or detached made good at the contractor's cost", "تعالج أي تشققات أو أجزاء مفرغة (تطبل) أو منفصلة على حساب المقاول"),
    ],
    ownerSupplies: [bi("Cement, washed sand, SBR, bonding agent, mesh, corner beads and protective coatings", "الأسمنت والرمل المغسول ومادة SBR والمادة الرابطة والشبك والزوايا ومواد الحماية")],
    contractorProvides: [TOOLS, LABOUR, CLEAN, bi("External scaffolding for the duration of the external render", "السقالات الخارجية طوال مدة المساح الخارجي")],
    measurement: bi("Plastered area (m²) of each face; openings deducted at half their area, reveals not paid separately; corner beads included in the rate", "تحسب المساحة الممسوحة بالمتر المربع لكل وجه، وتخصم الفتحات مناصفة، ولا تحسب جوانب الفتحات بشكل منفصل، والزوايا داخلة في السعر"),
    labourShare: 0.55,
    durationDays: (b) => Math.round(30 + 0.07 * b.floorArea),
    milestones: () =>
      simple(
        ["On erecting scaffolding, fixing frames, mesh and splatter coat", "بعد تركيب السقالات والتسكير ودق الشبك والطرطشة", 15],
        ["On completion of corner beads and level screeds", "بعد الانتهاء من تركيب الزوايا والأوتار", 15],
        ["On completion of the internal first coat", "بعد الانتهاء من الوجه الأول الداخلي (البطانة)", 20],
        ["On completion of the internal finishing coat", "بعد الانتهاء من الوجه الثاني الداخلي (الضهارة)", 20],
        ["On completion of the external render coats", "بعد الانتهاء من المساح الخارجي", 20],
        ["On completion of protective coats, removal of scaffolding and cleaning", "بعد الانتهاء من مواد الحماية وفك السقالات والتنظيف", 10],
      ),
  },
  {
    id: "waterproofing",
    title: bi("Roof waterproofing, insulation and screed", "أعمال العزل المائي والحراري للسطح"),
    modes: ["labour", "supply"],
    match: (l) => /^roof:/.test(l.key ?? ""),
    scope: [
      bi("Cleaning and priming the roof slab", "تنظيف سقف السطح ودهانه بالبرايمر"),
      bi("Lightweight / sand-cement screed to falls towards the rainwater outlets", "عمل الميول بالخرسانة الخفيفة أو المونة باتجاه مصارف الأمطار"),
      bi("Waterproofing membrane, turned up the parapets and around penetrations", "تركيب العزل المائي مع رفعه على الدراوي وحول الفتحات"),
      bi("Flood test for 48 hours before covering", "عمل اختبار الغمر بالماء لمدة 48 ساعة قبل التغطية"),
      bi("Thermal insulation boards, protection screed and roof tiles", "تركيب ألواح العزل الحراري وطبقة الحماية وبلاط السطح"),
    ],
    spec: [
      bi("Membrane laps at least 100 mm, fully bonded; upstands at least 300 mm", "لا يقل التراكب عن 100 مم مع اللصق الكامل، ولا يقل الرفع على الدراوي عن 300 مم"),
      bi("Falls at least 1:100 with no ponding after the flood test", "لا تقل الميول عن 1:100 ولا يتجمع الماء بعد اختبار الغمر"),
      bi("Leaks during the defects period repaired at the contractor's cost including making good finishes below", "تصلح أي تسربات خلال فترة الضمان على حساب المقاول شاملة إصلاح التشطيبات المتضررة"),
    ],
    ownerSupplies: [bi("Membrane, primer, insulation boards, screed materials and roof tiles", "مواد العزل والبرايمر وألواح العزل الحراري ومواد الميول وبلاط السطح")],
    contractorProvides: [TOOLS, LABOUR, CLEAN],
    measurement: bi("Plan area of the roof (m²); upstands included in the rate", "تحسب المساحة الأفقية للسطح بالمتر المربع، والرفع على الدراوي داخل في السعر"),
    labourShare: 0.35,
    durationDays: () => 21,
    milestones: () =>
      simple(
        ["On completion of the screed to falls", "بعد الانتهاء من الميول", 30],
        ["On completion of the membrane and a passed flood test", "بعد الانتهاء من العزل المائي ونجاح اختبار الغمر", 40],
        ["On completion of insulation, protection and tiles", "بعد الانتهاء من العزل الحراري والحماية والبلاط", 30],
      ),
  },
  {
    id: "tiling",
    title: bi("Floor and wall tiling, screed and skirting", "أعمال البلاط والأرضيات والوزرات"),
    modes: ["labour", "supply"],
    match: (l) => ((l.section === "A" || l.section === "B") && /^floor:/.test(l.key ?? "")) || ["skirting", "threshold", "floor:border"].includes(l.key ?? "") || (l.section === "B" && TILE_WALL.test(l.key ?? "")),
    scope: [
      bi("Sand-cement screed to levels", "عمل اللياسة الأرضية (الصبة) حسب المناسيب"),
      bi("Laying floor tiles, marble and other floor finishes to the approved layout", "تركيب بلاط الأرضيات والرخام وباقي التشطيبات حسب التوزيع المعتمد"),
      bi("Wall tiling in bathrooms, kitchen and feature walls", "تركيب بلاط الجدران في الحمامات والمطبخ والجدران المميزة"),
      bi("Skirting, thresholds and borders", "تركيب الوزرات والعتبات والإطارات"),
      bi("Grouting, silicone at junctions and final cleaning", "الترويب وعمل السيليكون عند الالتقاءات والتنظيف النهائي"),
    ],
    spec: [
      bi("Tiles laid on full adhesive bed; no hollow tiles (checked by tapping)", "تركب البلاطات على طبقة لاصق كاملة، ولا يقبل أي بلاط مفرغ (يفحص بالطرق)"),
      bi("Joints straight and even; lippage under 1 mm; floors to falls in wet areas", "تكون العراميس مستقيمة ومنتظمة، وفرق المنسوب بين البلاطات أقل من 1 مم، مع عمل الميول في المناطق الرطبة"),
      bi("Layout agreed with the owner before starting; cut tiles at least half a tile at walls", "يعتمد التوزيع من المالك قبل البدء، ولا يقل البلاط المقصوص عند الجدران عن نصف بلاطة"),
      bi("Finished work protected until handover", "حماية الأعمال المنفذة حتى التسليم"),
    ],
    ownerSupplies: [bi("Tiles, marble, adhesive, grout, screed materials, skirting and thresholds", "البلاط والرخام واللاصق والترويب ومواد اللياسة الأرضية والوزرات والعتبات")],
    contractorProvides: [TOOLS, LABOUR, CLEAN, bi("Tile cutting machines and levelling systems", "ماكينات قص البلاط وأنظمة ضبط المنسوب")],
    measurement: bi("Net area laid (m²); skirting and borders by length (m)", "تحسب المساحة الصافية المنفذة بالمتر المربع، والوزرات والإطارات بالمتر الطولي"),
    labourShare: 0.35,
    durationDays: (b) => Math.round(25 + 0.06 * b.floorArea),
    milestones: () =>
      simple(
        ["On completion of screeds", "بعد الانتهاء من اللياسة الأرضية", 15],
        ["On completion of wall tiling", "بعد الانتهاء من بلاط الجدران", 25],
        ["On completion of floor tiling", "بعد الانتهاء من بلاط الأرضيات", 40],
        ["On completion of skirting, grouting and cleaning", "بعد الانتهاء من الوزرات والترويب والتنظيف", 20],
      ),
  },
  {
    id: "painting",
    title: bi("Painting and wall finishes", "أعمال الدهانات وتشطيبات الجدران"),
    modes: ["labour", "supply"],
    match: (l) => (l.section === "B" && /^wall:/.test(l.key ?? "") && !/^wall:(block|cement_plaster)/.test(l.key ?? "") && !TILE_WALL.test(l.key ?? "")) || /^(wainscot:|rail$)/.test(l.key ?? ""),
    scope: [
      bi("Preparing surfaces: filling, sanding and priming", "تجهيز الأسطح: المعجون والصنفرة والبرايمر"),
      bi("Two coats of putty and two finishing coats of paint in the approved colours", "وجهان معجون ووجهان دهان نهائي بالألوان المعتمدة"),
      bi("Wallpaper, wall coverings and decorative finishes where scheduled", "تركيب ورق الجدران والكسوات والتشطيبات الديكورية حيث وردت بجدول الكميات"),
      bi("Wainscoting and rails where scheduled", "تركيب التجاليد الجدارية والبراويز حيث وردت"),
    ],
    spec: [
      bi("Colours approved on a sample panel before starting", "تعتمد الألوان على عينة في الموقع قبل البدء"),
      bi("Uniform colour and sheen with no brush marks, runs or patches", "يكون اللون واللمعة منتظمين دون آثار فرشاة أو سيلان أو بقع"),
      bi("Floors, fittings and glass protected; spatter cleaned", "حماية الأرضيات والأدوات والزجاج وتنظيف أي رذاذ"),
    ],
    ownerSupplies: [bi("Paint, putty, primer, wallpaper and adhesives", "الدهانات والمعجون والبرايمر وورق الجدران والمواد اللاصقة")],
    contractorProvides: [TOOLS, LABOUR, CLEAN, bi("Masking and protection materials", "مواد التغطية والحماية")],
    measurement: bi("Area painted or covered (m²); openings over 0.5 m² deducted", "تحسب المساحة المدهونة أو المكسوة بالمتر المربع، وتخصم الفتحات التي تزيد على 0.5 م²"),
    labourShare: 0.6,
    durationDays: (b) => Math.round(20 + 0.04 * b.floorArea),
    milestones: () =>
      simple(
        ["On completion of preparation and putty coats", "بعد الانتهاء من التجهيز والمعجون", 40],
        ["On completion of the first finishing coat", "بعد الانتهاء من الوجه الأول", 30],
        ["On completion of the final coat, wall coverings and touch-up", "بعد الانتهاء من الوجه النهائي والكسوات والتشطيب", 30],
      ),
  },
  {
    id: "ceilings",
    title: bi("Gypsum ceilings and ceiling finishes", "أعمال الأسقف المعلقة (الجبس بورد) وتشطيبات الأسقف"),
    modes: ["labour", "supply"],
    match: (l) => l.section === "C",
    scope: [
      bi("Suspended gypsum board ceilings on galvanised framing to the reflected ceiling plan", "تركيب الأسقف المعلقة من الجبس بورد على هيكل مجلفن حسب مخطط الأسقف"),
      bi("Bulkheads, tray ceilings, coves, cornices and access panels", "عمل الجوانب والأسقف المدرجة والإضاءة المخفية والكرانيش وفتحات الصيانة"),
      bi("Openings for light fittings, AC grilles and detectors coordinated with the services", "عمل فتحات الإنارة وفتحات التكييف والكواشف بالتنسيق مع التمديدات"),
      bi("Jointing, filling, sanding and painting of ceilings and slab soffits", "معالجة الفواصل والمعجون والصنفرة ودهان الأسقف"),
    ],
    spec: [
      bi("Moisture-resistant board in wet areas; framing at manufacturer's spacing", "استخدام ألواح مقاومة للرطوبة في المناطق الرطبة، والهيكل بالمسافات حسب توصيات المصنع"),
      bi("Ceilings level within 3 mm over 3 m; joints invisible after painting", "لا يزيد الانحراف عن 3 مم لكل 3 أمتار، ولا تظهر الفواصل بعد الدهان"),
    ],
    ownerSupplies: [bi("Gypsum boards, framing, fixings, joint compound, cornices and paint", "ألواح الجبس والهيكل والمسامير ومعجون الفواصل والكرانيش والدهان")],
    contractorProvides: [TOOLS, LABOUR, CLEAN, bi("Mobile scaffolds for ceiling work", "السقالات المتحركة لأعمال الأسقف")],
    measurement: bi("Ceiling area (m²); bulkheads, coves and cornices by length (m)", "تحسب الأسقف بالمتر المربع، والجوانب والإضاءة المخفية والكرانيش بالمتر الطولي"),
    labourShare: 0.45,
    durationDays: (b) => Math.round(20 + 0.04 * b.floorArea),
    milestones: () =>
      simple(
        ["On completion of framing", "بعد الانتهاء من تركيب الهيكل", 35],
        ["On completion of boarding, bulkheads and openings", "بعد الانتهاء من تركيب الألواح والجوانب والفتحات", 35],
        ["On completion of jointing, cornices and painting", "بعد الانتهاء من معالجة الفواصل والكرانيش والدهان", 30],
      ),
  },
  {
    id: "doors_windows",
    title: bi("Doors, windows and window treatments", "أعمال الأبواب والنوافذ والستائر"),
    modes: ["supply"],
    match: (l) => l.section === "D",
    scope: [
      bi("Site measurement of all openings before manufacture", "أخذ المقاسات من الموقع لجميع الفتحات قبل التصنيع"),
      bi("Supply and installation of the doors, frames and ironmongery scheduled", "توريد وتركيب الأبواب والحلوق والإكسسوارات الواردة بجدول الكميات"),
      bi("Supply and installation of aluminium double-glazed windows with seals", "توريد وتركيب نوافذ الألمنيوم بالزجاج المزدوج مع أعمال العزل"),
      bi("Window treatments (curtains, blinds) where scheduled", "توريد وتركيب الستائر حيث وردت"),
      bi("Adjustment, protection film removal and cleaning on handover", "الضبط وإزالة أغطية الحماية والتنظيف عند التسليم"),
    ],
    spec: [
      bi("Shop drawings and samples approved by the owner before manufacture", "تعتمد المخططات التنفيذية والعينات من المالك قبل التصنيع"),
      bi("Windows watertight and airtight; sealed with silicone to the plaster", "تكون النوافذ محكمة ضد الماء والهواء مع عمل السيليكون مع المساح"),
      bi("Doors hung plumb, operating smoothly, with even gaps", "تركب الأبواب رأسية وتعمل بسلاسة مع فراغات منتظمة"),
    ],
    ownerSupplies: [],
    contractorProvides: [TOOLS, LABOUR, CLEAN],
    measurement: bi("Doors by number; windows by area (m²) of the opening", "تحسب الأبواب بالعدد والنوافذ بالمتر المربع لمساحة الفتحة"),
    labourShare: 0.2,
    durationDays: () => 60,
    milestones: (_b, mode) =>
      mode === "supply"
        ? simple(
            ["Advance payment on approval of shop drawings and samples", "دفعة مقدمة عند اعتماد المخططات والعينات", 30],
            ["On delivery of doors and windows to site", "عند توريد الأبواب والنوافذ للموقع", 40],
            ["On completion of installation", "عند الانتهاء من التركيب", 20],
            ["On adjustment, cleaning and handover", "عند الضبط والتنظيف والتسليم", 10],
          )
        : simple(["On completion of installation", "عند الانتهاء من التركيب", 70], ["On adjustment and handover", "عند الضبط والتسليم", 30]),
  },
  {
    id: "electrical",
    title: bi("Electrical installation", "أعمال الكهرباء"),
    modes: ["labour", "supply"],
    match: (l) => l.section === "F",
    scope: [
      bi("Conduits and boxes in slabs and walls (first fix) to the approved electrical layout", "تمديد المواسير والعلب في الأسقف والجدران (التمديد الأول) حسب المخطط الكهربائي المعتمد"),
      bi("Pulling cables for lighting, power, data and TV circuits", "سحب الأسلاك لدوائر الإنارة والقوى والبيانات والتلفزيون"),
      bi("Distribution boards, breakers and RCDs, labelled", "تركيب لوحات التوزيع والقواطع وقواطع التسرب الأرضي مع الترقيم"),
      bi("Fixing switches, sockets, light fittings, fans and detectors (second fix)", "تركيب المفاتيح والأفياش ووحدات الإنارة والشفاطات والكواشف (التركيب النهائي)"),
      bi("Testing, Ministry of Electricity inspection and connection", "الفحص والاختبار وتجهيز المبنى لفحص وزارة الكهرباء والتوصيل"),
    ],
    spec: [
      bi("Work to Ministry of Electricity and Water regulations; cable sizes to the approved schedule", "تنفذ الأعمال طبقاً لاشتراطات وزارة الكهرباء والماء، وأحجام الكابلات حسب الجدول المعتمد"),
      bi("Insulation resistance and earth tests recorded and handed to the owner", "تسجل نتائج فحص العزل والأرضي وتسلم للمالك"),
      bi("Accessories level and aligned at the agreed heights", "تركب الإكسسوارات أفقية ومتراصة على الارتفاعات المتفق عليها"),
    ],
    ownerSupplies: [bi("Conduits, boxes, cables, boards, breakers, switches, sockets and light fittings", "المواسير والعلب والأسلاك واللوحات والقواطع والمفاتيح والأفياش ووحدات الإنارة")],
    contractorProvides: [TOOLS, LABOUR, CLEAN, bi("Test instruments", "أجهزة الفحص والقياس")],
    measurement: bi("By point (switch, socket, light point) and by item as scheduled", "تحسب بالنقطة (مفتاح، فيش، نقطة إنارة) وبالعدد حسب جدول الكميات"),
    labourShare: 0.4,
    durationDays: (b) => Math.round(45 + 0.05 * b.floorArea),
    milestones: (b) =>
      slabStages(b, {
        start: [],
        perSlab: 8,
        slab: (n) =>
          n === "roof"
            ? bi("On completion of conduits and boxes in the roof slab", "بعد الانتهاء من تمديد المواسير والعلب في سقف السطح")
            : bi(`On completion of conduits and boxes in the ${ord(n).en} suspended slab`, `بعد الانتهاء من تمديد المواسير والعلب في سقف الدور رقم ${n}`),
        end: [
          { label: bi("On completion of wall conduits and boxes", "بعد الانتهاء من تمديدات الجدران والعلب"), pct: 25 },
          { label: bi("On completion of cable pulling and boards", "بعد الانتهاء من سحب الأسلاك وتركيب اللوحات"), pct: 25 },
          { label: bi("On completion of second fix, testing and passed inspection", "بعد الانتهاء من التركيب النهائي والفحص واجتياز التفتيش"), pct: 25 },
        ],
      }),
  },
  {
    id: "plumbing",
    title: bi("Plumbing and sanitary installation", "أعمال الصحي (التمديدات الصحية)"),
    modes: ["labour", "supply"],
    match: (l) => l.section === "G",
    scope: [
      bi("Underground drainage, manholes and connection to the public sewer", "التمديدات الأرضية للصرف وغرف التفتيش والتوصيل بالمجاري العامة"),
      bi("Soil and waste stacks and branches", "تمديد مواسير الصرف الرأسية والفرعية"),
      bi("Hot and cold water pipework, valves and tank connections", "تمديدات المياه الحارة والباردة والمحابس والتوصيل بالخزانات"),
      bi("Fixing sanitary ware, mixers, floor drains and water heaters (second fix)", "تركيب الأدوات الصحية والخلاطات والجلي الأرضي والسخانات (التركيب النهائي)"),
      bi("Pressure tests, leak tests and handover", "اختبارات الضغط والتسرب والتسليم"),
    ],
    spec: [
      bi("Water pipes pressure-tested at 1.5 times working pressure for 24 hours before closing", "تختبر مواسير المياه بضغط 1.5 مرة من ضغط التشغيل لمدة 24 ساعة قبل التغطية"),
      bi("Drains laid to falls and tested with water before backfilling", "تمدد مواسير الصرف بالميول اللازمة وتختبر بالماء قبل الردم"),
      bi("Fixtures level, sealed, and free of leaks", "تركب الأدوات أفقية ومحكمة دون أي تسرب"),
    ],
    ownerSupplies: [bi("Pipes, fittings, valves, sanitary ware, mixers, drains and water heaters", "المواسير والقطع والمحابس والأدوات الصحية والخلاطات والجلي والسخانات")],
    contractorProvides: [TOOLS, LABOUR, CLEAN, bi("Test pumps and gauges", "مضخات وعدادات الاختبار")],
    measurement: bi("Pipework by length (m); fixtures and points by number", "تحسب المواسير بالمتر الطولي، والأدوات والنقاط بالعدد"),
    labourShare: 0.4,
    durationDays: (b) => Math.round(45 + 0.05 * b.floorArea),
    milestones: () =>
      simple(
        ["On completion of underground drainage and a passed test", "بعد الانتهاء من التمديدات الأرضية ونجاح الاختبار", 25],
        ["On completion of stacks and water pipework with passed pressure tests", "بعد الانتهاء من مواسير الصرف والمياه ونجاح اختبارات الضغط", 35],
        ["On completion of second fix", "بعد الانتهاء من تركيب الأدوات الصحية", 25],
        ["On final testing and handover", "بعد الفحص النهائي والتسليم", 15],
      ),
  },
  {
    id: "hvac",
    title: bi("Air conditioning (HVAC)", "أعمال التكييف"),
    modes: ["supply"],
    match: (l) => l.section === "J",
    scope: [
      bi("Shop drawings of the units, duct routes and sizes, and the riser, coordinated with the false ceilings and the structure, for approval", "تقديم المخططات التنفيذية للوحدات ومسارات ومقاسات مجاري الهواء والمنور، بالتنسيق مع الأسقف المعلقة والهيكل، للاعتماد"),
      bi("Supply and installation of the air-conditioning units scheduled, on steel bases with anti-vibration mounts (roof units) or concealed in the ceilings", "توريد وتركيب وحدات التكييف الواردة بالجدول على قواعد حديدية مع مانعات الاهتزاز (وحدات السطح) أو مخفية في الأسقف"),
      bi("Galvanised sheet-steel supply and return ductwork with thermal insulation, hangers, risers and fittings", "مجاري الهواء للتغذية والراجع من الصاج المجلفن مع العزل الحراري والتعليق والمناور والقطع"),
      bi("Supply diffusers, return grilles, plenum boxes and flexible connections", "فتحات التغذية والراجع مع الصناديق والوصلات المرنة"),
      bi("Thermostats, control wiring, condensate drains and the electrical connection from the isolator", "منظمات الحرارة وأسلاك التحكم وتصريف المكثفات والتوصيل الكهربائي من مفتاح العزل"),
      bi("Openings and sleeves through walls and slabs, sealed and fire-stopped", "عمل الفتحات والجلب في الجدران والأسقف وإحكامها"),
      bi("Testing, air balancing to the design airflows, commissioning, and handover with manuals and warranties", "الفحص وموازنة الهواء حسب التصميم والتشغيل، والتسليم مع الكتالوجات وشهادات الضمان"),
    ],
    spec: [
      bi("Units of the approved brand and capacity, rated for 52 °C ambient; capacities not less than the schedule at Kuwait design conditions", "الوحدات من الماركة والقدرة المعتمدة ومناسبة للعمل عند حرارة 52 درجة مئوية، ولا تقل قدراتها عن الجدول عند ظروف التصميم في الكويت"),
      bi("Ductwork to SMACNA practice, joints sealed, insulated with at least 25 mm insulation and vapour barrier; no duct in a ceiling void shallower than the approved section", "تنفذ مجاري الهواء حسب أصول SMACNA مع إحكام الوصلات، وتعزل بسماكة لا تقل عن 25 مم مع عازل للرطوبة"),
      bi("Each diffuser balanced to within 10% of its design airflow; balancing report handed to the owner", "تتم موازنة كل فتحة تغذية بحدود 10% من كمية الهواء التصميمية، ويسلم تقرير الموازنة للمالك"),
      bi("Noise in bedrooms not above NC 30; units and fans isolated from the structure", "لا يزيد مستوى الضوضاء في غرف النوم على NC 30، مع عزل الوحدات والمراوح عن الهيكل"),
      bi("Compressor warranty of at least 5 years and full system warranty of at least 2 years", "ضمان الكمبروسر لمدة لا تقل عن 5 سنوات وضمان النظام كاملاً لمدة لا تقل عن سنتين"),
    ],
    ownerSupplies: [],
    contractorProvides: [TOOLS, LABOUR, CLEAN, bi("Cranes and lifting for the roof units, and all testing instruments", "الرافعات لرفع وحدات السطح وجميع أجهزة الفحص والقياس")],
    measurement: bi("Units by capacity (TR); ductwork by surface area (m²); diffusers, grilles and thermostats by number", "تحسب الوحدات بالطن التبريدي، ومجاري الهواء بالمتر المربع لسطح الصاج، والفتحات ومنظمات الحرارة بالعدد"),
    labourShare: 0.25,
    durationDays: (b) => Math.round(45 + 0.04 * b.floorArea),
    milestones: () =>
      simple(
        ["Advance payment on approval of shop drawings and the units' submittal", "دفعة مقدمة عند اعتماد المخططات التنفيذية والوحدات", 20],
        ["On completion of ductwork, risers and insulation (before the ceilings close)", "عند الانتهاء من مجاري الهواء والمناور والعزل (قبل إغلاق الأسقف)", 30],
        ["On delivery and installation of the units", "عند توريد وتركيب الوحدات", 30],
        ["On diffusers, grilles, controls, testing and balancing", "عند تركيب الفتحات ومنظمات الحرارة والفحص والموازنة", 15],
        ["On commissioning and handover", "عند التشغيل والتسليم", 5],
      ),
  },
  {
    id: "lifts",
    title: bi("Lifts (elevators)", "أعمال المصاعد"),
    modes: ["supply"],
    match: (l) => l.section === "K",
    scope: [
      bi("Shop drawings of the lift, shaft, pit and overrun requirements, for approval and coordination with the structure", "تقديم المخططات التنفيذية للمصعد ومتطلبات البئر والحفرة والغرفة العلوية للاعتماد والتنسيق مع الهيكل"),
      bi("Supply and installation of the lift scheduled: car, guide rails, drive, controller, landing doors and fixtures at every stop", "توريد وتركيب المصعد الوارد بالجدول: الكابينة والسكك والماكينة ولوحة التحكم وأبواب الأدوار والإكسسوارات في كل وقفة"),
      bi("Pit ladder, buffers, shaft lighting and the electrical connection from the isolator", "سلم الحفرة والمصدات وإنارة البئر والتوصيل الكهربائي من مفتاح العزل"),
      bi("Safety devices: overspeed governor and safety gear, door interlocks, alarm and intercom, automatic rescue to the nearest floor on power failure", "أجهزة الأمان: منظم السرعة والكوابح وأقفال الأبواب وجرس الإنذار والاتصال، والإنقاذ التلقائي لأقرب دور عند انقطاع الكهرباء"),
      bi("Testing, inspection by the competent authority, certification and handover with manuals", "الفحص والتفتيش من الجهة المختصة والشهادات والتسليم مع الكتالوجات"),
      bi("Free maintenance and breakdown service during the defects period", "الصيانة المجانية وخدمة الأعطال خلال فترة الضمان"),
    ],
    spec: [
      bi("Lift to EN 81-20 / 81-50 (or the equivalent standard approved in Kuwait); home lifts to EN 81-41", "يكون المصعد مطابقاً للمواصفة EN 81-20 / 81-50 أو ما يعادلها المعتمد في الكويت، والمصاعد المنزلية للمواصفة EN 81-41"),
      bi("Capacity, speed, car and door sizes not less than the schedule; stainless-steel car and landing doors unless the owner approves otherwise", "لا تقل الحمولة والسرعة ومقاسات الكابينة والأبواب عن الجدول، والكابينة وأبواب الأدوار من الستانلس ستيل ما لم يعتمد المالك غير ذلك"),
      bi("Levelling accuracy ±10 mm at every stop; noise in the car below 55 dB(A)", "دقة توقف ±10 مم في كل دور، ولا يزيد الضجيج داخل الكابينة على 55 ديسيبل"),
      bi("Shaft, pit and overrun dimensions checked by the lift contractor before the structure is cast", "يتحقق مقاول المصعد من أبعاد البئر والحفرة والغرفة العلوية قبل صب الهيكل"),
    ],
    ownerSupplies: [],
    contractorProvides: [TOOLS, LABOUR, CLEAN, bi("Scaffolding in the shaft, hoisting and all testing instruments", "السقالات داخل البئر والرفع وجميع أجهزة الفحص")],
    measurement: bi("Lifts by number with their stops; pit, overrun and power supply as itemised", "تحسب المصاعد بالعدد مع عدد الوقفات، والحفرة والغرفة العلوية والتغذية حسب البنود"),
    labourShare: 0.25,
    durationDays: () => 75,
    milestones: () =>
      simple(
        ["Advance payment on approval of shop drawings and the lift submittal", "دفعة مقدمة عند اعتماد المخططات والمصعد", 30],
        ["On delivery of the lift materials to site", "عند توريد مواد المصعد للموقع", 40],
        ["On completion of installation", "عند الانتهاء من التركيب", 20],
        ["On testing, certification and handover", "عند الفحص والشهادات والتسليم", 10],
      ),
  },
  {
    id: "joinery",
    title: bi("Kitchens and built-in joinery", "أعمال المطابخ والنجارة المثبتة"),
    modes: ["supply"],
    match: (l) => l.section === "E",
    scope: [
      bi("Site measurement and shop drawings for approval", "أخذ المقاسات وتقديم المخططات التنفيذية للاعتماد"),
      bi("Supply and installation of kitchen cabinets, worktops, wardrobes and built-in units scheduled", "توريد وتركيب خزائن المطبخ والأسطح والخزائن الجدارية والوحدات المثبتة الواردة بجدول الكميات"),
      bi("Connection of sinks and appliances with the plumbing and electrical trades", "توصيل الأحواض والأجهزة بالتنسيق مع أعمال الصحي والكهرباء"),
      bi("Adjustment of doors and drawers and cleaning on handover", "ضبط الأبواب والأدراج والتنظيف عند التسليم"),
    ],
    spec: [
      bi("Materials, colours and hardware to the approved samples", "المواد والألوان والإكسسوارات حسب العينات المعتمدة"),
      bi("Units level and plumb, fixed to walls, doors aligned with even gaps", "تركب الوحدات أفقية ورأسية ومثبتة بالجدران، والأبواب متراصة بفراغات منتظمة"),
    ],
    ownerSupplies: [],
    contractorProvides: [TOOLS, LABOUR, CLEAN],
    labourShare: 0.2,
    durationDays: () => 45,
    milestones: () =>
      simple(
        ["Advance payment on approval of shop drawings", "دفعة مقدمة عند اعتماد المخططات", 40],
        ["On delivery to site", "عند التوريد للموقع", 40],
        ["On installation and handover", "عند التركيب والتسليم", 20],
      ),
  },
  {
    id: "external",
    title: bi("External works: terraces and balustrades", "الأعمال الخارجية: التراسات والدرابزينات"),
    modes: ["labour", "supply"],
    match: (l) => l.section === "I",
    scope: [
      bi("Terrace and patio decks and paving to falls", "تنفيذ أرضيات التراسات والحوش بالميول اللازمة"),
      bi("Balustrades and railings fixed to the structure", "توريد وتركيب الدرابزينات والحواجز وتثبيتها بالهيكل"),
    ],
    spec: [
      bi("Balustrades at least 1.1 m high and able to resist the code load", "لا يقل ارتفاع الدرابزين عن 1.1 متر ويتحمل الأحمال المطلوبة"),
      bi("External paving to falls away from the building", "تنفذ الأرضيات الخارجية بميول بعيداً عن المبنى"),
    ],
    ownerSupplies: [bi("Paving, decking and balustrade materials", "مواد الأرضيات الخارجية والدرابزينات")],
    contractorProvides: [TOOLS, LABOUR, CLEAN],
    measurement: bi("Paving by area (m²); balustrades by length (m)", "تحسب الأرضيات بالمتر المربع والدرابزينات بالمتر الطولي"),
    labourShare: 0.35,
    durationDays: () => 30,
    milestones: () => simple(["On completion of paving and decks", "بعد الانتهاء من الأرضيات", 60], ["On completion of balustrades and handover", "بعد الانتهاء من الدرابزينات والتسليم", 40]),
  },
];

export const PACKAGE_IDS = PACKAGES.map((p) => p.id) as [string, ...string[]];

export function packageById(id: string): TradePackage {
  const p = PACKAGES.find((x) => x.id === id);
  if (!p) throw new Error(`unknown contract package '${id}' (packages: ${PACKAGE_IDS.join(", ")})`);
  return p;
}
