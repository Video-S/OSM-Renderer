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

Other benchmark datasets and raw harness code remain in the repository's top-level `benchmarks/` directory because they are used by executable tooling. The writers for the M2.1 and M2.2 reports now output to this directory.
