import ee
import requests
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


# ── SOIL DATA ─────────────────────────────────────────────────────────────
def get_soil_data(coordinates):
    lons = [c[0] for c in coordinates]
    lats = [c[1] for c in coordinates]
    lon = round(sum(lons) / len(lons), 4)
    lat = round(sum(lats) / len(lats), 4)

    url = "https://rest.isric.org/soilgrids/v2.0/properties/query"
    params = {
        "lon": lon, "lat": lat,
        "property": ["clay", "sand", "silt", "phh2o", "soc", "bdod", "cec"],
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
        mean_raw = depth_data.get("values", {}).get("mean")
        if mean_raw is None:
            continue
        if name == "clay":  result["clay_pct"]     = round(mean_raw / 10, 1)
        if name == "sand":  result["sand_pct"]     = round(mean_raw / 10, 1)
        if name == "silt":  result["silt_pct"]     = round(mean_raw / 10, 1)
        if name == "phh2o": result["ph"]           = round(mean_raw / 10, 1)
        if name == "soc":   result["soc_g_kg"]     = round(mean_raw / 10, 1)
        if name == "bdod":  result["bulk_density"] = round(mean_raw / 100, 2)
        if name == "cec":   result["cec_mmol_kg"]  = round(mean_raw / 10, 1)

    clay = result.get("clay_pct", 0)
    sand = result.get("sand_pct", 0)
    silt = result.get("silt_pct", 0)
    cec  = result.get("cec_mmol_kg", 0)

    # Texture class
    if sand > 70:                               texture = "Sandy"
    elif clay > 40:                             texture = "Clay"
    elif clay > 25:                             texture = "Clay loam"
    elif sand > 50:                             texture = "Sandy loam"
    elif silt > 50:                             texture = "Silt loam"
    else:                                       texture = "Loam"

    # Drainage from texture
    if sand > 70:    drainage = "Excessive — high drought risk"
    elif clay > 40:  drainage = "Poor — waterlogging risk"
    elif clay > 25:  drainage = "Moderate"
    else:            drainage = "Well drained"

    # Hydraulic conductivity class
    if sand > 65:    hyd = "High (fast drainage)"
    elif clay > 40:  hyd = "Low (slow drainage)"
    elif clay > 25:  hyd = "Moderate"
    else:            hyd = "Moderate-high"

    # Fertility rating from CEC + SOC
    soc = result.get("soc_g_kg", 0)
    if cec > 20 and soc > 15:   fertility = "High"
    elif cec > 10 or soc > 8:   fertility = "Moderate"
    else:                        fertility = "Low"

    result["texture_class"]   = texture
    result["drainage"]        = drainage
    result["hydraulic_cond"]  = hyd
    result["fertility"]       = fertility
    result["centroid"]        = {"lat": lat, "lon": lon}
    return result


# ── WEATHER (7-day rolling + consecutive days + ET₀ + anomaly) ───────────
def get_weather_data(lat, lon):
    try:
        # Current conditions: last 7 days
        url = (
            f"https://power.larc.nasa.gov/api/temporal/daily/point"
            f"?parameters=T2M,T2M_MAX,T2M_MIN,PRECTOTCORR,RH2M,WS2M"
            f"&community=AG&longitude={lon}&latitude={lat}"
            f"&start=20250101&end=20250420&format=JSON"
        )
        resp = requests.get(url, timeout=15)
        data = resp.json()["properties"]["parameter"]

        t2m_daily     = data["T2M"]
        t2m_max_daily = data["T2M_MAX"]
        precip_daily  = data["PRECTOTCORR"]
        rh_daily      = data["RH2M"]

        # Get last 7 days of data
        dates = sorted(t2m_daily.keys())[-7:]

        temps_7d    = [t2m_daily[d]     for d in dates if t2m_daily.get(d, -999) > -900]
        temps_max_7d = [t2m_max_daily[d] for d in dates if t2m_max_daily.get(d, -999) > -900]
        precip_7d   = [precip_daily[d]  for d in dates if precip_daily.get(d, -999) > -900]
        rh_7d       = [rh_daily[d]      for d in dates if rh_daily.get(d, -999) > -900]

        avg_temp_7d    = round(sum(temps_7d) / len(temps_7d), 1)     if temps_7d    else None
        max_temp_7d    = round(max(temps_max_7d), 1)                  if temps_max_7d else None
        total_precip_7d = round(sum(precip_7d), 1)                   if precip_7d   else None
        avg_rh_7d      = round(sum(rh_7d) / len(rh_7d), 1)          if rh_7d       else None

        # Consecutive dry days (< 1mm)
        all_dates  = sorted(precip_daily.keys())
        cons_dry   = 0
        for d in reversed(all_dates):
            val = precip_daily.get(d, -999)
            if val < 0: continue
            if val < 1: cons_dry += 1
            else:       break

        # Consecutive wet days (> 5mm)
        cons_wet = 0
        for d in reversed(all_dates):
            val = precip_daily.get(d, -999)
            if val < 0: continue
            if val > 5: cons_wet += 1
            else:       break

        # Simple ET₀ estimate (Hargreaves): ET₀ = 0.0023 * (T_mean + 17.8) * (T_max - T_min)^0.5 * Ra
        # Ra approximated as 15 MJ/m²/day average (tropical/subtropical)
        et0_7d = None
        if temps_7d and temps_max_7d:
            temps_min_7d = [t2m_daily[d] for d in dates if t2m_daily.get(d, -999) > -900]
            if len(temps_max_7d) == len(temps_min_7d):
                et0_vals = []
                for tmax, tmean in zip(temps_max_7d, temps_7d):
                    tmin = tmean - (tmax - tmean)
                    td = max(tmax - tmin, 0.5)
                    et0_vals.append(0.0023 * (tmean + 17.8) * (td ** 0.5) * 15)
                et0_7d = round(sum(et0_vals), 1)

        # Rainfall anomaly: compare 7-day total vs climatological mean
        # Get climatological monthly normals
        clim_url = (
            f"https://power.larc.nasa.gov/api/temporal/climatology/point"
            f"?parameters=PRECTOTCORR&community=AG"
            f"&longitude={lon}&latitude={lat}&format=JSON"
        )
        clim_resp = requests.get(clim_url, timeout=15)
        clim_data = clim_resp.json()["properties"]["parameter"]["PRECTOTCORR"]
        # April normal (current month)
        month_normal_mm = clim_data.get("APR", clim_data.get("ANN", 3.0)) * 30
        weekly_normal   = month_normal_mm / 4
        precip_anomaly_pct = round(
            ((total_precip_7d - weekly_normal) / max(weekly_normal, 0.1)) * 100, 0
        ) if total_precip_7d is not None else None

        # Leaf wetness proxy: RH > 85% + rain in window
        leaf_wetness_risk = (avg_rh_7d or 0) > 80 and (total_precip_7d or 0) > 5

        return {
            "avg_temp_7d":         avg_temp_7d,
            "max_temp_7d":         max_temp_7d,
            "total_precip_7d_mm":  total_precip_7d,
            "avg_rh_7d_pct":       avg_rh_7d,
            "consecutive_dry_days": cons_dry,
            "consecutive_wet_days": cons_wet,
            "et0_7d_mm":           et0_7d,
            "precip_anomaly_pct":  precip_anomaly_pct,
            "leaf_wetness_risk":   leaf_wetness_risk,
            "weekly_normal_mm":    round(weekly_normal, 1),
        }
    except Exception as e:
        return {"error": str(e)}


# ── CLIMATE CLASSIFICATION ────────────────────────────────────────────────
def get_climate_class(lat, lon):
    try:
        power_url = (
            f"https://power.larc.nasa.gov/api/temporal/climatology/point"
            f"?parameters=T2M,PRECTOTCORR&community=AG"
            f"&longitude={lon}&latitude={lat}&format=JSON"
        )
        resp = requests.get(power_url, timeout=15)
        data = resp.json()["properties"]["parameter"]
        t2m    = data["T2M"]
        precip = data["PRECTOTCORR"]

        months = ["JAN","FEB","MAR","APR","MAY","JUN",
                  "JUL","AUG","SEP","OCT","NOV","DEC"]

        ann_temp         = t2m["ANN"]
        ann_precip       = precip["ANN"] * 365
        min_month_temp   = min(t2m[m] for m in months)
        max_month_temp   = max(t2m[m] for m in months)
        min_month_precip = min(precip[m] * 30 for m in months)

        if ann_temp > 18 and min_month_precip > 60:
            koppen, name = "Af", "Tropical Rainforest"
        elif ann_temp > 18 and ann_precip > 1000:
            koppen, name = "Am", "Tropical Monsoon"
        elif ann_temp > 18:
            koppen, name = "Aw", "Tropical Savanna"
        elif ann_precip < 250:
            koppen, name = ("BWh","Hot Desert") if ann_temp > 18 else ("BWk","Cold Desert")
        elif ann_precip < 500:
            koppen, name = ("BSh","Hot Steppe") if ann_temp > 18 else ("BSk","Cold Steppe")
        elif min_month_temp > 0 and max_month_temp > 22:
            koppen, name = "Cfa", "Humid Subtropical"
        elif min_month_temp > 0 and max_month_temp <= 22:
            koppen, name = "Cfb", "Oceanic / Maritime"
        elif min_month_temp > -3 and min_month_precip < 30:
            koppen, name = "Csa", "Mediterranean"
        elif min_month_temp < -3 and max_month_temp > 22:
            koppen, name = "Dfa", "Humid Continental"
        elif min_month_temp < -3:
            koppen, name = "Dfb", "Continental Subarctic"
        else:
            koppen, name = "Cfb", "Temperate"

        return {
            "koppen":          koppen,
            "name":            name,
            "ann_temp_c":      round(ann_temp, 1),
            "ann_precip_mm":   round(ann_precip),
            "min_month_temp":  round(min_month_temp, 1),
            "max_month_temp":  round(max_month_temp, 1),
        }
    except Exception as e:
        return {"error": str(e)}


# ── MAIN ANALYSIS ENDPOINT ────────────────────────────────────────────────
@app.post("/analyze")
def analyze_field(req: FieldRequest):
    field = ee.Geometry.Polygon([req.coordinates])

    # Centroid for point-based APIs
    lats = [c[1] for c in req.coordinates]
    lons = [c[0] for c in req.coordinates]
    centroid_lat = round(sum(lats) / len(lats), 4)
    centroid_lon = round(sum(lons) / len(lons), 4)

    # Parallel data fetches (soil, weather, climate)
    soil    = get_soil_data(req.coordinates)
    weather = get_weather_data(centroid_lat, centroid_lon)
    climate = get_climate_class(centroid_lat, centroid_lon)

    # ── GEE image collections ─────────────────────────────────────────
    def get_collection(start, end):
        col = (ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
            .filterBounds(field)
            .filterDate(start, end)
            .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 30)))
        return col.median() if col.size().getInfo() > 0 else None

    img = get_collection('2025-01-01', '2025-04-20')
    if img is None:
        img = get_collection('2024-09-01', '2025-04-20')
    if img is None:
        return {"error": "No cloud-free satellite imagery found for this location."}

    early_img = get_collection('2024-07-01', '2024-12-31')

    # ── Full index stack ──────────────────────────────────────────────
    # Normalise bands to 0-1 range
    b2  = img.select('B2').divide(10000)
    b3  = img.select('B3').divide(10000)
    b4  = img.select('B4').divide(10000)
    b5  = img.select('B5').divide(10000)
    b6  = img.select('B6').divide(10000)
    b7  = img.select('B7').divide(10000)
    b8  = img.select('B8').divide(10000)
    b8a = img.select('B8A').divide(10000)
    b11 = img.select('B11').divide(10000)

    # Group A — early stage / sparse canopy
    msavi = (b8.multiply(2).add(1).subtract(
        b8.multiply(2).add(1).pow(2).subtract(b8.subtract(b4).multiply(8)).sqrt()
    )).divide(2).rename('MSAVI')

    savi = b8.subtract(b4).divide(b8.add(b4).add(0.5)).multiply(1.5).rename('SAVI')

    # Group B — general vigour
    ndvi  = img.normalizedDifference(['B8','B4']).rename('NDVI')
    evi   = b8.subtract(b4).multiply(2.5).divide(
        b8.add(b4.multiply(6)).subtract(b2.multiply(7.5)).add(1)
    ).rename('EVI')
    gndvi = b8.subtract(b3).divide(b8.add(b3)).rename('GNDVI')

    # Group C — chlorophyll / nitrogen
    ndre  = img.normalizedDifference(['B8A','B5']).rename('NDRE')
    reci  = b7.divide(b5).subtract(1).rename('ReCI')
    gci   = b8a.divide(b3).subtract(1).rename('GCI')

    # Group D — moisture
    ndmi  = img.normalizedDifference(['B8','B11']).rename('NDMI')
    ndwi  = img.normalizedDifference(['B3','B8']).rename('NDWI')

    # Group E — senescence
    psri  = b4.subtract(b2).divide(b6).rename('PSRI')

    # Stack all indices
    index_stack = (ndvi.addBands(ndmi).addBands(ndre).addBands(evi)
                       .addBands(msavi).addBands(savi).addBands(gndvi)
                       .addBands(reci).addBands(gci).addBands(ndwi)
                       .addBands(psri))

    # ── Zonal statistics: mean + p10 + p90 ───────────────────────────
    def zonal_stats(image, band):
        stats = image.reduceRegion(
            reducer=ee.Reducer.mean()
                .combine(ee.Reducer.percentile([10, 90]), sharedInputs=True),
            geometry=field,
            scale=10,
            bestEffort=True
        ).getInfo()
        return {
            "mean": stats.get(f"{band}_mean") or stats.get(band),
            "p10":  stats.get(f"{band}_p10"),
            "p90":  stats.get(f"{band}_p90"),
        }

    def mean_val(stats):
        return stats["mean"]

    # Get all index stats
    ndvi_stats  = zonal_stats(index_stack, 'NDVI')
    ndmi_stats  = zonal_stats(index_stack, 'NDMI')
    ndre_stats  = zonal_stats(index_stack, 'NDRE')
    evi_stats   = zonal_stats(index_stack, 'EVI')
    msavi_stats = zonal_stats(index_stack, 'MSAVI')
    savi_stats  = zonal_stats(index_stack, 'SAVI')
    gndvi_stats = zonal_stats(index_stack, 'GNDVI')
    reci_stats  = zonal_stats(index_stack, 'ReCI')
    gci_stats   = zonal_stats(index_stack, 'GCI')
    ndwi_stats  = zonal_stats(index_stack, 'NDWI')
    psri_stats  = zonal_stats(index_stack, 'PSRI')

    mean_ndvi  = mean_val(ndvi_stats)
    mean_ndmi  = mean_val(ndmi_stats)
    mean_ndre  = mean_val(ndre_stats)
    mean_evi   = mean_val(evi_stats)
    mean_msavi = mean_val(msavi_stats)
    mean_gndvi = mean_val(gndvi_stats)
    mean_reci  = mean_val(reci_stats)
    mean_gci   = mean_val(gci_stats)
    mean_ndwi  = mean_val(ndwi_stats)
    mean_psri  = mean_val(psri_stats)

    # Within-field heterogeneity score (p90 - p10 spread on NDVI)
    ndvi_spread = None
    if ndvi_stats["p90"] is not None and ndvi_stats["p10"] is not None:
        ndvi_spread = round(ndvi_stats["p90"] - ndvi_stats["p10"], 3)

    # NDVI trend
    ndvi_change = 0
    if early_img is not None:
        early_ndvi = early_img.normalizedDifference(['B8','B4'])
        early_val  = early_ndvi.reduceRegion(
            reducer=ee.Reducer.mean(), geometry=field, scale=10
        ).getInfo().get('nd')
        if early_val:
            ndvi_change = round(mean_ndvi - early_val, 3)

    # Zone breakdown
    def zone_pct(lo, hi):
        zone   = ndvi.gte(lo).And(ndvi.lt(hi))
        total  = zone.reduceRegion(reducer=ee.Reducer.sum(),  geometry=field, scale=10).getInfo().get('NDVI', 0)
        all_px = ndvi.gte(-1).reduceRegion(reducer=ee.Reducer.sum(), geometry=field, scale=10).getInfo().get('NDVI', 1)
        return round((total / max(all_px, 1)) * 100, 1)

    zones = {
        "healthy_pct":  zone_pct(0.6, 1.0),
        "fair_pct":     zone_pct(0.4, 0.6),
        "stressed_pct": zone_pct(0.2, 0.4),
        "severe_pct":   zone_pct(-1,  0.2),
    }

    # ── NDVI tile URL ─────────────────────────────────────────────────
    ndvi_vis = {
        'min': 0.0, 'max': 0.8,
        'palette': ['#d73027','#f46d43','#fdae61','#fee08b',
                    '#d9ef8b','#a6d96a','#66bd63','#1a9850']
    }
    tile_url = ndvi.getMapId(ndvi_vis)['tile_fetcher'].url_format

    # ── Classifications ───────────────────────────────────────────────
    if mean_ndvi < 0.2:   health = "Severe stress"
    elif mean_ndvi < 0.4: health = "Moderate stress"
    elif mean_ndvi < 0.6: health = "Fair"
    else:                 health = "Healthy"

    if mean_ndmi < -0.2:  moisture = "Severe deficit"
    elif mean_ndmi < 0.0: moisture = "Low"
    elif mean_ndmi < 0.2: moisture = "Adequate"
    else:                 moisture = "High"

    if mean_ndre is None:       nitrogen = "Unknown"
    elif mean_ndre < 0.2:       nitrogen = "Deficient"
    elif mean_ndre < 0.35:      nitrogen = "Moderate"
    else:                       nitrogen = "Sufficient"

    # Field heterogeneity flag
    if ndvi_spread is None:     heterogeneity = "Unknown"
    elif ndvi_spread < 0.15:    heterogeneity = "Uniform"
    elif ndvi_spread < 0.25:    heterogeneity = "Moderate variation"
    else:                       heterogeneity = "High variation — stress hotspots likely"

    # ── Risk engine (weather-informed + multi-index) ──────────────────
    risks = []
    w = weather  # shorthand

    # 1. Declining health
    if ndvi_change < -0.05:
        risks.append({"name": "Declining crop health", "level": "High",
                      "detail": f"NDVI dropped {abs(ndvi_change):.2f} over 3 months"})

    # 2. Water stress — now uses consecutive dry days + ET₀
    dry_days = w.get("consecutive_dry_days", 0) if not w.get("error") else 0
    et0      = w.get("et0_7d_mm", 0) or 0
    precip7  = w.get("total_precip_7d_mm", 999) or 999
    if mean_ndmi < -0.1 or (dry_days > 7 and et0 > precip7):
        level = "High" if (mean_ndmi < -0.2 or dry_days > 14) else "Medium"
        risks.append({"name": "Water stress", "level": level,
                      "detail": f"Moisture index {mean_ndmi:.2f}, {dry_days} consecutive dry days, ET₀ {et0}mm this week"})

    # 3. Waterlogging — NDWI + wet days + soil drainage
    wet_days      = w.get("consecutive_wet_days", 0) if not w.get("error") else 0
    clay_pct      = soil.get("clay_pct", 0) if not soil.get("error") else 0
    poor_drainage = clay_pct > 35 or (soil.get("drainage","") == "Poor — waterlogging risk")
    if mean_ndwi is not None and mean_ndwi > 0.05 and wet_days > 5:
        risks.append({"name": "Waterlogging risk", "level": "High" if poor_drainage else "Medium",
                      "detail": f"NDWI {mean_ndwi:.2f}, {wet_days} consecutive wet days{', clay soil' if poor_drainage else ''}"})

    # 4. Fungal disease — now weather-gated
    avg_rh   = w.get("avg_rh_7d_pct", 0) if not w.get("error") else 0
    leaf_wet = w.get("leaf_wetness_risk", False) if not w.get("error") else False
    if req.crop_type in ["rice","maize","wheat","potato","soybean"] and mean_ndvi < 0.55:
        if leaf_wet or avg_rh > 80 or wet_days > 3:
            level = "High" if (avg_rh > 88 and wet_days > 5) else "Medium"
            risks.append({"name": "Fungal disease risk", "level": level,
                          "detail": f"RH {avg_rh}%, {wet_days} wet days, leaf wetness conditions present"})
        else:
            risks.append({"name": "Fungal disease risk", "level": "Low",
                          "detail": "Crop stress present but humidity conditions not yet critical"})

    # 5. Nitrogen deficiency — now requires NDRE + ReCI corroboration (SOP: 2+ indices)
    reci_low = mean_reci is not None and mean_reci < 1.5
    gci_low  = mean_gci  is not None and mean_gci  < 2.0
    if mean_ndre is not None and mean_ndre < 0.2 and (reci_low or gci_low):
        risks.append({"name": "Nitrogen deficiency", "level": "Medium",
                      "detail": f"NDRE {mean_ndre:.2f}, ReCI {mean_reci:.2f if mean_reci else '—'} — two indices confirm low N"})

    # 6. Heat stress — max temp + EVI/GCI declining
    max_t = w.get("max_temp_7d") if not w.get("error") else None
    if max_t and max_t > 34:
        risks.append({"name": "Heat stress", "level": "High" if max_t > 38 else "Medium",
                      "detail": f"7-day max temp {max_t}°C — above critical threshold for most crops"})

    # 7. Severe zone detected
    if zones["severe_pct"] > 15:
        risks.append({"name": "Severe stress zone", "level": "High",
                      "detail": f"{zones['severe_pct']}% of field in severe stress (NDVI < 0.2) — prioritize scouting"})

    # 8. High spatial heterogeneity
    if ndvi_spread and ndvi_spread > 0.25:
        risks.append({"name": "Uneven crop development", "level": "Medium",
                      "detail": f"NDVI spread {ndvi_spread} — large within-field variation suggests patchy stress or emergence failure"})

    # 9. Soil-informed risks
    if not soil.get("error"):
        if soil.get("sand_pct", 0) > 65 and mean_ndmi < 0.0:
            risks.append({"name": "Sandy soil + moisture deficit", "level": "High",
                          "detail": f"Sand {soil['sand_pct']}% — water retention very low, irrigation critical"})
        if soil.get("ph", 7) < 5.5:
            risks.append({"name": "Acidic soil", "level": "Medium",
                          "detail": f"pH {soil['ph']} — may limit nutrient uptake. Consider liming."})
        if soil.get("soc_g_kg", 20) < 8:
            risks.append({"name": "Low organic carbon", "level": "Low",
                          "detail": f"SOC {soil['soc_g_kg']} g/kg — poor soil health, consider compost"})

    # ── Action engine ─────────────────────────────────────────────────
    actions = []
    risk_names = [r["name"] for r in risks]

    if "Water stress" in risk_names:
        urgency = "Today" if any(r["level"] == "High" and r["name"] == "Water stress" for r in risks) else "Within 3 days"
        actions.append({"action": "Irrigate affected areas", "urgency": urgency})
    if "Waterlogging risk" in risk_names:
        actions.append({"action": "Inspect drainage channels and low-lying zones", "urgency": "Within 24 hours"})
    if "Fungal disease risk" in risk_names:
        actions.append({"action": "Scout for fungal lesions — lower canopy first", "urgency": "This week"})
    if "Nitrogen deficiency" in risk_names:
        actions.append({"action": "Consider foliar or split N application", "urgency": "Within 1 week"})
    if "Heat stress" in risk_names:
        actions.append({"action": "Irrigate to buffer heat — early morning preferred", "urgency": "Today"})
    if "Declining crop health" in risk_names:
        actions.append({"action": "Scout field for pest or disease damage", "urgency": "Within 2 days"})
    if "Severe stress zone" in risk_names:
        actions.append({"action": "Walk severe zones — check for soil, pest, or disease cause", "urgency": "Today"})
    if "Acidic soil" in risk_names:
        actions.append({"action": "Test soil pH and apply lime if confirmed", "urgency": "This season"})
    if "Sandy soil + moisture deficit" in risk_names:
        actions.append({"action": "Increase irrigation frequency — sandy soils drain fast", "urgency": "Within 2 days"})

    # ── Build response ────────────────────────────────────────────────
    def safe_round(val, digits=3):
        return round(val, digits) if val is not None else None

    return {
        # Core health
        "ndvi":              safe_round(mean_ndvi),
        "ndvi_change":       safe_round(ndvi_change),
        "health_status":     health,
        "heterogeneity":     heterogeneity,
        "ndvi_spread":       ndvi_spread,
        "zones":             zones,

        # Full index stack
        "indices": {
            "NDVI":  {"mean": safe_round(mean_ndvi),  "p10": safe_round(ndvi_stats["p10"]),  "p90": safe_round(ndvi_stats["p90"]),  "label": "Crop health"},
            "EVI":   {"mean": safe_round(mean_evi),   "p10": safe_round(evi_stats["p10"]),   "p90": safe_round(evi_stats["p90"]),   "label": "Canopy vigour"},
            "MSAVI": {"mean": safe_round(mean_msavi), "p10": safe_round(msavi_stats["p10"]), "p90": safe_round(msavi_stats["p90"]), "label": "Sparse canopy"},
            "GNDVI": {"mean": safe_round(mean_gndvi), "p10": safe_round(gndvi_stats["p10"]), "p90": safe_round(gndvi_stats["p90"]), "label": "Chlorophyll"},
            "NDMI":  {"mean": safe_round(mean_ndmi),  "p10": safe_round(ndmi_stats["p10"]),  "p90": safe_round(ndmi_stats["p90"]),  "label": moisture},
            "NDWI":  {"mean": safe_round(mean_ndwi),  "p10": safe_round(ndwi_stats["p10"]),  "p90": safe_round(ndwi_stats["p90"]),  "label": "Surface water"},
            "NDRE":  {"mean": safe_round(mean_ndre),  "p10": safe_round(ndre_stats["p10"]),  "p90": safe_round(ndre_stats["p90"]),  "label": nitrogen + " N"},
            "ReCI":  {"mean": safe_round(mean_reci),  "p10": safe_round(reci_stats["p10"]),  "p90": safe_round(reci_stats["p90"]),  "label": "Chlorophyll index"},
            "GCI":   {"mean": safe_round(mean_gci),   "p10": safe_round(gci_stats["p10"]),   "p90": safe_round(gci_stats["p90"]),   "label": "Green chlorophyll"},
            "PSRI":  {"mean": safe_round(mean_psri),  "p10": safe_round(psri_stats["p10"]),  "p90": safe_round(psri_stats["p90"]),  "label": "Senescence"},
        },

        # Legacy fields for frontend compatibility
        "ndmi":     safe_round(mean_ndmi),
        "ndre":     safe_round(mean_ndre),
        "moisture": moisture,
        "nitrogen": nitrogen,

        # Weather
        "weather":  weather,

        # Soil
        "soil":     soil,

        # Climate
        "climate":  climate,

        # Risks + actions
        "risks":    risks,
        "actions":  actions,
        "crop_type": req.crop_type,

        # Map overlay
        "ndvi_tile_url": tile_url,
    }


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
