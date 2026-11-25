# Future concept — Persistent regional simulation

**Recorded:** 2026-11-25  
**Status:** Deferred design proposal; not implemented or scheduled.  
**Context:** The original downstream goal is a large-scale, Atom Zombie Smasher-inspired game using real-world geography. The current product remains the map renderer and navigation system.

## Intent

Agents and events should be able to exist, move and interact anywhere in the supported geographic region, even when the client has no rendering tiles loaded there. For example, an infection could spread in Enschede while a player defends Hengelo; a horde could form, travel through the road network and arrive later without having been rendered along the way.

“Offscreen” or “offline” tiles in this proposal mean areas outside the client's rendered/loaded coverage, not necessarily a disconnected server or simulation that continues while the server is shut down.

## Architectural direction

- Keep authoritative gameplay state independent of rendering meshes, tile lifecycles and visual LOD. Rendering tile eviction, consolidation, or resolution changes must not destroy agents or interrupt events.
- A future server-side simulation may own regional state, advance its clock, process offscreen areas and publish relevant state to clients. The client visualizes the appropriate subset. Server authority is a preferred direction for exploration, not a commitment to multiplayer or a particular networking architecture.
- Use a stable geographic coordinate system and entity identifiers shared with the geographic source data. Simulation partitions need not match rendering tile sizes or boundaries.
- Maintain simulation-specific geographic data in memory or an accessible indexed store, rather than requiring decoded render geometry. Existing offline OSM ingestion and baking are useful foundations; a simulation-specific bake is future work.

## Potential simulation fidelity levels

| State | Possible representation |
| --- | --- |
| Detailed | Individual agents, movement, local avoidance, combat and interactions. |
| Reduced frequency | Individual agents or groups with less frequent updates and cheaper navigation. |
| Regional / aggregate | Population counts, travelling hordes, infection spread, resource consumption and scheduled events. |
| Dormant | Persisted state with scheduled events or analytical progression when relevant. |

These are candidate approaches, not required implementation levels. Simulation activity should be determined by gameplay relevance, not solely camera visibility. Offscreen areas may need full simulation when their interactions matter. Transitions must preserve causally relevant state, population totals, identities where needed, and movement/event continuity. Persistence and catch-up semantics after server downtime remain open decisions.

## Geographic inputs and navigation

Potential offline-derived assets include road/pedestrian graphs, building footprints and entrances, traversability grids, obstacle and barrier information, connectivity across partitions, and strategic points of interest. Respect grade separation, bridges and tunnels rather than assuming every intersecting line is connected. Population and occupancy estimates may require additional datasets or explicit gameplay assumptions; OSM alone does not provide reliable population/occupancy values.

Investigate shared flow fields or hierarchical graph routing for large crowds, rather than independent pathfinding for every zombie. Compact agent state (e.g. typed arrays) and spatially indexed interaction queries are possible implementation techniques. A million hypothetical agents at 64 bytes each would require about 61 MiB for that state alone; navigation, indices, persistence and computation are additional costs. This is illustrative, not a capacity benchmark.

## Future feasibility work

When gameplay work is explicitly authorized, prototype headless regional simulation on synthetic geography before using the full real-world dataset. Evaluate agent update throughput, routing and interaction cost, memory, cross-partition migration, event ordering, fidelity transitions, persistence, and client synchronization. Choose update rates, partition sizes, simulation algorithms and server technology from measurements and gameplay requirements.

## Scope guard

Do not implement gameplay, simulation infrastructure, new baking pipelines, multiplayer, or simulation LOD as part of current renderer optimization. No new active ticket or acceptance gate is implied by this proposal. The existing renderer roadmap and performance/visual verification remain unchanged. Keep the renderer's tile lifecycle independent of any eventual gameplay state.
