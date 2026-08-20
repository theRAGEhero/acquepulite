# Official hydrography imports

Place WGS84 GeoJSON line datasets here and register them in `manifest.json`.
Recommended priorities: regional topographic networks `300`, WISE/WFD 2022
`200`, EU-Hydro `100`.

Download the official Italian WISE/WFD 2022 river lines directly from EEA:

```powershell
npm run hydro:wise
```

The downloader paginates all records, validates the expected count, records
the dataset version and SHA-256 checksum, and atomically updates the manifest.

```json
{
  "datasets": [{
    "id": "wise-wfd-2022-it",
    "title": "WISE WFD 2022 SurfaceWaterBodyLine",
    "version": "2022-v1.7",
    "license": "EEA standard re-use policy / CC BY 4.0",
    "priority": 200,
    "file": "wise-wfd-2022-it.geojson",
    "code_fields": ["thematicIdIdentifier", "inspireIdLocalId", "euSurfaceWaterBodyCode", "waterBodyIdentifier"],
    "name_fields": ["waterBodyName", "nameText"],
    "feature_id_fields": ["inspireId", "euSurfaceWaterBodyCode"]
  }]
}
```

Only `LineString` and `MultiLineString` features are accepted. Convert source
GeoPackages with GDAL and EPSG:4326 before registering them. Never join source
features merely because endpoints look close.
