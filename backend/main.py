import ee
import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

ee.Initialize(project='openfarm-analytics')

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

class FieldRequest(BaseModel):
    coordinates: list
    crop_type: str

import requests

def get_soil_data(coordinates):
    """Fetch SoilGrids 2.0 data for the centroid of a field polygon."""
    lons = [c[0] for c in coordinates]
    lats = [c[1] for c in coordinates]
    lon = round(sum(lons) / len(lons), 4)
    lat = round(sum(lats) / len(lats), 4)

    url = "https://rest.isric.org/soilgrids/v2.0/properties/query"
    params = {
        "lon": lon,
        "lat": lat,
        "property": ["clay", "sand", "silt", "phh2o", "soc", "bdod"],
        "depth": ["0-5cm", "5-15cm"],
        "value": ["mean"],
    }

    try:
        resp = requests.get(url, params=params, timeout=15)
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        return {"error": str(e)}

    result = {}
    for layer in data.get("properties", {}).get("layers", []):
        name = layer["name"]
        depth_data = layer.get("depths", [{}])[0]
        values = depth_data.get("values", {})
        mean_raw = values.get("mean")
        if mean_raw is None:
            continue

        if name == "clay":    result["clay_pct"]    = round(mean_raw / 10, 1)   # g/kg → %
        if name == "sand":    result["sand_pct"]    = round(mean_raw / 10, 1)
        if name == "silt":    result["silt_pct"]    = round(mean_raw / 10, 1)
        if name == "phh2o":   result["ph"]          = round(mean_raw / 10, 1)   # pH*10 → pH
        if name == "soc":     result["soc_g_kg"]    = round(mean_raw / 10, 1)   # dg/kg → g/kg
        if name == "bdod":    result["bulk_density"] = round(mean_raw / 100, 2) # cg/cm³ → g/cm³

    clay = result.get("clay_pct", 0)
    sand = result.get("sand_pct", 0)

    if sand > 70:
        result["texture_class"] = "Sandy"
        result["drainage"] = "Excessive — high drought risk"
    elif clay > 40:
        result["texture_class"] = "Clay"
        result["drainage"] = "Poor — waterlogging risk"
    elif clay > 25:
        result["texture_class"] = "Clay loam"
        result["drainage"] = "Moderate"
    elif sand > 50:
        result["texture_class"] = "Sandy loam"
        result["drainage"] = "Well drained"
    else:
        result["texture_class"] = "Loam"
        result["drainage"] = "Well drained"

    result["centroid"] = {"lat": lat, "lon": lon}
    return result


@app.post("/analyze")
def analyze_field(req: FieldRequest):
    field = ee.Geometry.Polygon([req.coordinates])
    soil = get_soil_data(req.coordinates)

    def get_collection(start, end):
        col = (ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
            .filterBounds(field)
            .filterDate(start, end)
            .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 30)))
        size = col.size().getInfo()
        if size == 0:
            return None
        return col.median()

    img = get_collection('2025-01-01', '2025-04-20')
    if img is None:
        img = get_collection('2024-09-01', '2025-04-20')
    if img is None:
        return {"error": "No cloud-free satellite imagery found for this location."}

    early_img = get_collection('2024-07-01', '2024-12-31')

    ndvi  = img.normalizedDifference(['B8', 'B4']).rename('NDVI')
    ndmi  = img.normalizedDifference(['B8', 'B11']).rename('NDMI')   # moisture
    ndre  = img.normalizedDifference(['B8A', 'B5']).rename('NDRE')   # red edge / N status

    def zonal(image, band):
        return image.reduceRegion(
            reducer=ee.Reducer.mean(),
            geometry=field,
            scale=10
        ).getInfo().get(band)

    mean_ndvi = zonal(ndvi, 'NDVI')
    mean_ndmi = zonal(ndmi, 'NDMI')
    mean_ndre = zonal(ndre, 'NDRE')

    # Zone breakdown — percent of field in each health class
    def zone_pct(threshold_low, threshold_high):
        zone = ndvi.gte(threshold_low).And(ndvi.lt(threshold_high))
        total = zone.reduceRegion(reducer=ee.Reducer.sum(), geometry=field, scale=10).getInfo().get('NDVI', 0)
        all_px = ndvi.gte(-1).reduceRegion(reducer=ee.Reducer.sum(), geometry=field, scale=10).getInfo().get('NDVI', 1)
        return round((total / max(all_px, 1)) * 100, 1)

    zones = {
        "healthy_pct":  zone_pct(0.6, 1.0),
        "fair_pct":     zone_pct(0.4, 0.6),
        "stressed_pct": zone_pct(0.2, 0.4),
        "severe_pct":   zone_pct(-1,  0.2),
    }

    # Trend
    if early_img is not None:
        early_ndvi_val = zonal(early_img.normalizedDifference(['B8', 'B4']).rename('NDVI'), 'NDVI')
        ndvi_change = mean_ndvi - early_ndvi_val if early_ndvi_val else 0
    else:
        ndvi_change = 0

    # ── NDVI tile overlay URL from GEE ────────────────────────────
    ndvi_vis = {
        'min': 0.0, 'max': 0.8,
        'palette': ['#d73027', '#f46d43', '#fdae61', '#fee08b',
                    '#d9ef8b', '#a6d96a', '#66bd63', '#1a9850']
    }
    map_id = ndvi.getMapId(ndvi_vis)
    tile_url = map_id['tile_fetcher'].url_format

    # ── Health classification ─────────────────────────────────────
    if mean_ndvi < 0.2:
        health = "Severe stress"
    elif mean_ndvi < 0.4:
        health = "Moderate stress"
    elif mean_ndvi < 0.6:
        health = "Fair"
    else:
        health = "Healthy"

    # Moisture classification
    if mean_ndmi < -0.2:
        moisture = "Severe deficit"
    elif mean_ndmi < 0.0:
        moisture = "Low"
    elif mean_ndmi < 0.2:
        moisture = "Adequate"
    else:
        moisture = "High"

    # Nitrogen proxy from NDRE
    if mean_ndre is not None:
        if mean_ndre < 0.2:
            nitrogen = "Deficient"
        elif mean_ndre < 0.35:
            nitrogen = "Moderate"
        else:
            nitrogen = "Sufficient"
    else:
        nitrogen = "Unknown"

    # ── Risk engine ───────────────────────────────────────────────
    risks = []
    if ndvi_change < -0.05:
        risks.append({"name": "Declining crop health", "level": "High",
                      "detail": f"NDVI dropped {abs(ndvi_change):.2f} over 3 months"})
    if mean_ndmi < -0.1:
        risks.append({"name": "Water stress", "level": "High" if mean_ndmi < -0.2 else "Medium",
                      "detail": f"Moisture index {mean_ndmi:.2f} — below adequate threshold"})
    if req.crop_type in ["rice", "maize"] and mean_ndvi < 0.5:
        risks.append({"name": "Fungal disease risk", "level": "Medium",
                      "detail": "Stressed crops more vulnerable to fungal infection"})
    if mean_ndre is not None and mean_ndre < 0.2:
        risks.append({"name": "Nitrogen deficiency", "level": "Medium",
                      "detail": "Red-edge index suggests low chlorophyll / N status"})
    if zones["severe_pct"] > 20:
        risks.append({"name": "Severe zone detected", "level": "High",
                      "detail": f"{zones['severe_pct']}% of field in severe stress (NDVI < 0.2)"})
    if not soil.get("error"):
        if soil.get("sand_pct", 0) > 65 and mean_ndmi < 0.0:
            risks.append({"name": "Sandy soil + moisture deficit", "level": "High",
                      "detail": f"Sand {soil['sand_pct']}% — water retention very low, irrigation critical"})
        if soil.get("clay_pct", 0) > 40 and mean_ndmi > 0.2:
            risks.append({"name": "Waterlogging risk", "level": "Medium",
                      "detail": f"Clay {soil['clay_pct']}% soil with high moisture — check drainage"})
        if soil.get("ph", 7) < 5.5:
            risks.append({"name": "Acidic soil", "level": "Medium",
                      "detail": f"pH {soil['ph']} — may limit nutrient uptake. Consider liming."})
        if soil.get("soc_g_kg", 20) < 8:
            risks.append({"name": "Low organic carbon", "level": "Low",
                      "detail": f"SOC {soil['soc_g_kg']} g/kg — poor soil health, consider compost"})

    # ── Actions ───────────────────────────────────────────────────
    actions = []
    if any(r["name"] == "Water stress" for r in risks):
        actions.append({"action": "Irrigate affected areas", "urgency": "Within 3 days"})
    if any(r["name"] == "Fungal disease risk" for r in risks):
        actions.append({"action": "Inspect for fungal symptoms", "urgency": "This week"})
    if any(r["name"] == "Nitrogen deficiency" for r in risks):
        actions.append({"action": "Consider foliar N application", "urgency": "Within 1 week"})
    if any(r["name"] == "Declining crop health" for r in risks):
        actions.append({"action": "Scout field for pest or disease damage", "urgency": "Within 2 days"})
    if any(r["name"] == "Severe zone detected" for r in risks):
        actions.append({"action": "Prioritize severe zones — walk and inspect", "urgency": "Today"})

    return {
        "ndvi":          round(mean_ndvi, 3),
        "ndmi":          round(mean_ndmi, 3) if mean_ndmi else None,
        "ndre":          round(mean_ndre, 3) if mean_ndre else None,
        "ndvi_change":   round(ndvi_change, 3),
        "health_status": health,
        "moisture":      moisture,
        "nitrogen":      nitrogen,
        "zones":         zones,
        "risks":         risks,
        "actions":       actions,
        "crop_type":     req.crop_type,
        "ndvi_tile_url": tile_url,
        "soil":          soil,

    }

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
