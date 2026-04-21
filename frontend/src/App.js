import { useState } from "react";
import { MapContainer, TileLayer, FeatureGroup, useMap } from "react-leaflet";
import { EditControl } from "react-leaflet-draw";
import axios from "axios";
import "leaflet/dist/leaflet.css";
import "leaflet-draw/dist/leaflet.draw.css";

const CROPS = ["maize", "rice", "wheat", "sorghum", "cassava", "beans"];
const RISK_COLORS = { High: "#E24B4A", Medium: "#EF9F27", Low: "#639922" };

// Component to add/remove NDVI tile overlay
function NdviOverlay({ url }) {
  const map = useMap();
  const [layer, setLayer] = useState(null);

  if (url) {
    if (layer) map.removeLayer(layer);
    const L = window.L;
    const newLayer = L.tileLayer(url, { opacity: 0.7, attribution: "NDVI © GEE/ESA" });
    newLayer.addTo(map);
    setLayer(newLayer);
  }
  return null;
}

export default function App() {
  const [coordinates, setCoordinates] = useState(null);
  const [crop, setCrop] = useState("maize");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [satellite, setSatellite] = useState(true);
  const [showNdvi, setShowNdvi] = useState(true);
  const [ndviTileUrl, setNdviTileUrl] = useState(null);

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
        coordinates, crop_type: crop,
      });
      if (res.data.error) {
        setError(res.data.error);
      } else {
        setResult(res.data);
        if (res.data.ndvi_tile_url && showNdvi) {
          setNdviTileUrl(res.data.ndvi_tile_url);
        }
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
      {/* Header */}
      <div style={s.header}>
        <div style={s.logo}>🌱 OpenFarm</div>
        <div style={s.headerSub}>Farm Risk Intelligence</div>
      </div>

      <div style={s.body}>
        {/* ── LEFT PANEL ── */}
        <div style={s.leftPanel}>

          {/* Step 1 */}
          <div style={s.card}>
            <div style={s.cardLabel}>Step 1 — Draw your field</div>
            <p style={s.hint}>Use the polygon tool on the map to outline your farm boundary.</p>
            {coordinates && <div style={s.successChip}>✓ Field captured — {coordinates.length} points</div>}
          </div>

          {/* Step 2 */}
          <div style={s.card}>
            <div style={s.cardLabel}>Step 2 — Select crop</div>
            <div style={s.cropGrid}>
              {CROPS.map(c => (
                <button key={c} onClick={() => setCrop(c)}
                  style={{ ...s.cropBtn, ...(crop === c ? s.cropBtnActive : {}) }}>
                  {c}
                </button>
              ))}
            </div>
          </div>

          {/* NDVI toggle */}
          {result && (
            <div style={{ ...s.card, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ fontSize: 13, color: "#444" }}>NDVI overlay on map</div>
              <button onClick={() => {
                const next = !showNdvi;
                setShowNdvi(next);
                setNdviTileUrl(next ? result.ndvi_tile_url : null);
              }} style={{
                ...s.cropBtn,
                ...(showNdvi ? s.cropBtnActive : {}),
                width: "auto", padding: "6px 14px",
              }}>
                {showNdvi ? "On" : "Off"}
              </button>
            </div>
          )}

          <button onClick={analyzeField} disabled={!coordinates || loading}
            style={{ ...s.analyzeBtn, opacity: (!coordinates || loading) ? 0.5 : 1 }}>
            {loading ? "Analyzing satellite data..." : "Analyze my farm →"}
          </button>

          {error && <div style={s.error}>{error}</div>}

          {/* ── RESULTS ── */}
          {result && <>

            {/* Health overview */}
            <div style={{ ...s.card, borderLeft: `3px solid ${healthColor(result.health_status)}` }}>
              <div style={s.cardLabel}>Field overview</div>
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

            {/* Indices panel */}
            <div style={s.card}>
              <div style={s.cardLabel}>Spectral indices</div>
              <div style={s.indicesGrid}>
                <div style={s.indexBox}>
                  <div style={s.indexLabel}>NDVI</div>
                  <div style={{ ...s.indexVal, color: healthColor(result.health_status) }}>{result.ndvi}</div>
                  <div style={s.indexDesc}>Crop health</div>
                  <div style={s.indexBar}><div style={{ ...s.indexBarFill, width: `${Math.max(0, result.ndvi) * 100}%`, background: healthColor(result.health_status) }} /></div>
                </div>
                <div style={s.indexBox}>
                  <div style={s.indexLabel}>NDMI</div>
                  <div style={{ ...s.indexVal, color: ndmiColor(result.ndmi) }}>{result.ndmi ?? "—"}</div>
                  <div style={s.indexDesc}>{result.moisture}</div>
                  <div style={s.indexBar}><div style={{ ...s.indexBarFill, width: `${Math.max(0, (result.ndmi + 1) / 2) * 100}%`, background: ndmiColor(result.ndmi) }} /></div>
                </div>
                <div style={s.indexBox}>
                  <div style={s.indexLabel}>NDRE</div>
                  <div style={{ ...s.indexVal, color: ndreColor(result.nitrogen) }}>{result.ndre ?? "—"}</div>
                  <div style={s.indexDesc}>{result.nitrogen} N</div>
                  <div style={s.indexBar}><div style={{ ...s.indexBarFill, width: `${Math.max(0, result.ndre ?? 0) * 200}%`, background: ndreColor(result.nitrogen) }} /></div>
                </div>
              </div>
            </div>

            {/* Zone breakdown */}
            {result.zones && (
              <div style={s.card}>
                <div style={s.cardLabel}>Field zone breakdown</div>
                <div style={s.zoneBar}>
                  {result.zones.healthy_pct > 0 && <div style={{ ...s.zoneSeg, width: `${result.zones.healthy_pct}%`, background: "#639922" }} title={`Healthy ${result.zones.healthy_pct}%`} />}
                  {result.zones.fair_pct > 0 && <div style={{ ...s.zoneSeg, width: `${result.zones.fair_pct}%`, background: "#EF9F27" }} title={`Fair ${result.zones.fair_pct}%`} />}
                  {result.zones.stressed_pct > 0 && <div style={{ ...s.zoneSeg, width: `${result.zones.stressed_pct}%`, background: "#E8830A" }} title={`Stressed ${result.zones.stressed_pct}%`} />}
                  {result.zones.severe_pct > 0 && <div style={{ ...s.zoneSeg, width: `${result.zones.severe_pct}%`, background: "#E24B4A" }} title={`Severe ${result.zones.severe_pct}%`} />}
                </div>
                <div style={s.zoneLegend}>
                  {[["#639922","Healthy",result.zones.healthy_pct],["#EF9F27","Fair",result.zones.fair_pct],
                    ["#E8830A","Stressed",result.zones.stressed_pct],["#E24B4A","Severe",result.zones.severe_pct]
                  ].map(([col, lbl, pct]) => (
                    <div key={lbl} style={s.zoneLegendItem}>
                      <div style={{ width: 8, height: 8, borderRadius: "50%", background: col, flexShrink: 0 }} />
                      <span style={{ fontSize: 10, color: "#666" }}>{lbl} {pct}%</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Soil profile */}
{result.soil && !result.soil.error && (
  <div style={s.card}>
    <div style={s.cardLabel}>Soil profile — 0 to 15cm</div>
    <div style={s.indicesGrid}>
      <div style={s.indexBox}>
        <div style={s.indexLabel}>Clay</div>
        <div style={{ ...s.indexVal, color: "#8B6914" }}>{result.soil.clay_pct}%</div>
        <div style={s.indexDesc}>Sand {result.soil.sand_pct}%</div>
      </div>
      <div style={s.indexBox}>
        <div style={s.indexLabel}>pH</div>
        <div style={{ ...s.indexVal, color: result.soil.ph < 5.5 ? "#E24B4A" : result.soil.ph > 7.5 ? "#EF9F27" : "#639922" }}>
          {result.soil.ph}
        </div>
        <div style={s.indexDesc}>{result.soil.ph < 5.5 ? "Acidic" : result.soil.ph > 7.5 ? "Alkaline" : "Neutral"}</div>
      </div>
      <div style={s.indexBox}>
        <div style={s.indexLabel}>Org. Carbon</div>
        <div style={{ ...s.indexVal, color: result.soil.soc_g_kg < 8 ? "#E24B4A" : "#639922" }}>
          {result.soil.soc_g_kg}
        </div>
        <div style={s.indexDesc}>g/kg SOC</div>
      </div>
    </div>
    <div style={{ marginTop: 8, padding: "6px 8px", background: "#fafaf8", borderRadius: 6, fontSize: 11, color: "#555" }}>
      <strong>{result.soil.texture_class}</strong> · {result.soil.drainage}
    </div>
  </div>
)}

            {/* Risks */}
            <div style={s.card}>
              <div style={s.cardLabel}>Risk factors</div>
              {result.risks.length === 0
                ? <div style={{ fontSize: 12, color: "#3B6D11", background: "#EAF3DE", padding: "8px 10px", borderRadius: 6 }}>✓ No significant risks detected</div>
                : result.risks.map((r, i) => (
                  <div key={i} style={s.riskRow}>
                    <div style={{ ...s.riskDot, background: RISK_COLORS[r.level] }} />
                    <div style={{ flex: 1 }}>
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
                <div style={s.cardLabel}>What to do next</div>
                {result.actions.map((a, i) => (
                  <div key={i} style={s.actionRow}>
                    <div style={s.actionNum}>{i + 1}</div>
                    <div>
                      <div style={s.actionText}>{a.action}</div>
                      <div style={s.actionWhen}>{a.urgency}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>}
        </div>

        {/* ── MAP ── */}
        <div style={s.mapWrap}>
          <div style={s.layerToggle}>
            <button onClick={() => setSatellite(true)} style={{ ...s.layerBtn, ...(satellite ? s.layerBtnActive : {}) }}>Satellite</button>
            <button onClick={() => setSatellite(false)} style={{ ...s.layerBtn, ...(!satellite ? s.layerBtnActive : {}) }}>Map</button>
          </div>

          {result && ndviTileUrl && (
            <div style={s.ndviLegend}>
              <div style={{ fontSize: 10, fontWeight: 600, color: "#333", marginBottom: 4 }}>NDVI</div>
              <div style={{ display: "flex", height: 10, borderRadius: 4, overflow: "hidden", width: 120 }}>
                {["#d73027","#f46d43","#fdae61","#fee08b","#d9ef8b","#a6d96a","#66bd63","#1a9850"].map(c => (
                  <div key={c} style={{ flex: 1, background: c }} />
                ))}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "#666", marginTop: 2 }}>
                <span>0.0 Low</span><span>0.8 High</span>
              </div>
            </div>
          )}

          <MapContainer center={[-1.102, 36.638]} zoom={12} style={{ height: "100%", width: "100%" }}>
            {satellite
              ? <TileLayer url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}" attribution="Imagery © Esri" maxZoom={19} />
              : <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="© OpenStreetMap" />
            }
            {ndviTileUrl && <TileLayer url={ndviTileUrl} opacity={0.75} attribution="NDVI © GEE/ESA" />}
            <FeatureGroup>
              <EditControl position="topright" onCreated={onFieldDrawn}
                draw={{ rectangle: false, circle: false, circlemarker: false, marker: false, polyline: false, polygon: true }} />
            </FeatureGroup>
          </MapContainer>
        </div>
      </div>
    </div>
  );
}

const s = {
  app: { fontFamily: "system-ui, sans-serif", height: "100vh", display: "flex", flexDirection: "column", background: "#f5f5f0" },
  header: { background: "#1a2e1a", color: "#fff", padding: "12px 20px", display: "flex", alignItems: "center", gap: 12 },
  logo: { fontSize: 18, fontWeight: 600 },
  headerSub: { fontSize: 13, opacity: 0.6 },
  body: { display: "flex", flex: 1, overflow: "hidden" },
  leftPanel: { width: 360, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 10 },
  mapWrap: { flex: 1, position: "relative" },
  card: { background: "#fff", borderRadius: 10, padding: "12px 14px", border: "0.5px solid #e0e0d8" },
  cardLabel: { fontSize: 11, fontWeight: 600, color: "#888", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 },
  hint: { fontSize: 13, color: "#666", margin: 0 },
  successChip: { marginTop: 8, fontSize: 12, color: "#3B6D11", background: "#EAF3DE", padding: "4px 10px", borderRadius: 20, display: "inline-block" },
  cropGrid: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 },
  cropBtn: { padding: "7px 4px", fontSize: 12, borderRadius: 6, border: "0.5px solid #ddd", background: "#fafaf8", cursor: "pointer", textTransform: "capitalize" },
  cropBtnActive: { background: "#1a2e1a", color: "#fff", border: "0.5px solid #1a2e1a" },
  analyzeBtn: { background: "#2d5a1b", color: "#fff", border: "none", borderRadius: 8, padding: "12px 16px", fontSize: 14, fontWeight: 500, cursor: "pointer", width: "100%" },
  error: { fontSize: 12, color: "#E24B4A", padding: "8px 12px", background: "#FCEBEB", borderRadius: 6 },
  statRow: { display: "flex", gap: 12, alignItems: "flex-start" },
  statBox: { flex: 1 },
  statNum: { fontSize: 22, fontWeight: 600 },
  statLbl: { fontSize: 10, color: "#888", marginTop: 2 },
  statusBadge: { color: "#fff", fontSize: 10, fontWeight: 600, padding: "3px 8px", borderRadius: 20, display: "inline-block" },
  // Indices
  indicesGrid: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 },
  indexBox: { background: "#fafaf8", borderRadius: 8, padding: "8px 6px", border: "0.5px solid #eee" },
  indexLabel: { fontSize: 9, fontWeight: 700, color: "#999", textTransform: "uppercase", letterSpacing: 1 },
  indexVal: { fontSize: 18, fontWeight: 700, margin: "2px 0" },
  indexDesc: { fontSize: 9, color: "#888" },
  indexBar: { height: 3, background: "#eee", borderRadius: 2, marginTop: 6, overflow: "hidden" },
  indexBarFill: { height: "100%", borderRadius: 2, maxWidth: "100%" },
  // Zone breakdown
  zoneBar: { display: "flex", height: 14, borderRadius: 7, overflow: "hidden", marginBottom: 6 },
  zoneSeg: { height: "100%", transition: "width 0.3s" },
  zoneLegend: { display: "flex", gap: 8, flexWrap: "wrap" },
  zoneLegendItem: { display: "flex", alignItems: "center", gap: 4 },
  // Risks
  riskRow: { display: "flex", alignItems: "flex-start", gap: 10, padding: "8px 0", borderBottom: "0.5px solid #f0f0e8" },
  riskDot: { width: 8, height: 8, borderRadius: "50%", marginTop: 4, flexShrink: 0 },
  riskName: { fontSize: 13, fontWeight: 500 },
  riskDetail: { fontSize: 11, color: "#888", marginTop: 2 },
  riskBadge: { marginLeft: "auto", fontSize: 11, fontWeight: 600, flexShrink: 0 },
  // Actions
  actionRow: { display: "flex", gap: 10, alignItems: "flex-start", padding: "8px 0", borderBottom: "0.5px solid #f0f0e8" },
  actionNum: { width: 20, height: 20, borderRadius: "50%", background: "#e8f0e8", color: "#2d5a1b", fontSize: 11, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  actionText: { fontSize: 13, fontWeight: 500 },
  actionWhen: { fontSize: 11, color: "#888", marginTop: 2 },
  // Map controls
  layerToggle: { position: "absolute", bottom: 24, left: "50%", transform: "translateX(-50%)", zIndex: 1000, display: "flex", background: "#fff", borderRadius: 8, border: "0.5px solid #ddd", overflow: "hidden", boxShadow: "0 2px 8px rgba(0,0,0,0.15)" },
  layerBtn: { padding: "7px 16px", fontSize: 12, fontWeight: 500, border: "none", background: "transparent", cursor: "pointer", color: "#666" },
  layerBtnActive: { background: "#1a2e1a", color: "#fff" },
  ndviLegend: { position: "absolute", bottom: 68, left: "50%", transform: "translateX(-50%)", zIndex: 1000, background: "#fff", padding: "6px 10px", borderRadius: 8, border: "0.5px solid #ddd", boxShadow: "0 2px 8px rgba(0,0,0,0.15)" },
};