/** Arabic names for bill items and units, so the Arabic schedule of quantities reads naturally. */

const UNIT_AR: Record<string, string> = { "m²": "م²", "m³": "م³", m: "م.ط", no: "عدد", each: "عدد", t: "طن", lm: "م.ط", item: "مقطوعية" };
export const unitAr = (u: string) => UNIT_AR[u] ?? u;

const FLOOR: Record<string, string> = {
  herringbone: "باركيه خشب (هيرنغبون)", chevron: "باركيه خشب (شيفرون)", wood_planks: "أرضيات خشبية", wood_grain: "أرضيات خشبية", parquet: "باركيه",
  tiles: "بلاط بورسلان", hex_tiles: "بلاط سداسي", mosaic: "موزاييك", zellige: "بلاط زليج", terrazzo: "تيرازو", marble: "رخام", stone: "حجر طبيعي",
  microcement: "مايكروسمنت", concrete: "خرسانة مصقولة", carpet: "موكيت", gravel: "حصى", paving: "بلاط خارجي", plaster: "تشطيب جصي", other: "تشطيب أرضيات",
};
const WALL: Record<string, string> = {
  plaster: "دهان الجدران", wallpaper: "ورق جدران", grasscloth: "كسوة جدران طبيعية", fabric: "كسوة جدران قماش", microcement: "مايكروسمنت للجدران",
  fluted: "تجاليد شرائح خشبية", tiles: "بلاط جدران", zellige: "بلاط زليج للجدران", mosaic: "موزاييك للجدران", hex_tiles: "بلاط سداسي للجدران",
  marble: "رخام للجدران", stone: "حجر للجدران", brick: "طوب واجهات", concrete: "خرسانة ظاهرة", wood_grain: "تجاليد خشبية", wood_planks: "تجاليد خشبية",
  drywall: "جدران جبس بورد", glass_partition: "قواطع زجاجية", timber_stud: "قواطع خشبية", other: "تشطيب جدران",
};
const BLOCK: Record<string, string> = {
  block_insulated_200: "بناء بالطابوق العازل سماكة 20 سم", block_200: "بناء بالطابوق المفرغ سماكة 20 سم", block_150: "بناء بالطابوق المفرغ سماكة 15 سم", block_100: "بناء بالطابوق المفرغ سماكة 10 سم",
};
const POINT: Record<string, string> = {
  switch: "مفتاح", switch_2way: "مفتاح ثنائي الاتجاه", dimmer: "مفتاح تحكم بالإضاءة", double_socket: "فيش مزدوج", socket: "فيش مفرد", usb_socket: "فيش مع منفذ USB",
  data: "نقطة بيانات (Cat6)", tv: "نقطة تلفزيون", shaver: "فيش ماكينة حلاقة", cooker: "نقطة طباخ", spur: "نقطة أجهزة بفيوز", fan: "شفاط مع الدكت", ac: "نقطة تكييف",
  db: "لوحة توزيع شاملة القواطع وقواطع التسرب", smoke: "كاشف دخان", heat: "كاشف حرارة", doorbell: "جرس الباب", light_point: "نقطة إنارة",
};
const FIXTURE: Record<string, string> = {
  downlight: "سبوت سقفي", pendant: "إنارة معلقة", chandelier: "ثريا", ceiling: "إنارة سقفية", spot: "سبوت", track: "إنارة مسار", wall_sconce: "إنارة جدارية", strip: "شريط إضاءة LED", uplight: "إنارة أرضية",
};
const EXACT: Record<string, string> = {
  "earthworks:m3": "الحفر والردم والدك للأساسات",
  "struct:blinding_m3": "خرسانة عادية (نظافة) سماكة 10 سم تحت الأساسات والأرضية",
  "substructure:bitumen": "دهان الخرسانة المدفونة بالبيتومين",
  "struct:rebar_t": "حديد التسليح شامل القص والثني والتركيب",
  "struct:formwork_m2": "القوالب (النجارة المسلحة) للأسقف والأعمدة والجسور والأساسات",
  "struct:timber_floor": "أرضيات خشبية إنشائية",
  "wall:cement_plaster": "مساح داخلي (أسمنت ورمل) على وجهين",
  "wall:render_external": "مساح خارجي للواجهات",
  "floor:screed": "لياسة أرضية (صبة) من الأسمنت والرمل",
  "floor:border": "إطارات الأرضيات",
  "roof:screed_tiles": "ميول السطح وبلاط الحماية",
  "roof:waterproofing": "العزل المائي للسطح",
  "roof:insulation": "العزل الحراري للسطح",
  "roof:tiles": "قرميد الأسقف المائلة",
  threshold: "العتبات",
  skirting: "الوزرات",
  rail: "البراويز الجدارية",
  "wainscot:panels": "تجاليد جدارية",
  "ceiling:gypsum": "سقف معلق جبس بورد شامل الدهان",
  "ceiling:skim": "معجون ودهان الأسقف الخرسانية",
  "ceiling:soffit": "جوانب الأسقف المعلقة",
  "ceiling:cove": "إضاءة مخفية (بروفايل وشريط ومحول)",
  "ceiling:beam": "جسور ديكورية للسقف",
  "ceiling:coffer": "أسقف غائرة (إضافي)",
  cornice: "كرانيش",
  "door:front": "باب المدخل الرئيسي شامل الإكسسوارات والقفل",
  "door:single": "باب داخلي شامل الحلق والإكسسوارات",
  "door:double": "باب مزدوج شامل الحلق والإكسسوارات",
  "door:sliding": "باب سحاب",
  "door:glass": "باب زجاجي",
  "door:garage": "باب الكراج",
  "door:opening": "فتحة باب: تلبيس وإطارات",
  window: "نوافذ ألمنيوم بزجاج مزدوج",
  circuit: "الدوائر الكهربائية (كابلات ومواسير)",
  "plumbing:first_fix": "التمديد الأول لكل نقطة (محابس وتوصيلات)",
  "plumbing:stack": "توصيلات مواسير الصرف الرأسية",
  "plumbing:water_heater": "سخانات مياه كهربائية",
  "plumbing:inlet": "المحبس الرئيسي وتوصيل العداد",
  "pipe:cold": "مواسير المياه الباردة (PPR)",
  "pipe:hot": "مواسير المياه الحارة معزولة",
  "pipe:waste": "مواسير الصرف (uPVC)",
  "pipe:soil": "مواسير الصرف الصحي 100 مم (uPVC)",
  "sanitary:bath": "بانيو شامل الخلاط والصرف",
  "sanitary:wc": "مرحاض شامل السيفون والغطاء",
  "sanitary:basin": "مغسلة شاملة الخلاط والصرف",
  "sanitary:shower": "دش: خلاط وصرف وفاصل زجاجي",
  "sanitary:sink": "حوض مطبخ شامل الخلاط",
  "sanitary:tap": "خلاط",
  "sanitary:floor_drain": "جلي أرضي",
  "joinery:kitchen_base": "خزائن مطبخ سفلية شاملة الأبواب والإكسسوارات",
  "joinery:kitchen_upper": "خزائن مطبخ علوية",
  "joinery:kitchen_tall": "خزائن مطبخ طويلة",
  "joinery:worktop": "سطح المطبخ",
  "joinery:wardrobe": "خزائن ملابس مثبتة",
  "joinery:vanity": "وحدة مغسلة",
  "joinery:media": "وحدة تلفزيون مثبتة",
  "joinery:shelving": "أرفف مثبتة",
  "joinery:desk": "مكتب مثبت",
  "joinery:bench": "مقعد مثبت",
  "install:cabinet": "تجميع وتركيب الخزائن",
  "install:worktop": "قص وتركيب الأسطح",
  "install:appliance": "توصيل الأجهزة",
  "plumbing:booster_set": "مضخة رفع ضغط مع خزان ضغط ولوحة تحكم",
  "plumbing:transfer_pump": "مضخة نقل المياه من الخزان الأرضي إلى خزانات السطح مع العوامات",
  "plumbing:roof_tank_gal": "خزانات مياه علوية من الفايبرجلاس مع العوامة والفائض والقاعدة (بالجالون)",
  "plumbing:ground_tank_m3": "خزان مياه أرضي من الخرسانة المسلحة المعزولة مع الحفر وغطاء الفتحة",
  "plumbing:riser_m": "خط الصاعد الرئيسي للمياه معزول مع محابس في كل دور",
  "screen:slats": "سواتر خشبية (شرائح رأسية أو أفقية) من الخشب الصلب المعالج على كوابيل حديدية",
  "pergola:timber": "برجولا خشبية: أعمدة وجسور محيطية وشرائح علوية معالجة على قواعد",
  "landscape:lawn": "نجيل طبيعي: تربة حلوة 150 مم مع السماد وتسوية وفرش النجيل والري",
  "landscape:turf": "عشب صناعي 35–40 مم على قاعدة مدكوكة مع حشوة الرمل",
  "landscape:planting": "أحواض زراعة: تربة حلوة 300 مم ونباتات تغطية وزهور موسمية",
  "landscape:gravel": "حصى تجميلي 50 مم على قماش مانع للحشائش مع حواف حديدية",
  "landscape:mulch": "ملش لحاء الأشجار 75 مم على قماش مانع للحشائش",
  "landscape:paving": "أرضيات الحديقة (انترلوك / حجر) على طبقة رمل وقاعدة مدكوكة",
  "landscape:sand": "منطقة رملية مسواة ومدكوكة",
  "landscape:tree": "أشجار 2.5–3 م مع الحفرة والتربة الحلوة والتدعيم",
  "landscape:palm": "نخيل (ساق 3–4 م) مع الحفرة والتربة الحلوة والتدعيم",
  "landscape:shrub": "شجيرات 0.6–1 م مزروعة",
  "landscape:hedge": "سور نباتي بمعدل 3 شتلات للمتر",
  "irrigation:spray_head": "رشاشات منبثقة مع فوهات قابلة للضبط ووصلات مرنة",
  "irrigation:drip_m": "خط تنقيط 16 مم بمنقطات 2 لتر/ساعة منظمة للضغط كل 300 مم",
  "irrigation:bubbler": "فقاعات ري للأشجار على قوائم 16 مم",
  "irrigation:emitter": "منقطات للشجيرات والأحواض",
  "irrigation:pipe_m": "أنابيب بولي إيثيلين 25–32 مم (رئيسي وفرعي) مع الحفر 300 مم والجلب تحت الممرات",
  "irrigation:valve": "محابس كهربائية للمناطق 1 بوصة مع الوصلات",
  "irrigation:valve_box": "غرفة محابس أرضية بغطاء مقفل",
  "irrigation:controller": "وحدة تحكم الري مع حساس المطر/الحرارة والتمديدات للمحابس",
  "lift:base": "مصعد شامل الكابينة وأبواب الأدوار ولوحة التحكم لوقفتين مع الفحص والتسليم",
  "lift:per_stop": "وقفات إضافية للمصعد",
  "lift:home_lift": "مصعد منزلي صغير شامل الكابينة والأبواب ولوحة التحكم",
  "lift:pit": "حفرة المصعد: الحفر والخرسانة المسلحة المعزولة والسلم",
  "lift:overrun": "غرفة المصعد العلوية (Overrun) من الخرسانة المسلحة فوق السطح مع العزل",
  "lift:power_supply": "التغذية الكهربائية ثلاثية الأطوار للمصعد ومفتاح العزل وإنارة البئر",
  "hvac:packaged_tr": "وحدة تكييف مركزية (باكج) على السطح شاملة القاعدة الحديدية والتوصيلات والتشغيل",
  "hvac:ducted_split_tr": "وحدة تكييف مخفية (دكت سبليت) مع الوحدة الخارجية على السطح",
  "hvac:split_tr": "وحدة تكييف جدارية (سبليت) مع الوحدة الخارجية",
  "hvac:duct_m2": "مجاري الهواء (دكت) من الصاج المجلفن المعزول شاملة التعليق والقطع",
  "hvac:diffuser": "فتحات تكييف (دفيوزر) 60×60 شاملة الصناديق والوصلات المرنة",
  "hvac:return_grille": "فتحات الراجع (جريل) شاملة الصناديق",
  "hvac:thermostat": "منظمات حرارة (ثرموستات) جدارية شاملة الأسلاك",
  "hvac:power_supply": "التغذية الكهربائية لكل وحدة: كابل من اللوحة ومفتاح عزل",
  "hvac:commissioning": "الفحص وموازنة الهواء والتشغيل",
  "appliance:dishwasher": "غسالة صحون مدمجة",
  "appliance:extractor": "شفاط مطبخ",
  "appliance:oven": "فرن",
  "appliance:hob": "موقد طبخ",
  "appliance:fridge": "ثلاجة",
  "appliance:microwave": "مايكروويف",
};
const STRUCT_BY_DESC: [RegExp, string][] = [
  [/foundations/i, "خرسانة مسلحة للأساسات والميد"],
  [/ground-bearing slab/i, "الأرضية الخرسانية المسلحة"],
  [/suspended floor slab/i, "الأسقف الخرسانية المسلحة للأدوار"],
  [/roof slab/i, "سقف السطح الخرساني المسلح"],
  [/columns?|beams?/i, "الأعمدة والجسور الخرسانية المسلحة"],
  [/stair/i, "الدرج الخرساني المسلح"],
  [/RC walls?|retaining/i, "الجدران الخرسانية المسلحة"],
];

/** Arabic description of a bill line, from its rate key (and the English text for the generic ones). */
export function itemAr(key: string | undefined, en: string): string {
  if (!key) return `توريد: ${en}`;
  if (key === "wall:cement_plaster")
    return /inner face of external/i.test(en) ? "مساح داخلي للوجه الداخلي للجدران الخارجية والدراوي" : /internal walls/i.test(en) ? "مساح داخلي للجدران الداخلية (وجهان)" : EXACT[key];
  if (EXACT[key]) return EXACT[key];
  const [head, rest = ""] = key.split(":");
  if (head === "struct" && rest === "concrete_m3") return STRUCT_BY_DESC.find(([re]) => re.test(en))?.[1] ?? "خرسانة مسلحة";
  if (head === "wall" && BLOCK[rest]) return /parapet/i.test(en) ? `دراوي السطح: ${BLOCK[rest]}` : /external/i.test(en) ? `الجدران الخارجية: ${BLOCK[rest]}` : `الجدران الداخلية: ${BLOCK[rest]}`;
  if (head === "floor") return /terrace|deck/i.test(en) ? `أرضيات التراس: ${FLOOR[rest] ?? FLOOR.other}` : `تشطيب الأرضيات: ${FLOOR[rest] ?? FLOOR.other}`;
  if (head === "wall") return WALL[rest] ?? WALL.other;
  if (head === "point") return `${POINT[rest] ?? "نقطة كهرباء"} — تمديد وتركيب`;
  if (head === "fixture") return `وحدة إنارة: ${FIXTURE[rest] ?? "إنارة"}`;
  if (head === "treatment") return "ستائر النوافذ";
  if (head === "railing") return rest === "glass" ? "درابزين زجاجي" : rest === "bars" ? "درابزين حديد" : "درابزين";
  if (head === "joinery" || head === "install" || head === "appliance") return EXACT[key] ?? "أعمال نجارة";
  if (head === "furniture") return "أثاث (مخصص)";
  return en;
}
