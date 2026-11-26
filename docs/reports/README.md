# Benchmarks and Reports

Preserved measurement artifacts and their accompanying reports. Read each report's environment and methodology; results from different hardware and datasets are not automatically comparable.

| Report | Evidence |
| --- | --- |
| [M2.1 railway prototype](./m2-1-railway-prototype-report.md) | [Baseline JSON](./m2-1-baseline-data.json) |
| M2.2 production benchmarking | [Results JSON](./m2-2-production-benchmarks.json) |
| [TKT-019 Hengelo scaling](./tkt019-hengelo-scaling-report.md) | Regional scalability work |
| [TKT-020 road/planar scaling](./tkt020-hengelo-scaling-report.md) | Geometry cost investigation |
| [TKT-028 1,024 m tile experiment](./tkt028-1024m-tile-size-experiment.md) | Tile-size comparison |
| [TKT-028 streaming performance](./tkt028-m2b-streaming-performance-report.md) | Streaming hardware/memory measurements |
| [TKT-034 full-Twente baseline](./tkt034-full-twente-baseline.md) | Completed 120-shard / 1,920-tile bake & integrity baseline |
| [TKT-036 runtime foliage LOD](./tkt036-foliage-lod-optimization.md) | Runtime foliage canopy LOD, trunk suppression & frustum culling evaluation |
| [TKT-037 spatial batching feasibility](./tkt037-spatial-batching-feasibility.md) | Offline `1,024 m → 2,048 m / 4,096 m` tile consolidation & benchmark plan |
| [TKT-038 instanced feature picking](./tkt038-instanced-feature-picking.md) | Spatially accelerated instanced picking (`InstancedSpatialIndex`) & multi-mosaic benchmark plan |
| [TKT-039 streaming fluidity profiling](./tkt039-streaming-fluidity-profiling.md) | Camera-movement & streaming frame-time profiling instrumentation & benchmark plan |
| [TKT-040 non-blocking tile preparation](./tkt040-non-blocking-tile-preparation.md) | Compact zero-copy worker transfer, worker-side instanced BVH & main-thread tile prep evaluation |

Other benchmark datasets and raw harness code remain in the repository's top-level `benchmarks/` directory because they are used by executable tooling. The writers for the M2.1 and M2.2 reports now output to this directory.
