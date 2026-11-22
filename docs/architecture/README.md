# Architecture and Rendering

Current implementation references. Read [overview](./overview.md) first; for the reason behind a decision use the [ADRs](../decisions/README.md).

- [System architecture](./overview.md): live/local versus baked tiled paths, runtime streaming, ownership and limitations
- [OSM data pipeline and feature support](./data-pipeline-and-feature-support.md): ingestion, classification and diagnostics
- [Geometry and rendering](./geometry-and-rendering.md): mesh, surface and elevation rules
- [E2+ surface-first road rendering](./e2-plus-surface-first-road-rendering.md): current production road surface pipeline
- [Camera and world coordinates](./camera-and-world-coordinates.md): projection, orthographic framing and navigation
- [Offline Overijssel OSM source](./offline-overijssel-osm-dataset.md): immutable source, SQLite index, checksum and setup

For current acceptance and pending regional work see [STATUS.md](../STATUS.md). For testing procedures see [Guides](../guides/README.md).
