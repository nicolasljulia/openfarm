import { useState, useEffect, useCallback } from "react";
import { MapContainer, TileLayer, FeatureGroup } from "react-leaflet";
import { EditControl } from "react-leaflet-draw";
import axios from "axios";
import "leaflet/dist/leaflet.css";
import "leaflet-draw/dist/leaflet.draw.css";


// ── 50 crops dropdown ──────────────────────────────────────────────────
const CROPS = [
  "Maize","Rice","Wheat","Soybean","Potato","Cassava","Sorghum","Beans",
  "Barley","Sugarcane","Cotton","Rapeseed","Sunflower","Banana","Coffee",
  "Oil Palm","Groundnut","Cowpea","Chickpea","Lentil","Sweet Potato",
  "Yam","Millet","Oats","Rye","Tobacco","Tomato","Onion","Pepper",
  "Cabbage","Spinach","Lettuce","Carrot","Garlic","Ginger","Turmeric",
  "Cocoa","Tea","Rubber","Coconut","Mango","Avocado","Orange","Lemon",
  "Pineapple","Papaya","Watermelon","Strawberry","Grape","Apple",
];

// ── 7 most spoken languages ─────────────────────────────────────────────
const LANGUAGES = [
  { code: "en", label: "EN", name: "English" },
  { code: "zh", label: "中文", name: "Chinese" },
  { code: "hi", label: "हिं", name: "Hindi" },
  { code: "es", label: "ES", name: "Spanish" },
  { code: "ar", label: "عر", name: "Arabic" },
  { code: "fr", label: "FR", name: "French" },
  { code: "sw", label: "SW", name: "Swahili" },
];

// ── Köppen climate → crop suitability commentary ───────────────────────
function getClimateAdvice(koppen, crop) {
  const c = crop.toLowerCase();
  const advisories = {
    Af: { good: ["rice","banana","cassava","oil palm","cocoa","coffee","rubber","coconut","pineapple","papaya"],
          warn: ["wheat","potato","barley","oats"],
          text: "Tropical rainforest climate. Year-round warmth and rainfall favor tropical crops. High fungal and bacterial disease pressure year-round. Excellent for rice, banana, cassava, and perennial tree crops." },
    Am: { good: ["rice","sugarcane","banana","cassava","maize","groundnut"],
          warn: ["wheat","potato","barley"],
          text: "Tropical monsoon climate. Strong wet season drives rapid crop growth. Waterlogging and blast disease risk during peak rains. Rice, sugarcane, and maize perform well with good drainage management." },
    Aw: { good: ["maize","sorghum","millet","cowpea","groundnut","cotton","cassava"],
          warn: ["rice","potato"],
          text: "Tropical savanna climate. Distinct wet and dry seasons. Drought-tolerant crops excel. Fall armyworm and aflatoxin are significant risks. Irrigation extends the growing window for high-value crops." },
    BSh: { good: ["sorghum","millet","groundnut","cowpea","cotton","sesame"],
           warn: ["rice","potato","coffee"],
           text: "Hot semi-arid steppe. Water is the primary limiting factor. Drought-tolerant varieties essential. Heat stress at flowering is common. Short-season crops avoid the worst heat." },
    BSk: { good: ["wheat","barley","sorghum","sunflower","lentil","chickpea"],
           warn: ["rice","banana","cocoa"],
           text: "Cold semi-arid steppe. Cool winters limit tropical crops. Cereals and legumes perform well in spring. Frost risk in shoulder seasons — check planting dates carefully." },
    BWh: { good: ["date palm","cotton"],
           warn: ["rice","potato","coffee","banana"],
           text: "Hot desert climate. Extreme heat and near-zero rainfall make rain-fed agriculture nearly impossible. Irrigated cultivation only. Salinity from irrigation water is a significant risk." },
    Cfa: { good: ["maize","soybean","cotton","rice","wheat","sugarcane","tomato","pepper","grape"],
           warn: ["potato"],
           text: "Humid subtropical climate. Hot summers and mild winters suit a wide range of crops. High humidity increases fungal disease pressure in summer. One of the most productive agricultural climates globally." },
    Cfb: { good: ["wheat","potato","barley","oats","apple","strawberry","grape","cabbage","lettuce","carrot"],
           warn: ["rice","banana","sugarcane","cocoa"],
           text: "Oceanic climate. Cool, wet, and mild year-round. Ideal for temperate vegetables, cereals, and fruit. Late blight is the dominant potato risk. Lack of summer heat limits tropical and subtropical crops." },
    Csa: { good: ["wheat","olive","grape","tomato","orange","lemon","almond","sunflower","barley"],
           warn: ["rice","banana","cocoa"],
           text: "Mediterranean climate. Hot dry summers and mild wet winters. Summer irrigation required for most crops. Powdery mildew and drought stress are key risks. One of the world's most productive wine and olive regions." },
    Dfa: { good: ["maize","soybean","wheat","sunflower","sugar beet","potato"],
           warn: ["rice","banana","cocoa","sugarcane"],
           text: "Humid continental climate. Cold winters kill over-wintering pests but also limit crop diversity. Spring flooding risk. Sclerotinia and rust are common. Strong maize and soybean belt climate." },
    Dfb: { good: ["wheat","barley","potato","oats","rye","cabbage","carrot"],
           warn: ["maize","rice","banana","sugarcane"],
           text: "Continental subarctic climate. Short growing season with cold winters. Hardy cereals and root vegetables dominate. Frost risk from September onward. Limited but reliable yields for adapted varieties." },
  };

  const entry = advisories[koppen] || {
    good: [], warn: [],
    text: "Temperate climate with moderate conditions. Suitable for a wide range of crops with standard management practices.",
  };

  let suitability = "Moderate";
  let suitColor = "#EF9F27";
  if (entry.good.some(g => c.includes(g) || g.includes(c))) { suitability = "Well suited"; suitColor = "#639922"; }
  if (entry.warn.some(w => c.includes(w) || w.includes(c))) { suitability = "Challenging"; suitColor = "#E24B4A"; }

  return { text: entry.text, suitability, suitColor };
}

const RISK_COLORS = { High: "#E24B4A", Medium: "#EF9F27", Low: "#639922" };

const round = (v, d) => v != null ? Math.round(v * Math.pow(10,d)) / Math.pow(10,d) : null;
// ── Simple translation store (key phrases) ─────────────────────────────
const TRANSLATIONS = {
  en: {
    step1: "Step 1 — Draw your field",
    step1desc: "Use the polygon tool on the map to outline your farm boundary.",
    fieldCaptured: "Field captured",
    points: "points",
    step2: "Step 2 — Select crop",
    analyze: "Analyze my farm →",
    analyzing: "Analyzing satellite data...",
    fieldOverview: "Field overview",
    spectral: "Spectral indices",
    soilProfile: "Soil profile — 0 to 15cm",
    zoneBreakdown: "Field zone breakdown",
    riskFactors: "Risk factors",
    noRisks: "No significant risks detected",
    whatNext: "What to do next",
    climateClass: "Climate classification",
    cropSuitability: "Crop suitability",
    healthy: "Healthy", fair: "Fair", stressed: "Stressed", severe: "Severe",
    satellite: "Satellite", map: "Map",
    ndviOverlay: "NDVI overlay on map",
    on: "On", off: "Off",
    health: "Crop health", moisture: "Moisture", nitrogen: "N status",
    clay: "Clay", ph: "pH", carbon: "Org. Carbon",
    annTemp: "Ann. Temp", annPrecip: "Ann. Rainfall", season: "Season range",
  },
  zh: {
    step1: "第一步 — 绘制田地", step1desc: "使用地图上的多边形工具勾画农场边界。",
    fieldCaptured: "已捕获田地", points: "个点",
    step2: "第二步 — 选择作物", analyze: "分析我的农场 →", analyzing: "正在分析卫星数据...",
    fieldOverview: "田地概览", spectral: "光谱指数", soilProfile: "土壤剖面 0-15cm",
    zoneBreakdown: "田地区域分析", riskFactors: "风险因素", noRisks: "未发现重大风险",
    whatNext: "下一步行动", climateClass: "气候分类", cropSuitability: "作物适宜性",
    healthy: "健康", fair: "一般", stressed: "胁迫", severe: "严重",
    satellite: "卫星", map: "地图", ndviOverlay: "地图上的NDVI叠加",
    on: "开", off: "关", health: "作物健康", moisture: "水分", nitrogen: "氮状态",
    clay: "粘土", ph: "酸碱度", carbon: "有机碳",
    annTemp: "年均温", annPrecip: "年降水量", season: "季节范围",
  },
  hi: {
    step1: "चरण 1 — अपना खेत बनाएं", step1desc: "खेत की सीमा बनाने के लिए मानचित्र पर बहुभुज उपकरण का उपयोग करें।",
    fieldCaptured: "खेत कैप्चर हुआ", points: "बिंदु",
    step2: "चरण 2 — फसल चुनें", analyze: "मेरे खेत का विश्लेषण करें →", analyzing: "उपग्रह डेटा का विश्लेषण हो रहा है...",
    fieldOverview: "खेत अवलोकन", spectral: "स्पेक्ट्रल सूचकांक", soilProfile: "मिट्टी प्रोफ़ाइल 0-15cm",
    zoneBreakdown: "खेत क्षेत्र विश्लेषण", riskFactors: "जोखिम कारक", noRisks: "कोई महत्वपूर्ण जोखिम नहीं मिला",
    whatNext: "आगे क्या करें", climateClass: "जलवायु वर्गीकरण", cropSuitability: "फसल उपयुक्तता",
    healthy: "स्वस्थ", fair: "ठीक", stressed: "तनावग्रस्त", severe: "गंभीर",
    satellite: "सैटेलाइट", map: "मानचित्र", ndviOverlay: "मानचित्र पर NDVI ओवरले",
    on: "चालू", off: "बंद", health: "फसल स्वास्थ्य", moisture: "नमी", nitrogen: "नाइट्रोजन",
    clay: "मिट्टी", ph: "पीएच", carbon: "जैव कार्बन",
    annTemp: "वार्षिक तापमान", annPrecip: "वार्षिक वर्षा", season: "मौसम सीमा",
  },
  es: {
    step1: "Paso 1 — Dibuja tu campo", step1desc: "Usa la herramienta de polígono en el mapa para trazar el límite de tu finca.",
    fieldCaptured: "Campo capturado", points: "puntos",
    step2: "Paso 2 — Selecciona cultivo", analyze: "Analizar mi finca →", analyzing: "Analizando datos satelitales...",
    fieldOverview: "Resumen del campo", spectral: "Índices espectrales", soilProfile: "Perfil del suelo 0-15cm",
    zoneBreakdown: "Análisis de zonas", riskFactors: "Factores de riesgo", noRisks: "No se detectaron riesgos significativos",
    whatNext: "Qué hacer ahora", climateClass: "Clasificación climática", cropSuitability: "Aptitud del cultivo",
    healthy: "Saludable", fair: "Regular", stressed: "Estresado", severe: "Grave",
    satellite: "Satélite", map: "Mapa", ndviOverlay: "NDVI sobre el mapa",
    on: "Sí", off: "No", health: "Salud del cultivo", moisture: "Humedad", nitrogen: "Nitrógeno",
    clay: "Arcilla", ph: "pH", carbon: "Carbono org.",
    annTemp: "Temp. anual", annPrecip: "Lluvia anual", season: "Rango estacional",
  },
  ar: {
    step1: "الخطوة 1 — ارسم حقلك", step1desc: "استخدم أداة المضلع على الخريطة لتحديد حدود مزرعتك.",
    fieldCaptured: "تم التقاط الحقل", points: "نقاط",
    step2: "الخطوة 2 — اختر المحصول", analyze: "تحليل مزرعتي ←", analyzing: "جارٍ تحليل بيانات الأقمار الصناعية...",
    fieldOverview: "نظرة عامة على الحقل", spectral: "المؤشرات الطيفية", soilProfile: "ملف التربة 0-15 سم",
    zoneBreakdown: "تحليل مناطق الحقل", riskFactors: "عوامل الخطر", noRisks: "لم يتم اكتشاف مخاطر كبيرة",
    whatNext: "ماذا تفعل بعد ذلك", climateClass: "التصنيف المناخي", cropSuitability: "ملاءمة المحصول",
    healthy: "صحي", fair: "مقبول", stressed: "مجهد", severe: "حرج",
    satellite: "قمر صناعي", map: "خريطة", ndviOverlay: "طبقة NDVI على الخريطة",
    on: "تشغيل", off: "إيقاف", health: "صحة المحصول", moisture: "الرطوبة", nitrogen: "النيتروجين",
    clay: "الطين", ph: "درجة الحموضة", carbon: "الكربون العضوي",
    annTemp: "الحرارة السنوية", annPrecip: "هطول الأمطار السنوي", season: "النطاق الموسمي",
  },
  fr: {
    step1: "Étape 1 — Dessinez votre champ", step1desc: "Utilisez l'outil polygone sur la carte pour tracer la limite de votre exploitation.",
    fieldCaptured: "Champ capturé", points: "points",
    step2: "Étape 2 — Choisissez la culture", analyze: "Analyser mon champ →", analyzing: "Analyse des données satellites...",
    fieldOverview: "Vue d'ensemble", spectral: "Indices spectraux", soilProfile: "Profil du sol 0-15cm",
    zoneBreakdown: "Analyse des zones", riskFactors: "Facteurs de risque", noRisks: "Aucun risque significatif détecté",
    whatNext: "Que faire maintenant", climateClass: "Classification climatique", cropSuitability: "Aptitude culturale",
    healthy: "Sain", fair: "Correct", stressed: "Stressé", severe: "Grave",
    satellite: "Satellite", map: "Carte", ndviOverlay: "NDVI sur la carte",
    on: "Activé", off: "Désactivé", health: "Santé culture", moisture: "Humidité", nitrogen: "Azote",
    clay: "Argile", ph: "pH", carbon: "Carbone org.",
    annTemp: "Temp. annuelle", annPrecip: "Pluie annuelle", season: "Plage saisonnière",
  },
  sw: {
    step1: "Hatua 1 — Chora shamba lako", step1desc: "Tumia zana ya poligoni kwenye ramani kuainisha mipaka ya shamba lako.",
    fieldCaptured: "Shamba limekamatwa", points: "pointi",
    step2: "Hatua 2 — Chagua zao", analyze: "Changanua shamba langu →", analyzing: "Inachambua data ya setilaiti...",
    fieldOverview: "Muhtasari wa shamba", spectral: "Viashiria vya spectral", soilProfile: "Wasifu wa udongo 0-15cm",
    zoneBreakdown: "Uchambuzi wa maeneo", riskFactors: "Mambo ya hatari", noRisks: "Hatari kubwa hazikugunduliwa",
    whatNext: "Hatua za kufuata", climateClass: "Uainishaji wa hali ya hewa", cropSuitability: "Ufaafu wa zao",
    healthy: "Afya nzuri", fair: "Wastani", stressed: "Mzigo", severe: "Kali",
    satellite: "Setilaiti", map: "Ramani", ndviOverlay: "NDVI kwenye ramani",
    on: "Washa", off: "Zima", health: "Afya ya zao", moisture: "Unyevu", nitrogen: "Nitrojeni",
    clay: "Udongo tifutifu", ph: "pH", carbon: "Kaboni ya kikaboni",
    annTemp: "Joto la mwaka", annPrecip: "Mvua ya mwaka", season: "Masafa ya msimu",
  },
};

export default function App() {
  const [coordinates, setCoordinates] = useState(null);
  const [crop, setCrop] = useState("maize");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [satellite, setSatellite] = useState(true);
  const [climateExpanded, setClimateExpanded] = useState(false);
  const [showNdvi, setShowNdvi] = useState(true);
  const [ndviTileUrl, setNdviTileUrl] = useState(null);
  const [lang, setLang] = useState("en");

  const t = TRANSLATIONS[lang];

  function onFieldDrawn(e) {
    const latlngs = e.layer.getLatLngs()[0];
    setCoordinates(latlngs.map(p => [p.lng, p.lat]));
    setResult(null);
    setNdviTileUrl(null);
  }

  async function analyzeField() {
    if (!coordinates) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setNdviTileUrl(null);
    try {
      const res = await axios.post("http://localhost:8000/analyze", {
        coordinates, crop_type: crop.toLowerCase(),
      });
      if (res.data.error) {
        setError(res.data.error);
      } else {
        setResult(res.data);
        if (res.data.ndvi_tile_url && showNdvi) setNdviTileUrl(res.data.ndvi_tile_url);
      }
    } catch (err) {
      setError("Analysis failed — is the backend running?");
    }
    setLoading(false);
  }

  function healthColor(status) {
    return { "Healthy": "#639922", "Fair": "#EF9F27", "Moderate stress": "#E8830A", "Severe stress": "#E24B4A" }[status] || "#888";
  }
  function ndmiColor(val) {
    if (val === null) return "#888";
    if (val < -0.2) return "#E24B4A";
    if (val < 0.0)  return "#EF9F27";
    if (val < 0.2)  return "#639922";
    return "#2196F3";
  }
  function ndreColor(status) {
    return { "Deficient": "#E24B4A", "Moderate": "#EF9F27", "Sufficient": "#639922", "Unknown": "#888" }[status] || "#888";
  }

  return (
    <div style={s.app}>
      {/* ── HEADER ── */}
      <div style={s.header}>
        <div style={s.logo}>🌱 OpenFarm</div>
        <div style={s.headerSub}>Farm Risk Intelligence</div>
        <div style={s.langBar}>
          {LANGUAGES.map(l => (
            <button key={l.code} onClick={() => setLang(l.code)}
              title={l.name}
              style={{ ...s.langBtn, ...(lang === l.code ? s.langBtnActive : {}) }}>
              {l.label}
            </button>
          ))}
        </div>
      </div>

      <div style={s.body}>
        {/* ── LEFT PANEL ── */}
        <div style={s.leftPanel}>

          <div style={s.card}>
            <div style={s.cardLabel}>{t.step1}</div>
            <p style={s.hint}>{t.step1desc}</p>
            {coordinates && (
              <div style={s.successChip}>✓ {t.fieldCaptured} — {coordinates.length} {t.points}</div>
            )}
          </div>

          {/* Crop dropdown */}
          <div style={s.card}>
            <div style={s.cardLabel}>{t.step2}</div>
            <select value={crop} onChange={e => setCrop(e.target.value)} style={s.cropSelect}>
              {CROPS.map(c => <option key={c} value={c.toLowerCase()}>{c}</option>)}
            </select>
          </div>

          {result && (
            <div style={{ ...s.card, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ fontSize: 13, color: "#444" }}>{t.ndviOverlay}</div>
              <button onClick={() => {
                const next = !showNdvi;
                setShowNdvi(next);
                setNdviTileUrl(next ? result.ndvi_tile_url : null);
              }} style={{ ...s.smallBtn, ...(showNdvi ? s.smallBtnActive : {}) }}>
                {showNdvi ? t.on : t.off}
              </button>
            </div>
          )}

          <button onClick={analyzeField} disabled={!coordinates || loading}
            style={{ ...s.analyzeBtn, opacity: (!coordinates || loading) ? 0.5 : 1 }}>
            {loading ? t.analyzing : t.analyze}
          </button>

          {error && <div style={s.error}>{error}</div>}

          {result && <>
            {/* Field overview */}
            <div style={{ ...s.card, borderLeft: `3px solid ${healthColor(result.health_status)}` }}>
              <div style={s.cardLabel}>{t.fieldOverview}</div>
              <div style={s.statRow}>
                <div style={s.statBox}>
                  <div style={{ ...s.statNum, color: healthColor(result.health_status) }}>{result.ndvi}</div>
                  <div style={s.statLbl}>NDVI</div>
                </div>
                <div style={s.statBox}>
                  <div style={{ ...s.statNum, color: result.ndvi_change >= 0 ? "#639922" : "#E24B4A" }}>
                    {result.ndvi_change >= 0 ? "+" : ""}{result.ndvi_change}
                  </div>
                  <div style={s.statLbl}>3-mo trend</div>
                </div>
                <div style={s.statBox}>
                  <div style={{ ...s.statusBadge, background: healthColor(result.health_status) }}>
                    {result.health_status}
                  </div>
                  <div style={s.statLbl}>Status</div>
                </div>
              </div>
            </div>

            {/* Data freshness */}
{result.data_sources && (
  <div style={{ ...s.card, background:"#fafaf8", display:"flex", flexDirection:"column", gap:6 }}>
    <div style={s.cardLabel}>Data sources</div>
    <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
      {[
        { label: "Satellite (Sentinel-2)", date: result.data_sources.satellite, icon: "🛰", color: "#2d5a1b" },
        { label: "Weather (NASA POWER)", date: result.data_sources.weather,   icon: "🌦", color: "#185FA5" },
        { label: "Soil (ISRIC)",          date: result.data_sources.soil,     icon: "🪱", color: "#8B6914" },
        { label: "Climate normals",        date: result.data_sources.climate,  icon: "🌍", color: "#555" },
      ].map(({ label, date, icon, color }) => (
        <div key={label} style={{
          display:"flex", alignItems:"center", gap:6,
          background:"#fff", border:"0.5px solid #e0e0d8",
          borderRadius:8, padding:"5px 10px", flex:"1 1 140px",
        }}>
          <span style={{ fontSize:14 }}>{icon}</span>
          <div>
            <div style={{ fontSize:9, color:"#999", textTransform:"uppercase", letterSpacing:1 }}>{label}</div>
            <div style={{ fontSize:11, fontWeight:600, color }}>{date}</div>
          </div>
        </div>
      ))}
    </div>
  </div>
)}

            {/* Weather context */}
{result.weather && !result.weather.error && (
  <div style={s.card}>
    <div style={s.cardLabel}>7-day weather context</div>
    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:6, marginBottom:8 }}>
      {[
        ["Avg temp", `${result.weather.avg_temp_7d}°C`, result.weather.avg_temp_7d > 34 ? "#E24B4A" : "#1a2e1a"],
        ["Max temp", `${result.weather.max_temp_7d}°C`, result.weather.max_temp_7d > 36 ? "#E24B4A" : "#1a2e1a"],
        ["Rainfall", `${result.weather.total_precip_7d_mm}mm`, result.weather.total_precip_7d_mm < 2 ? "#E24B4A" : "#2196F3"],
        ["Humidity", `${result.weather.avg_rh_7d_pct}%`, result.weather.avg_rh_7d_pct > 85 ? "#E24B4A" : "#1a2e1a"],
        ["Dry days", `${result.weather.consecutive_dry_days}d`, result.weather.consecutive_dry_days > 10 ? "#E24B4A" : result.weather.consecutive_dry_days > 5 ? "#EF9F27" : "#639922"],
        ["ET₀ 7d", `${result.weather.et0_7d_mm}mm`, "#1a2e1a"],
      ].map(([lbl, val, col]) => (
        <div key={lbl} style={{ background:"#fafaf8", borderRadius:8, padding:"8px 8px", border:"0.5px solid #eee" }}>
          <div style={{ fontSize:9, color:"#999", textTransform:"uppercase", letterSpacing:1 }}>{lbl}</div>
          <div style={{ fontSize:15, fontWeight:700, color:col, marginTop:2 }}>{val}</div>
        </div>
      ))}
    </div>
    {result.weather.precip_anomaly_pct != null && (
      <div style={{ fontSize:11, color: result.weather.precip_anomaly_pct < -50 ? "#E24B4A" : result.weather.precip_anomaly_pct > 100 ? "#2196F3" : "#666",
        padding:"5px 8px", background:"#fafaf8", borderRadius:6 }}>
        Rainfall this week is{" "}
        <strong>{Math.abs(result.weather.precip_anomaly_pct)}% {result.weather.precip_anomaly_pct < 0 ? "below" : "above"} normal</strong>
        {" "}for this location in April (normal: {result.weather.weekly_normal_mm}mm/week)
      </div>
    )}
  </div>
)}

            {/* Spectral indices — full stack */}
<div style={s.card}>
  <div style={s.cardLabel}>{t.spectral}</div>
  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
    {result.indices && Object.entries(result.indices).map(([key, idx]) => {
      const colors = {
        NDVI: healthColor(result.health_status),
        EVI: healthColor(result.health_status),
        MSAVI: "#639922",
        GNDVI: "#2d8a4e",
        NDMI: ndmiColor(result.ndmi),
        NDWI: "#2196F3",
        NDRE: ndreColor(result.nitrogen),
        ReCI: ndreColor(result.nitrogen),
        GCI: ndreColor(result.nitrogen),
        PSRI: (idx.mean || 0) > 0.1 ? "#E24B4A" : "#888",
      };
      const color = colors[key] || "#888";
      const spread = (idx.p90 != null && idx.p10 != null)
        ? round(idx.p90 - idx.p10, 2) : null;
      return (
        <div key={key} style={{ ...s.indexBox, padding:"10px 10px" }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <div style={s.indexLabel}>{key}</div>
            {spread != null && (
              <div style={{ fontSize:9, color:"#aaa" }}>±{spread}</div>
            )}
          </div>
          <div style={{ ...s.indexVal, fontSize:16, color }}>{idx.mean ?? "—"}</div>
          <div style={s.indexDesc}>{idx.label}</div>
          {idx.p10 != null && (
            <div style={{ fontSize:9, color:"#bbb", marginTop:2 }}>
              {idx.p10} – {idx.p90}
            </div>
          )}
          <div style={s.indexBar}>
            <div style={{ ...s.indexBarFill,
              width:`${Math.max(0, Math.min(1, (idx.mean || 0) + 0.5)) * 100}%`,
              background: color }} />
          </div>
        </div>
      );
    })}
  </div>
</div>

            {/* Zone breakdown */}
            {result.zones && (
              <div style={s.card}>
                <div style={s.cardLabel}>{t.zoneBreakdown}</div>
                <div style={s.zoneBar}>
                  {result.zones.healthy_pct > 0  && <div style={{ ...s.zoneSeg, width: `${result.zones.healthy_pct}%`,  background: "#639922" }} />}
                  {result.zones.fair_pct > 0      && <div style={{ ...s.zoneSeg, width: `${result.zones.fair_pct}%`,    background: "#EF9F27" }} />}
                  {result.zones.stressed_pct > 0  && <div style={{ ...s.zoneSeg, width: `${result.zones.stressed_pct}%`,background: "#E8830A" }} />}
                  {result.zones.severe_pct > 0    && <div style={{ ...s.zoneSeg, width: `${result.zones.severe_pct}%`,  background: "#E24B4A" }} />}
                </div>
                <div style={s.zoneLegend}>
                  {[[`#639922`,t.healthy,result.zones.healthy_pct],[`#EF9F27`,t.fair,result.zones.fair_pct],
                    [`#E8830A`,t.stressed,result.zones.stressed_pct],[`#E24B4A`,t.severe,result.zones.severe_pct]
                  ].map(([col,lbl,pct]) => (
                    <div key={lbl} style={s.zoneLegendItem}>
                      <div style={{ width:8,height:8,borderRadius:"50%",background:col,flexShrink:0 }}/>
                      <span style={{ fontSize:10, color:"#666" }}>{lbl} {pct}%</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Soil */}
            {result.soil && !result.soil.error && (
              <div style={s.card}>
                <div style={s.cardLabel}>{t.soilProfile}</div>
                <div style={s.indicesGrid}>
                  <div style={s.indexBox}>
                    <div style={s.indexLabel}>{t.clay}</div>
                    <div style={{ ...s.indexVal, color: "#8B6914" }}>{result.soil.clay_pct}%</div>
                    <div style={s.indexDesc}>Sand {result.soil.sand_pct}%</div>
                  </div>
                  <div style={s.indexBox}>
                    <div style={s.indexLabel}>{t.ph}</div>
                    <div style={{ ...s.indexVal, color: result.soil.ph < 5.5 ? "#E24B4A" : result.soil.ph > 7.5 ? "#EF9F27" : "#639922" }}>
                      {result.soil.ph}
                    </div>
                    <div style={s.indexDesc}>{result.soil.ph < 5.5 ? "Acidic" : result.soil.ph > 7.5 ? "Alkaline" : "Neutral"}</div>
                  </div>
                  <div style={s.indexBox}>
                    <div style={s.indexLabel}>{t.carbon}</div>
                    <div style={{ ...s.indexVal, color: result.soil.soc_g_kg < 8 ? "#E24B4A" : "#639922" }}>
                      {result.soil.soc_g_kg}
                    </div>
                    <div style={s.indexDesc}>g/kg SOC</div>
                  </div>
                </div>
                <div style={{ marginTop:8, padding:"6px 8px", background:"#fafaf8", borderRadius:6, fontSize:11, color:"#555" }}>
                  <strong>{result.soil.texture_class}</strong> · {result.soil.drainage}
                </div>
              </div>
            )}

            {/* Risks */}
            <div style={s.card}>
              <div style={s.cardLabel}>{t.riskFactors}</div>
              {result.risks.length === 0
                ? <div style={{ fontSize:12, color:"#3B6D11", background:"#EAF3DE", padding:"8px 10px", borderRadius:6 }}>✓ {t.noRisks}</div>
                : result.risks.map((r,i) => (
                  <div key={i} style={s.riskRow}>
                    <div style={{ ...s.riskDot, background: RISK_COLORS[r.level] }} />
                    <div style={{ flex:1 }}>
                      <div style={s.riskName}>{r.name}</div>
                      <div style={s.riskDetail}>{r.detail}</div>
                    </div>
                    <div style={{ ...s.riskBadge, color: RISK_COLORS[r.level] }}>{r.level}</div>
                  </div>
                ))
              }
            </div>

            {/* Actions */}
            {result.actions.length > 0 && (
              <div style={s.card}>
                <div style={s.cardLabel}>{t.whatNext}</div>
                {result.actions.map((a,i) => (
                  <div key={i} style={s.actionRow}>
                    <div style={s.actionNum}>{i+1}</div>
                    <div>
                      <div style={s.actionText}>{a.action}</div>
                      <div style={s.actionWhen}>{a.urgency}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}

{/* Climate classification */}
{result.climate && !result.climate.error && (() => {
  const advice = getClimateAdvice(result.climate.koppen, crop);
  const cl = result.climate;

  // Build the natural-language summary sentence
  const cropName = crop.charAt(0).toUpperCase() + crop.slice(1);
  const isGreat = advice.suitability === "Well suited"
    && cl.ann_precip_mm > 600
    && cl.ann_temp_c > 10
    && cl.ann_temp_c < 35;

  const riskSummary = {
    Af:  "fungal disease, waterlogging, and bacterial blight",
    Am:  "blast disease, waterlogging during peak rains, and lodging",
    Aw:  "drought stress, fall armyworm, and aflatoxin contamination",
    BSh: "severe drought, heat stress at flowering, and poor germination",
    BSk: "frost in shoulder seasons, short growing window, and drought",
    BWh: "extreme heat, salinity from irrigation, and water deficit",
    BWk: "frost, extreme cold, and very limited growing season",
    Cfa: "fungal disease in humid summers and occasional heat stress",
    Cfb: "late blight, fusarium, and insufficient summer heat for some crops",
    Csa: "summer drought, powdery mildew, and heat stress at flowering",
    Dfa: "spring flooding, sclerotinia, and rust diseases",
    Dfb: "late frost, short seasons, and winter kill",
  }[cl.koppen] || "climate variability and seasonal stress";

  return (
    <div style={{ ...s.card, borderLeft: `3px solid ${advice.suitColor}` }}>
      <div style={s.cardLabel}>{t.climateClass}</div>

      {/* Köppen badge + name */}
      <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:12 }}>
        <div style={{ background:"#1a2e1a", color:"#7AB648", fontWeight:700,
          fontSize:20, padding:"6px 14px", borderRadius:8, fontFamily:"monospace",
          letterSpacing:1 }}>
          {cl.koppen}
        </div>
        <div>
          <div style={{ fontSize:15, fontWeight:600, color:"#1a2e1a" }}>{cl.name}</div>
          <div style={{ fontSize:11, color:"#888" }}>Köppen-Geiger · {cl.ann_temp_c}°C avg · {cl.ann_precip_mm}mm/yr</div>
        </div>
        <div style={{ marginLeft:"auto", background:advice.suitColor, color:"#fff",
          fontSize:11, fontWeight:600, padding:"4px 12px", borderRadius:20, flexShrink:0 }}>
          {advice.suitability}
        </div>
      </div>

      {/* ── Natural language summary ── */}
      <div style={{ background: isGreat ? "#EAF3DE" : "#FFF8EE",
        border: `1px solid ${isGreat ? "#C2DFA8" : "#F5D9A0"}`,
        borderRadius:8, padding:"12px 14px", marginBottom:12 }}>

        <div style={{ fontSize:13, color:"#1a2e1a", lineHeight:1.65 }}>
          {isGreat ? (
            <>
              <span style={{ fontWeight:600 }}>You are growing {cropName} in a {cl.name} climate.</span>
              {" "}This is a great place to grow {cropName}. The temperature and rainfall here are
              well within the ideal range for this crop. With good management, you can expect
              strong yields. Continue monitoring for opportunistic risks like {riskSummary}.
            </>
          ) : (
            <>
              <span style={{ fontWeight:600 }}>You are growing {cropName} in a {cl.name} climate.</span>
              {" "}In this climate zone you generally need to be careful of{" "}
              <span style={{ fontWeight:600, color:"#C05010" }}>{riskSummary}</span>.{" "}
              {advice.suitability === "Challenging"
                ? `${cropName} faces real climate challenges here — variety selection and careful management are essential for a good harvest.`
                : `${cropName} can be grown successfully here with the right inputs and timing.`}
            </>
          )}
        </div>
      </div>

      {/* ── See more climate data button ── */}
      <button
        onClick={() => setClimateExpanded(prev => !prev)}
        style={{ width:"100%", padding:"9px 0", background:"#f5f5f0",
          border:"0.5px solid #ddd", borderRadius:8, fontSize:12, fontWeight:600,
          color:"#2d5a1b", cursor:"pointer", display:"flex", alignItems:"center",
          justifyContent:"center", gap:6 }}>
        {climateExpanded ? "▲ Hide climate data" : "▼ See more climate data"}
      </button>

      {/* ── Expanded climate panel ── */}
      {climateExpanded && (
        <div style={{ marginTop:12, display:"flex", flexDirection:"column", gap:10 }}>

          {/* Climate stats grid */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
            {[
              ["Annual Avg Temp", `${cl.ann_temp_c}°C`, cl.ann_temp_c > 30 ? "#E24B4A" : cl.ann_temp_c < 5 ? "#2196F3" : "#639922"],
              ["Annual Rainfall", `${cl.ann_precip_mm} mm`, cl.ann_precip_mm < 400 ? "#E24B4A" : cl.ann_precip_mm > 2000 ? "#2196F3" : "#639922"],
              ["Coolest Month",  `${cl.min_month_temp}°C`, cl.min_month_temp < 0 ? "#E24B4A" : "#639922"],
              ["Hottest Month",  `${cl.max_month_temp}°C`, cl.max_month_temp > 35 ? "#E24B4A" : "#639922"],
            ].map(([lbl, val, col]) => (
              <div key={lbl} style={{ background:"#fafaf8", borderRadius:8,
                padding:"10px 12px", border:"0.5px solid #eee" }}>
                <div style={{ fontSize:9, color:"#999", textTransform:"uppercase",
                  letterSpacing:1, marginBottom:4 }}>{lbl}</div>
                <div style={{ fontSize:20, fontWeight:700, color:col }}>{val}</div>
              </div>
            ))}
          </div>

          {/* Climate zone description */}
          <div style={{ background:"#fafaf8", borderRadius:8,
            padding:"10px 12px", border:"0.5px solid #eee" }}>
            <div style={{ fontSize:10, fontWeight:700, color:"#999",
              textTransform:"uppercase", letterSpacing:1, marginBottom:6 }}>
              About this climate zone
            </div>
            <div style={{ fontSize:12, color:"#444", lineHeight:1.7 }}>
              {advice.text}
            </div>
          </div>

          {/* Disease risk windows for this climate */}
          <div style={{ background:"#fafaf8", borderRadius:8,
            padding:"10px 12px", border:"0.5px solid #eee" }}>
            <div style={{ fontSize:10, fontWeight:700, color:"#999",
              textTransform:"uppercase", letterSpacing:1, marginBottom:8 }}>
              Key risks in {cl.name} climate
            </div>
            {[
{ risk: "Fungal disease",      condition: cl.ann_precip_mm > 700 || cl.ann_temp_c > 18, level: "High" },
{ risk: "Drought stress",      condition: cl.ann_precip_mm < 800, level: cl.ann_precip_mm < 500 ? "High" : "Medium" },
{ risk: "Heat stress",         condition: cl.max_month_temp > 28, level: cl.max_month_temp > 32 ? "High" : "Medium" },
{ risk: "Frost risk",          condition: cl.min_month_temp < 5,  level: cl.min_month_temp < 0 ? "High" : "Medium" },
{ risk: "Waterlogging",        condition: cl.ann_precip_mm > 1200, level: "Medium" },
{ risk: "Fall armyworm",       condition: ["Aw","Am","Af"].includes(cl.koppen), level: "High" },
{ risk: "Aflatoxin risk",      condition: ["Aw","BSh"].includes(cl.koppen), level: "Medium" },
{ risk: "Dry season stress",   condition: ["Aw","BSh","BSk"].includes(cl.koppen), level: "Medium" },
{ risk: "Late blight",         condition: ["Cfb","Cfa"].includes(cl.koppen), level: "Medium" },
{ risk: "Powdery mildew",      condition: ["Csa","Csb"].includes(cl.koppen), level: "Medium" },
{ risk: "Spring flooding",     condition: ["Dfa","Dfb"].includes(cl.koppen), level: "Medium" },
].filter(r => r.condition).map((r, i) => (
              <div key={i} style={{ display:"flex", alignItems:"center",
                gap:8, padding:"5px 0",
                borderBottom: i < 4 ? "0.5px solid #eee" : "none" }}>
                <div style={{ width:8, height:8, borderRadius:"50%", flexShrink:0,
                  background: r.level === "High" ? "#E24B4A" : "#EF9F27" }} />
                <div style={{ flex:1, fontSize:12, color:"#333" }}>{r.risk}</div>
                <div style={{ fontSize:11, fontWeight:600,
                  color: r.level === "High" ? "#E24B4A" : "#EF9F27" }}>{r.level}</div>
              </div>
            ))}
          </div>

          {/* Suitability for nearby crops */}
          <div style={{ background:"#fafaf8", borderRadius:8,
            padding:"10px 12px", border:"0.5px solid #eee" }}>
            <div style={{ fontSize:10, fontWeight:700, color:"#999",
              textTransform:"uppercase", letterSpacing:1, marginBottom:8 }}>
              Other crops suited to this climate
            </div>
            <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
              {({
  Af:  ["rice","banana","cassava","oil palm","cocoa","coffee","rubber","coconut","pineapple","papaya"],
  Am:  ["rice","sugarcane","banana","cassava","maize","groundnut","pineapple"],
  Aw:  ["maize","sorghum","millet","cowpea","groundnut","cotton","cassava","beans"],
  BSh: ["sorghum","millet","groundnut","cowpea","cotton","chickpea","lentil"],
  BSk: ["wheat","barley","sorghum","sunflower","lentil","chickpea","potato"],
  BWh: ["date palm","cotton","olive"],
  BWk: ["barley","rye","hardy wheat"],
  Cfa: ["maize","soybean","cotton","rice","wheat","sugarcane","tomato","grape"],
  Cfb: ["wheat","potato","barley","oats","apple","strawberry","grape","cabbage","carrot"],
  Csa: ["wheat","olive","grape","tomato","orange","lemon","sunflower","barley"],
  Dfa: ["maize","soybean","wheat","sunflower","potato","sugar beet"],
  Dfb: ["wheat","barley","potato","oats","rye","cabbage","carrot"],
}[cl.koppen] || ["maize","wheat","sorghum","beans","potato"])
  .filter(c => c !== crop.toLowerCase())
  .slice(0, 8)
                .map(c => (
                  <div key={c} style={{ background:"#EAF3DE", color:"#2d5a1b",
                    fontSize:11, fontWeight:500, padding:"3px 10px",
                    borderRadius:20, textTransform:"capitalize" }}>
                    {c}
                  </div>
                ))
              }
            </div>
          </div>

        </div>
      )}
    </div>
  );
})()}

          </>}
        </div>

        {/* ── MAP ── */}
        <div style={s.mapWrap}>
          <div style={s.layerToggle}>
            <button onClick={() => setSatellite(true)}  style={{ ...s.layerBtn, ...(satellite  ? s.layerBtnActive : {}) }}>{t.satellite}</button>
            <button onClick={() => setSatellite(false)} style={{ ...s.layerBtn, ...(!satellite ? s.layerBtnActive : {}) }}>{t.map}</button>
          </div>

          {result && ndviTileUrl && (
            <div style={s.ndviLegend}>
              <div style={{ fontSize:10, fontWeight:600, color:"#333", marginBottom:4 }}>NDVI</div>
              <div style={{ display:"flex", height:10, borderRadius:4, overflow:"hidden", width:120 }}>
                {["#d73027","#f46d43","#fdae61","#fee08b","#d9ef8b","#a6d96a","#66bd63","#1a9850"].map(c => (
                  <div key={c} style={{ flex:1, background:c }} />
                ))}
              </div>
              <div style={{ display:"flex", justifyContent:"space-between", fontSize:9, color:"#666", marginTop:2 }}>
                <span>0.0</span><span>0.8</span>
              </div>
            </div>
          )}

          <MapContainer center={[-1.102, 36.638]} zoom={12} style={{ height:"100%", width:"100%" }}>
            {satellite
              ? <TileLayer url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}" attribution="Imagery © Esri" maxZoom={19} />
              : <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="© OpenStreetMap" />
            }
            {ndviTileUrl && <TileLayer url={ndviTileUrl} opacity={0.75} attribution="NDVI © GEE/ESA" />}
            <FeatureGroup>
              <EditControl position="topright" onCreated={onFieldDrawn}
                draw={{ rectangle:false, circle:false, circlemarker:false, marker:false, polyline:false, polygon:true }} />
            </FeatureGroup>
          </MapContainer>
        </div>
      </div>
    </div>
  );
}

const s = {
  app: { fontFamily:"system-ui, sans-serif", height:"100vh", display:"flex", flexDirection:"column", background:"#f5f5f0" },
  header: { background:"#1a2e1a", color:"#fff", padding:"10px 20px", display:"flex", alignItems:"center", gap:12 },
  logo: { fontSize:18, fontWeight:600 },
  headerSub: { fontSize:13, opacity:0.6 },
  langBar: { marginLeft:"auto", display:"flex", gap:4 },
  langBtn: { padding:"4px 9px", fontSize:11, fontWeight:600, border:"1px solid rgba(255,255,255,0.2)",
    background:"transparent", color:"rgba(255,255,255,0.6)", borderRadius:5, cursor:"pointer" },
  langBtnActive: { background:"#7AB648", color:"#fff", border:"1px solid #7AB648" },
  body: { display:"flex", flex:1, overflow:"hidden" },
  leftPanel: { width:360, overflowY:"auto", padding:14, display:"flex", flexDirection:"column", gap:10 },
  mapWrap: { flex:1, position:"relative" },
  card: { background:"#fff", borderRadius:10, padding:"12px 14px", border:"0.5px solid #e0e0d8" },
  cardLabel: { fontSize:11, fontWeight:600, color:"#888", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:8 },
  hint: { fontSize:13, color:"#666", margin:0 },
  successChip: { marginTop:8, fontSize:12, color:"#3B6D11", background:"#EAF3DE", padding:"4px 10px", borderRadius:20, display:"inline-block" },
  cropSelect: { width:"100%", padding:"9px 12px", fontSize:13, borderRadius:8,
    border:"0.5px solid #ddd", background:"#fafaf8", cursor:"pointer",
    color:"#1a2e1a", appearance:"auto" },
  analyzeBtn: { background:"#2d5a1b", color:"#fff", border:"none", borderRadius:8,
    padding:"12px 16px", fontSize:14, fontWeight:500, cursor:"pointer", width:"100%" },
  smallBtn: { padding:"5px 14px", fontSize:12, fontWeight:500, border:"0.5px solid #ddd",
    background:"#fafaf8", borderRadius:6, cursor:"pointer", color:"#666" },
  smallBtnActive: { background:"#1a2e1a", color:"#fff", border:"0.5px solid #1a2e1a" },
  error: { fontSize:12, color:"#E24B4A", padding:"8px 12px", background:"#FCEBEB", borderRadius:6 },
  statRow: { display:"flex", gap:12, alignItems:"flex-start" },
  statBox: { flex:1 },
  statNum: { fontSize:22, fontWeight:600 },
  statLbl: { fontSize:10, color:"#888", marginTop:2 },
  statusBadge: { color:"#fff", fontSize:10, fontWeight:600, padding:"3px 8px", borderRadius:20, display:"inline-block" },
  indicesGrid: { display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8 },
  indexBox: { background:"#fafaf8", borderRadius:8, padding:"8px 6px", border:"0.5px solid #eee" },
  indexLabel: { fontSize:9, fontWeight:700, color:"#999", textTransform:"uppercase", letterSpacing:1 },
  indexVal: { fontSize:18, fontWeight:700, margin:"2px 0" },
  indexDesc: { fontSize:9, color:"#888" },
  indexBar: { height:3, background:"#eee", borderRadius:2, marginTop:6, overflow:"hidden" },
  indexBarFill: { height:"100%", borderRadius:2, maxWidth:"100%" },
  zoneBar: { display:"flex", height:14, borderRadius:7, overflow:"hidden", marginBottom:6 },
  zoneSeg: { height:"100%" },
  zoneLegend: { display:"flex", gap:8, flexWrap:"wrap" },
  zoneLegendItem: { display:"flex", alignItems:"center", gap:4 },
  riskRow: { display:"flex", alignItems:"flex-start", gap:10, padding:"8px 0", borderBottom:"0.5px solid #f0f0e8" },
  riskDot: { width:8, height:8, borderRadius:"50%", marginTop:4, flexShrink:0 },
  riskName: { fontSize:13, fontWeight:500 },
  riskDetail: { fontSize:11, color:"#888", marginTop:2 },
  riskBadge: { marginLeft:"auto", fontSize:11, fontWeight:600, flexShrink:0 },
  actionRow: { display:"flex", gap:10, alignItems:"flex-start", padding:"8px 0", borderBottom:"0.5px solid #f0f0e8" },
  actionNum: { width:20, height:20, borderRadius:"50%", background:"#e8f0e8", color:"#2d5a1b",
    fontSize:11, fontWeight:600, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 },
  actionText: { fontSize:13, fontWeight:500 },
  actionWhen: { fontSize:11, color:"#888", marginTop:2 },
  layerToggle: { position:"absolute", bottom:24, left:"50%", transform:"translateX(-50%)", zIndex:1000,
    display:"flex", background:"#fff", borderRadius:8, border:"0.5px solid #ddd", overflow:"hidden",
    boxShadow:"0 2px 8px rgba(0,0,0,0.15)" },
  layerBtn: { padding:"7px 16px", fontSize:12, fontWeight:500, border:"none", background:"transparent", cursor:"pointer", color:"#666" },
  layerBtnActive: { background:"#1a2e1a", color:"#fff" },
  ndviLegend: { position:"absolute", bottom:68, left:"50%", transform:"translateX(-50%)", zIndex:1000,
    background:"#fff", padding:"6px 10px", borderRadius:8, border:"0.5px solid #ddd",
    boxShadow:"0 2px 8px rgba(0,0,0,0.15)" },
};
