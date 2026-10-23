export default async function install(app) {
  const root = app.getMount("station-workflow");
  const layer = app.layers[app.config.layerId];
  app.assert(layer, "The police station layer is not available.");

  const panel = document.createElement("div");
  panel.style.display = "flex"; panel.style.flexDirection = "column"; panel.style.gap = "12px"; panel.style.width = "100%"; panel.style.minWidth = "0";
  const help = document.createElement("p"); help.textContent = "Search for a station, or click a station marker on the map."; help.style.margin = "0";
  const search = document.createElement("input"); search.type = "search"; search.placeholder = "e.g., 19th Precinct or Midtown"; search.setAttribute("aria-label", "Search police stations"); search.style.width = "100%"; search.style.boxSizing = "border-box"; search.style.padding = "9px 10px"; search.style.border = "1px solid #a9a9a9"; search.style.borderRadius = "4px";
  const results = document.createElement("div"); results.style.display = "flex"; results.style.flexDirection = "column"; results.style.gap = "6px"; results.style.maxHeight = "240px"; results.style.overflowY = "auto"; results.style.minWidth = "0";
  const status = document.createElement("p"); status.setAttribute("role", "status"); status.textContent = "Ready — search the station layer or choose a location on the map."; status.style.margin = "0";
  const selected = document.createElement("div"); selected.style.padding = "10px"; selected.style.borderLeft = "3px solid #c74634"; selected.style.background = "var(--calcite-color-foreground-2, #f4f4f4)"; selected.style.display = "none";
  const selectedTitle = document.createElement("strong"); const selectedDetails = document.createElement("div"); selectedDetails.style.marginTop = "4px"; selectedDetails.style.fontSize = "0.9em"; selected.append(selectedTitle, selectedDetails);
  const clearButton = document.createElement("button"); clearButton.type = "button"; clearButton.textContent = "Clear coverage"; clearButton.style.padding = "8px 10px"; clearButton.style.cursor = "pointer"; clearButton.style.display = "none";
  panel.append(help, search, results, status, selected, clearButton); root.replaceChildren(panel);

  let sequence = 0; let debounceTimer; let drivingModePromise;
  const [FeatureSet, ServiceAreaParameters, serviceArea, networkService, Portal, Graphic] = await Promise.all([
    app.import("esri/rest/support/FeatureSet"), app.import("esri/rest/support/ServiceAreaParameters"), app.import("esri/rest/serviceArea"), app.import("esri/rest/networkService"), app.import("esri/portal/Portal"), app.import("esri/Graphic")
  ]);
  const resultHandle = await app.createResultLayer({ id: "police-response-service-area", geometryType: "polygon", title: "10-minute driving-time coverage", fields: [{ name: "ObjectID", type: "oid" }, { name: "Name", type: "string" }, { name: "FacilityID", type: "string" }, { name: "FromBreak", type: "double" }, { name: "ToBreak", type: "double" }], renderer: { type: "simple", symbol: { type: "simple-fill", color: [236, 93, 80, 0.24], outline: { color: [195, 58, 50, 0.95], width: 2 } } }, popupTemplate: { title: "{Name} — {ToBreak} minute drive-time area", content: "10-minute service-area polygon generated from the selected police station." } });
  function writeStatus(message) { status.textContent = message; }
  function displayStation(feature) { const a = feature.attributes || {}; selected.style.display = "block"; selectedTitle.textContent = String(a.FACNAME || "Police station"); selectedDetails.textContent = [a.ADDRESS, a.CITY, a.BORO].filter(Boolean).join(" · "); clearButton.style.display = "inline-block"; }
  async function drivingService() {
    if (!drivingModePromise) drivingModePromise = (async () => {
      const portal = new Portal(app.portalUrl ? { url: app.portalUrl } : {}); await portal.load();
      const url = portal.helperServices?.serviceArea?.url; app.assert(url, "This portal does not advertise a service area helper service.");
      const description = await networkService.fetchServiceDescription(url);
      const mode = (description.supportedTravelModes || []).find(m => String(m.name || "").toLowerCase() === "driving time") || (description.supportedTravelModes || []).find(m => m.impedanceAttributeName && m.impedanceAttributeName === m.timeAttributeName);
      app.assert(mode, "The service area service offers no driving-time travel mode.");
      return { url, mode };
    })();
    return drivingModePromise;
  }
  async function runCoverage(feature) {
    if (!feature || !feature.geometry) { writeStatus("Could not read this station's location. Try another marker."); return; }
    const current = ++sequence; displayStation(feature); results.replaceChildren(); writeStatus("Calculating a 10-minute driving service area…");
    try {
      const { url, mode } = await drivingService();
      const facilities = new FeatureSet({ features: [new Graphic({ geometry: feature.geometry, attributes: { Name: feature.attributes?.FACNAME || "Police station" } })] });
      const params = new ServiceAreaParameters({ facilities, travelMode: mode, defaultBreaks: [10], travelDirection: "from-facility", outputPolygons: "simplified", overlapPolygons: false, splitPolygonsAtBreaks: false, outSpatialReference: app.view.spatialReference, returnFacilities: true });
      const response = await serviceArea.solve(url, params);
      if (current !== sequence) return;
      const polygons = response.serviceAreaPolygons?.features || [];
      if (!polygons.length) { writeStatus("No service-area polygon was returned for this station."); resultHandle.clear(); return; }
      const graphics = polygons.map(p => ({ geometry: p.geometry, attributes: { Name: String(feature.attributes?.FACNAME || "Police station"), FacilityID: String(feature.getObjectId?.() ?? feature.attributes?.OBJECTID ?? ""), FromBreak: Number(p.attributes?.FromBreak ?? 0), ToBreak: Number(p.attributes?.ToBreak ?? 10) } }));
      await resultHandle.replaceFeatures(graphics);
      await app.view.goTo(polygons[0].geometry.extent.expand(1.15), { duration: 700 });
      if (current !== sequence) return;
      writeStatus(`Coverage ready — ${graphics.length} 10-minute service-area polygon${graphics.length === 1 ? "" : "s"}.`);
    } catch (error) { if (current !== sequence) return; resultHandle.clear(); writeStatus(`Coverage failed: ${String(error?.message || error)}`); }
  }
  async function searchStations() {
    const term = search.value.trim(); const current = ++sequence; results.replaceChildren();
    if (!term) { writeStatus("Enter a precinct, station name, address, or borough to search."); return; }
    writeStatus("Searching stations…");
    try {
      await layer.load(); const query = layer.createQuery(); const safe = term.replace(/'/g, "''").toUpperCase();
      query.where = `UPPER(FACNAME) LIKE '%${safe}%' OR UPPER(ADDRESS) LIKE '%${safe}%' OR UPPER(CITY) LIKE '%${safe}%' OR UPPER(BORO) LIKE '%${safe}%'`; query.outFields = ["OBJECTID", "FACNAME", "ADDRESS", "CITY", "BORO", "FACTYPE"]; query.returnGeometry = true; query.num = 20;
      const response = await layer.queryFeatures(query); if (current !== sequence) return; const features = response.features || [];
      if (!features.length) { writeStatus("No matching station locations found."); return; }
      const fragment = document.createDocumentFragment();
      for (const feature of features) { const button = document.createElement("button"); button.type = "button"; const name = String(feature.attributes?.FACNAME || "Police station"); const address = [feature.attributes?.ADDRESS, feature.attributes?.CITY, feature.attributes?.BORO].filter(Boolean).join(" · "); button.textContent = address ? `${name} — ${address}` : name; button.title = "Generate a 10-minute service area for this station"; button.style.textAlign = "left"; button.style.padding = "8px"; button.style.cursor = "pointer"; button.addEventListener("click", () => runCoverage(feature)); fragment.append(button); }
      results.replaceChildren(fragment); writeStatus(`${features.length} matching station${features.length === 1 ? "" : "s"}. Choose one to generate coverage.`);
    } catch (error) { if (current === sequence) writeStatus(`Station search failed: ${String(error?.message || error)}`); }
  }
  const onSearchInput = () => { clearTimeout(debounceTimer); debounceTimer = setTimeout(searchStations, 250); };
  const onClear = () => { ++sequence; resultHandle.clear(); selected.style.display = "none"; clearButton.style.display = "none"; writeStatus("Coverage cleared. Select another police station."); };
  search.addEventListener("input", onSearchInput); clearButton.addEventListener("click", onClear);
  app.actions.register("generate-coverage", async ({ graphic }) => runCoverage(graphic));
  app.onCleanup(() => { clearTimeout(debounceTimer); search.removeEventListener("input", onSearchInput); clearButton.removeEventListener("click", onClear); root.replaceChildren(); });
  return { stationLayerId: layer.id, serviceAreaLayerId: resultHandle.layer.id, travelMode: "Driving Time", breakMinutes: 10 };
}