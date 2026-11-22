# Research

Experiments, original evaluation code, fixtures, plots and archived results live here, separately from **production architecture** and **accepted plans**. The files have been moved from the repository-root `research/` directory without discarding their input data or figures.

- [Road-surface reconstruction](./road-surface-reconstruction/README.md) — independent Dutch BGT/Shapely reconstruction experiment, **closed / not adopted**. Includes Python research scripts, development/holdout data, figures and evaluation outputs.
- [Surface-first road rendering](./surface-first-road-rendering/README.md) — evaluation datasets and reproducible E2+ baseline evidence supporting the adopted road-rendering architecture.

**Working from repository root:** the Python examples and Node benchmark scripts use `docs/research/...` paths now. Python scripts that locate resources relative to `__file__` continue to work after the move. If an older ticket or external script cites `research/...`, update that path.

For the current E2+ specification see [architecture](../architecture/e2-plus-surface-first-road-rendering.md); for the decision see [ADR-0010](../decisions/ADR-0010-surface-first-road-rendering.md).
